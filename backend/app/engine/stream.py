"""STREAM - the engine run continuously over the three live signal streams.

The batch pipeline (pipeline.run) answers "what incidents are in this pile of
signals?". A live stream needs a different shape: signals keep arriving, an
incident keeps accumulating evidence after it is drafted, and silence must not
produce anything. StreamEngine processes arrivals in small micro-batches:

  1. redact (already done by the parsers) -> deduplicate the batch -> detect,
     with the detector state (baselines, template miner) carried across batches
  2. every anomalous signal first tries to join an OPEN incident, through the
     same structural gate the correlator uses (lifecycle.attach_late_signal)
  3. the rest wait in a pending pool; the pool is correlated into candidates,
     candidates are validated (validate.py), and accepted ones are scored,
     drafted and put in the review queue
  4. pending signals that find no structural partner within the correlation
     window expire as noise; nothing is ever raised from a lone signal or from
     a quiet stream

Clock. Correlation compares event times. Logs and CloudWatch carry them;
Grafana alerts do not, so a Grafana alert is stamped with the stream clock:
the latest event time seen, advanced by the wall-clock time since then.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

from . import causal as causal_mod
from . import validate as validate_mod
from .correlate import DependencyGraph, correlate, near_misses
from .dedup import deduplicate
from .detect import DetectorState, detect
from .drafting import ExcludedSignal, build_draft
from .lifecycle import attach_late_signal
from .nexus import _CANONICAL_SOURCE, to_canonical
from .pipeline import IncidentResult, PipelineReport, PipelineResult
from .review import ReviewQueue
from .severity import score_incident
from .signal import Signal, SignalSource

PENDING_WINDOW_MIN = 15.0      # matches correlate.WINDOW_MAX_MIN
DEDUP_BUCKET_MIN = 5.0         # same fingerprint within this long is one condition
TIMELINE_MINUTES = 180         # per-minute history kept for the charts
REPEAT_TRACKED = 2000          # distinct conditions tracked for the dedup view
CANONICAL_HISTORY = 5000       # recent canonical records kept for the feed


class StreamEngine:
    def __init__(
        self,
        graph: DependencyGraph,
        criticality: dict[str, float] | None = None,
        queue: ReviewQueue | None = None,
        on_new_incident: Callable[[IncidentResult], None] | None = None,
    ) -> None:
        self.graph = graph
        self.criticality = criticality
        self.queue = queue or ReviewQueue()
        self.report = PipelineReport()
        self.result = PipelineResult(
            incidents=[], noise=[], signals=[], report=self.report,
            queue=self.queue, detector_state=DetectorState(),
        )
        self.on_new_incident = on_new_incident
        self.pending: list[Signal] = []
        self.canonical: deque[dict[str, Any]] = deque(maxlen=CANONICAL_HISTORY)
        self.rejections: deque[dict[str, Any]] = deque(maxlen=200)
        self._rejected_keys: set[frozenset] = set()
        self._inbox: list[Signal] = []
        self._inbox_lock = threading.Lock()
        self.by_source: dict[str, int] = {}
        self.anomalous = 0
        self.ticks = 0
        self._clock_event: datetime | None = None
        self._clock_wall: float | None = None
        self.last_signal_wall: float | None = None
        # drafts created or changed since the narrator last looked
        self.touched: set[str] = set()
        # Metrics for the dashboard: per-minute volume by stream (event time),
        # anomaly-score histogram, and the conditions that repeat most.
        self.timeline: dict[str, dict[str, int]] = {}
        self.score_hist = [0] * 10
        self.repeats: dict[str, dict[str, Any]] = {}
        self.dedup_in = 0           # signals seen after parsing
        self.dedup_out = 0          # ...that stayed distinct

    # -- clock --------------------------------------------------------------

    def observe_event_time(self, ts: datetime) -> None:
        if self._clock_event is None or ts > self._clock_event:
            self._clock_event = ts
            self._clock_wall = time.time()

    def now(self) -> datetime:
        """The stream clock: latest event time seen, advanced by wall time since."""
        if self._clock_event is None or self._clock_wall is None:
            return datetime.now(timezone.utc)
        return self._clock_event + timedelta(seconds=time.time() - self._clock_wall)

    # -- intake -------------------------------------------------------------

    def offer(self, signal: Signal) -> None:
        """Queue one parsed, redacted signal. Thread-safe; processed on tick().

        Logs and CloudWatch carry their own event time and advance the clock;
        Grafana alerts are stamped *from* it (see from_grafana's received_at).
        """
        if signal.source != SignalSource.GRAFANA_ALERT:
            self.observe_event_time(signal.timestamp)
        with self._inbox_lock:
            self._inbox.append(signal)
        self.last_signal_wall = time.time()

    def inbox_size(self) -> int:
        with self._inbox_lock:
            return len(self._inbox)

    # -- processing -----------------------------------------------------------

    def tick(self) -> dict[str, Any]:
        """Process everything queued since the last tick. Call under the engine lock."""
        with self._inbox_lock:
            batch, self._inbox = self._inbox, []
        self.ticks += 1
        summary: dict[str, Any] = {"received": len(batch), "attached": 0, "new_incidents": 0, "expired": 0}

        if batch:
            batch.sort(key=lambda s: s.timestamp)
            self.report.signals_ingested += len(batch)
            for s in batch:
                raw = str(getattr(s.source, "value", s.source))
                src = _CANONICAL_SOURCE.get(raw, raw)
                self.by_source[src] = self.by_source.get(src, 0) + 1
                self._record_volume(s, src)
                for kind in s.redacted_fields:
                    self.report.redaction_counts[kind] = self.report.redaction_counts.get(kind, 0) + 1

            batch, dedup_report = deduplicate(batch)
            self.report.unique_signals += dedup_report.unique_signals
            self.report.dedup_collapsed += dedup_report.collapsed
            self.dedup_in += dedup_report.raw_signals
            self.dedup_out += dedup_report.unique_signals
            batch, detection, self.result.detector_state = detect(batch, self.result.detector_state)

            for s in batch:
                self.canonical.append(to_canonical(s))
                self.result.signals.append(s)
                self._record_score(s)
                if not s.is_anomaly:
                    self.report.within_baseline += 1
                    continue
                self.anomalous += 1
                self.report.anomalies_detected += 1
                outcome = attach_late_signal(
                    self.result, self.graph, self.queue, s,
                    criticality=self.criticality, record=False,
                )
                if outcome["attached"]:
                    summary["attached"] += 1
                    self.touched.add(outcome["draft_id"])
                elif self._absorb_repeat(s):
                    summary["repeats"] = summary.get("repeats", 0) + 1
                else:
                    self.pending.append(s)

        summary["new_incidents"] = self._form_incidents()
        summary["expired"] = self._expire_pending()
        return summary

    # -- metrics --------------------------------------------------------------

    def _record_volume(self, s: Signal, src: str) -> None:
        minute = s.timestamp.replace(second=0, microsecond=0).isoformat()
        row = self.timeline.setdefault(minute, {})
        row[src] = row.get(src, 0) + 1
        if len(self.timeline) > TIMELINE_MINUTES:
            for k in sorted(self.timeline)[: len(self.timeline) - TIMELINE_MINUTES]:
                del self.timeline[k]

    def _record_score(self, s: Signal) -> None:
        self.score_hist[min(9, int(max(0.0, s.anomaly_score) * 10))] += 1
        if not s.is_anomaly:
            return
        minute = s.timestamp.replace(second=0, microsecond=0).isoformat()
        row = self.timeline.setdefault(minute, {})
        row["anomalous"] = row.get("anomalous", 0) + 1

    def _track_repeat(self, s: Signal, extra: int) -> None:
        key = s.context_key
        rec = self.repeats.get(key)
        if rec is None:
            if len(self.repeats) >= REPEAT_TRACKED:
                oldest = min(self.repeats, key=lambda k: self.repeats[k]["last"])
                del self.repeats[oldest]
            rec = self.repeats[key] = {
                "service": s.service, "component": s.component,
                "source": _CANONICAL_SOURCE.get(str(getattr(s.source, "value", s.source)),
                                                str(getattr(s.source, "value", s.source))),
                "evidence": (s.message or s.metric or "")[:120],
                "count": 0, "first": s.timestamp.isoformat(), "last": s.timestamp.isoformat(),
            }
        rec["count"] += extra
        rec["last"] = max(rec["last"], s.timestamp.isoformat())

    def _absorb_repeat(self, s: Signal) -> bool:
        """Same condition seen again while it is still pending: count it instead
        of adding a second signal. Collapsing keeps the earliest, which
        preserves onset time for the causal step."""
        window = timedelta(minutes=DEDUP_BUCKET_MIN)
        for p in self.pending:
            if p.context_key == s.context_key and abs(s.timestamp - p.timestamp) <= window:
                p.occurrence_count += s.occurrence_count
                p.anomaly_score = max(p.anomaly_score, s.anomaly_score)
                self.report.dedup_collapsed += s.occurrence_count
                self.dedup_out -= 1
                self._track_repeat(s, s.occurrence_count)
                return True
        self._track_repeat(s, s.occurrence_count)
        return False

    def metrics(self) -> dict[str, Any]:
        top = sorted(self.repeats.values(), key=lambda r: -r["count"])[:15]
        received = self.dedup_in
        distinct = max(self.dedup_out, 0)
        collapsed = max(received - distinct, 0)
        prio: dict[str, int] = {}
        for inc in self.result.incidents:
            prio[inc.severity.priority] = prio.get(inc.severity.priority, 0) + 1
        return {
            "timeline": [{"minute": m, **self.timeline[m]} for m in sorted(self.timeline)],
            "score_histogram": [{"lo": i / 10, "hi": (i + 1) / 10, "count": c}
                                for i, c in enumerate(self.score_hist)],
            "dedup": {"received": received, "distinct": distinct, "collapsed": collapsed,
                      "collapsed_pct": round(100.0 * collapsed / received, 1) if received else 0.0,
                      "bucket_minutes": DEDUP_BUCKET_MIN},
            "top_repeats": top,
            "priorities": prio,
        }

    def _form_incidents(self) -> int:
        if len(self.pending) < 2:
            return 0
        clusters, _noise, corr = correlate(self.pending, self.graph)
        self.report.possible_pairs = corr.possible_pairs
        self.report.candidate_pairs = corr.candidate_pairs
        if not clusters:
            return 0
        clusters, splits = causal_mod.refine_clusters(clusters, self.graph)
        self.report.causal_splits.extend(splits)
        verdict = validate_mod.validate(clusters, self.graph)

        for rejected, checks in verdict.rejected:
            key = frozenset(s.id for s in rejected.signals)
            if key not in self._rejected_keys:
                self._rejected_keys.add(key)
                self.rejections.append({
                    "at": self.now().isoformat(), "services": rejected.services,
                    "signals": len(rejected.signals),
                    "failed": [c.as_dict() for c in checks if not c.passed],
                })

        formed = 0
        for cluster in verdict.accepted:
            cluster.cluster_id = len(self.result.incidents)
            analysed = causal_mod.analyse(cluster, self.graph)
            severity = score_incident(cluster, analysed, self.graph, None, self.criticality)
            excluded = [
                ExcludedSignal(service=s.service, at=s.timestamp,
                               detail=(s.metric or s.message or "")[:70], reason=reason)
                for s, reason in near_misses(cluster, self.result.noise, self.graph)
            ]
            # Template draft now, so the incident reaches review immediately; the
            # Claude narrative is added asynchronously (see on_new_incident).
            draft = build_draft(cluster, analysed, severity, excluded, use_llm=False)
            incident = IncidentResult(cluster, analysed, severity, draft)
            self.result.incidents.append(incident)
            self.queue.submit(draft)
            members = {s.id for s in cluster.signals}
            self.pending = [s for s in self.pending if s.id not in members]
            self.report.incidents_formed += 1
            self.report.drafts_created += 1
            self.report.priorities[severity.priority] = self.report.priorities.get(severity.priority, 0) + 1
            if analysed.root_cause_service:
                self.report.root_causes_identified += 1
            formed += 1
            self.touched.add(draft.draft_id)
            if self.on_new_incident:
                self.on_new_incident(incident)
        return formed

    def _expire_pending(self) -> int:
        horizon = self.now() - timedelta(minutes=PENDING_WINDOW_MIN)
        keep, expired = [], []
        for s in self.pending:
            (expired if s.timestamp < horizon else keep).append(s)
        if expired:
            self.pending = keep
            self.result.noise.extend(expired)
            self.report.noise_signals += len(expired)
        return len(expired)

    # -- status ---------------------------------------------------------------

    def status(self) -> dict[str, Any]:
        return {
            "signals_received": self.report.signals_ingested,
            "by_source": dict(self.by_source),
            "anomalous": self.anomalous,
            "pending": len(self.pending),
            "incidents": len(self.result.incidents),
            "noise": len(self.result.noise),
            "validation_rejections": len(self.rejections),
            "ticks": self.ticks,
            "stream_clock": self.now().isoformat() if self._clock_event else None,
            "last_signal_seconds_ago": (round(time.time() - self.last_signal_wall, 1)
                                        if self.last_signal_wall else None),
        }
