"""HTTP surface for the AIOps engine — the Hours 18-24 gap.

The engine itself (app/engine/) has been real, tested code since Phase 1:
adapters, detection, correlation, the causal engine, severity scoring, and a
review gate proven against 192 measured scenarios. Nothing in that engine
changes here. This module only exposes it over HTTP so it can actually be
demoed — a scenario run, a review queue a reviewer can click through, and the
same approve/reject/merge gate the engine already enforces internally.

State is process-local and in-memory, mirroring the pattern the rest of this
app already uses for pipeline state (see `_state` in main.py) — appropriate
for a single-process demo, not a claim about production durability.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Body, HTTPException
from pydantic import BaseModel

from . import db, security, summarizer
from .engine import adapters, benchmark as benchmark_mod, scenarios
from .engine.evidence import build_evidence
from .engine import feedback as feedback_mod
from .engine.golden import flapping_scenario, golden_scenario, maintenance_windows
from .engine.lifecycle import attach_late_signal
from .engine import notifications as notifications_mod
from .engine.causal import CausalResult
from .engine.correlate import Cluster, DependencyGraph
from .engine.drafting import IncidentDraft
from .engine.pipeline import Evaluation, PipelineResult, run as run_pipeline
from .engine.review import DraftStatus, QueueItem, ReviewQueue
from .engine.severity import SeverityBreakdown

router = APIRouter(prefix="/engine", tags=["engine"])
# Generated scenarios and push receivers. The challenge allows the three Nexus
# streams as the only input, so these are mounted only when AIOPS_OFFLINE_DEMO=1
# (tests, the benchmark, offline development). See main.py.
offline_router = APIRouter(prefix="/engine", tags=["engine-offline"])

# One lock for everything that reads or mutates engine state: the stream ticker
# takes it for each micro-batch, reviewer actions take it too.
_LOCK = threading.RLock()
_live = None   # live.LiveRuntime once start_live() has run

# Upper bound on signals accepted from a single pushed payload. Generous next to
# the golden scenario's 18, deliberately far below what would stall correlation.
MAX_INGEST_SIGNALS = 5_000

# --------------------------------------------------------------------------
# persistence: an event log that is replayed on startup
# --------------------------------------------------------------------------
#
# The engine run lives in memory, so a restart used to wipe the incident
# mid-demo. Every route that changes state is recorded here, and because the
# scenarios are deterministic, replaying the log rebuilds the same incidents,
# decisions and Jira keys. Off by default (tests, scripts); main.py turns it on.

_PERSIST = False
_REPLAYING = False
_REGISTRY: dict[str, tuple] = {}   # kind -> (function, {param: pydantic model})


def enable_persistence() -> None:
    global _PERSIST
    _PERSIST = True


def _jsonable(value):
    return value.model_dump() if hasattr(value, "model_dump") else value


def _recorded(kind: str, models: dict | None = None, starts_run=None):
    """Record a successful call so restore_from_log can replay it.

    `starts_run` is True, or a function of the result, when this call replaces
    the whole run (so earlier events are obsolete and the log restarts).
    """
    models = models or {}

    def deco(fn):
        import functools
        import inspect

        _REGISTRY[kind] = (fn, models)
        sig = inspect.signature(fn)

        @functools.wraps(fn)
        def wrapper(*args, **kwargs):
            out = fn(*args, **kwargs)
            if _PERSIST and not _REPLAYING:
                try:
                    bound = sig.bind(*args, **kwargs)
                    payload = {k: _jsonable(v) for k, v in bound.arguments.items()}
                    fresh = starts_run(out) if callable(starts_run) else bool(starts_run)
                    if fresh:
                        db.engine_events_clear()
                    db.engine_event_add(kind, payload)
                except Exception:
                    pass  # persistence must never break a request
            return out

        return wrapper

    return deco


def restore_from_log() -> int:
    """Replay the event log into memory. Returns how many events were applied.

    Paging is suppressed for the duration: every P1 in the log already paged
    a human once, in the run that got logged - replaying it must rebuild
    state, not re-page for an incident someone may have already handled.
    """
    global _REPLAYING
    applied = 0
    _REPLAYING = True
    notifications_mod.set_suppressed(True)
    try:
        for event in db.engine_events_load():
            entry = _REGISTRY.get(event["kind"])
            if entry is None:
                break
            fn, models = entry
            kwargs = {k: (models[k](**v) if k in models else v) for k, v in event["payload"].items()}
            try:
                fn(**kwargs)
            except Exception:
                break   # a stale or incompatible log must not stop startup
            applied += 1
    finally:
        _REPLAYING = False
        notifications_mod.set_suppressed(False)
    return applied


def seed_golden_quietly() -> None:
    """Run the golden scenario at startup without paging anyone."""
    notifications_mod.set_suppressed(True)
    try:
        golden()
    finally:
        notifications_mod.set_suppressed(False)


@dataclass
class _EngineState:
    result: PipelineResult | None = None
    evaluation: Evaluation | None = None
    queue: ReviewQueue = field(default_factory=ReviewQueue)
    scenario_desc: str = ""
    graph: DependencyGraph | None = None
    criticality: dict[str, float] | None = None


_state = _EngineState()


# --------------------------------------------------------------------------
# request bodies
# --------------------------------------------------------------------------


class DemoRunRequest(BaseModel):
    n_incidents: int = 3
    noise_signals: int = 40
    seed: int = 7
    stagger_minutes: float = 45.0
    topology: str | None = None  # ecommerce | media | fintech | iot | None (random)
    use_llm: bool = False


class ApproveRequest(BaseModel):
    actor: str
    edits: dict[str, Any] | None = None


class RejectRequest(BaseModel):
    actor: str
    note: str = ""


class MergeRequest(BaseModel):
    actor: str
    into: str
    note: str = ""


# --------------------------------------------------------------------------
# serialization — deliberately explicit rather than auto-serializing the
# internal dataclasses, so the API surface is a chosen contract, not an
# accident of internal structure.
# --------------------------------------------------------------------------


def _queue_summary(item: QueueItem) -> dict:
    draft = item.draft
    return {
        "draft_id": draft.draft_id,
        "title": draft.title,
        "priority": draft.priority,
        "severity_score": draft.severity_score,
        "correlation_confidence": draft.correlation_confidence,
        "causal_confidence": draft.causal_confidence,
        "root_cause_service": draft.root_cause_service,
        "affected_services": draft.affected_services,
        "signal_count": draft.signal_count,
        "started_at": draft.started_at.isoformat(),
        "status": item.status.value,
        "jira_key": item.jira_key,
        "merged_into": item.merged_into,
        "reviewer": item.reviewer,
        "suppressed": draft.suppressed,
        "summary_source": draft.summary_source,
    }


def _draft_detail(item: QueueItem) -> dict:
    draft = item.draft
    return {
        **_queue_summary(item),
        "severity_line": draft.severity_line,
        "root_cause_detail": draft.root_cause_detail,
        "summary": draft.summary,
        "investigation_steps": draft.investigation_steps,
        "causal_reasoning": draft.causal_reasoning,
        "severity_factors": draft.severity_factors,
        "redaction_kinds": draft.redaction_kinds,
        "timeline": [
            {
                "at": e.at.isoformat(),
                "source": e.source,
                "service": e.service,
                "detail": e.detail,
                "count": e.count,
            }
            for e in draft.timeline
        ],
        "considered_excluded": [
            {
                "service": x.service,
                "at": x.at.isoformat(),
                "detail": x.detail,
                "reason": x.reason,
            }
            for x in draft.considered_excluded
        ],
        "jira_fields": draft.to_jira_fields() if item.status == DraftStatus.PUBLISHED else None,
        "note": item.note,
        "decided_at": item.decided_at.isoformat() if item.decided_at else None,
        "historical_match": draft.historical_match,
        "suppression_reason": draft.suppression_reason,
        "lifecycle": item.lifecycle,
        "history": item.history,
        "jira_comments": item.jira_comments,
        "updates": item.updates,
    }


def _report_dict() -> dict:
    if _state.result is None:
        return {}
    r = _state.result.report
    out = {
        "scenario": _state.scenario_desc,
        "signals_ingested": r.signals_ingested,
        "redaction_counts": r.redaction_counts,
        "redaction_backends": r.redaction_backends,
        "unique_signals": r.unique_signals,
        "dedup_collapsed": r.dedup_collapsed,
        "dedup_collapsed_pct": r.dedup_collapsed_pct,
        "dedup_bucket_minutes": r.dedup_bucket_minutes,
        "anomalies_detected": r.anomalies_detected,
        "within_baseline": r.within_baseline,
        "incidents_formed": r.incidents_formed,
        "noise_signals": r.noise_signals,
        "root_causes_identified": r.root_causes_identified,
        "drafts_created": r.drafts_created,
        "auto_published": r.auto_published,
        "priorities": r.priorities,
        "noise_reduction_pct": r.noise_reduction_pct,
        "possible_pairs": r.possible_pairs,
        "candidate_pairs": r.candidate_pairs,
        "blocking_saved_pct": r.blocking_saved_pct,
        "calibration_warning": r.calibration_warning,
        "elapsed_ms": r.elapsed_ms,
        "causal_splits": r.causal_splits,
        "validation_rejections": (len(_live.engine.rejections) if _live is not None
                                  else len(r.validation_rejections)),
        "live": _live is not None,
    }
    if _state.evaluation is not None:
        ev = _state.evaluation
        out["evaluation"] = {
            # The denominators behind the ratios below: a 1.000 over 15 pairs
            # and a 1.000 over 15,000 are not the same claim, so the UI shows both.
            "true_pairs": ev.true_pairs,
            "predicted_pairs": ev.predicted_pairs,
            "correct_pairs": ev.correct_pairs,
            "pair_precision": ev.pair_precision,
            "pair_recall": ev.pair_recall,
            "pair_f1": ev.pair_f1,
            "cluster_purity": ev.cluster_purity,
            "incidents_expected": ev.incidents_expected,
            "incidents_formed": ev.incidents_formed,
            "root_cause_correct": ev.root_cause_correct,
            "root_cause_total": ev.root_cause_total,
            "root_cause_accuracy": ev.root_cause_accuracy,
            "noise_precision": ev.noise_precision,
        }
    return out


# --------------------------------------------------------------------------
# routes
# --------------------------------------------------------------------------


@offline_router.post("/demo/run")
@_recorded("demo_run", {"body": DemoRunRequest}, starts_run=True)
def demo_run(body: DemoRunRequest) -> dict:
    """Generate a fault-injected scenario and run the full pipeline on it.

    This is the one entry point that seeds a fresh in-memory state — every
    other route below reads or acts on whatever this last produced. A second
    call replaces the queue and audit history, same as /demo/load does for
    the original AlertLens pipeline.
    """
    sc = scenarios.generate(
        n_incidents=body.n_incidents,
        noise_signals=body.noise_signals,
        seed=body.seed,
        stagger_minutes=body.stagger_minutes,
        topology=body.topology,
    )
    return _execute(sc, use_llm=body.use_llm)


def _execute(sc: "scenarios.Scenario", use_llm: bool = False, maintenance: list | None = None) -> dict:
    """Run a scenario through the real engine and make it the current state."""
    sigs = scenarios.build_signals(sc)
    graph = DependencyGraph(scenarios.dependency_edges(sc))

    queue = ReviewQueue()
    result = run_pipeline(
        sigs, graph, queue=queue, use_llm=use_llm,
        criticality=scenarios.criticality_map(sc), maintenance=maintenance,
    )

    _state.result = result
    _state.evaluation = None
    try:
        from .engine.pipeline import evaluate
        _state.evaluation = evaluate(result, sc.incident_count)
    except Exception:
        pass
    _state.queue = queue
    _state.graph = graph
    _state.criticality = scenarios.criticality_map(sc)
    _state.scenario_desc = sc.describe()

    return {"report": _report_dict(), "queue": [_queue_summary(i) for i in queue.pending()]}


@offline_router.post("/golden")
@_recorded("golden", starts_run=True)
def golden(use_llm: bool = False) -> dict:
    """The fixed demo failure: 17 signals -> 1 incident (+1 rejected decoy).

    Deterministic: the same call always produces the same incident, so a demo
    never depends on a random seed. Jira is NOT touched; the draft lands in the
    review queue awaiting a human.
    """
    return _run_named("golden", use_llm)


_SCENARIOS = {
    "golden": ("golden incident: connection-pool exhaustion on postgres-primary", golden_scenario, None),
    "maintenance": ("golden incident inside a declared maintenance window", golden_scenario, maintenance_windows),
    "flapping": ("flapping service: payment-svc CPU crossing its threshold 4 times", flapping_scenario, None),
}


def _run_named(name: str, use_llm: bool = False) -> dict:
    if name not in _SCENARIOS:
        raise HTTPException(404, f"unknown scenario {name!r}; choose from {sorted(_SCENARIOS)}")
    label, build, windows = _SCENARIOS[name]
    feedback_mod.reset()   # every demo scenario starts from the design weights
    out = _execute(build(), use_llm=use_llm, maintenance=windows() if windows else None)
    _state.scenario_desc = label
    out["report"] = _report_dict()
    return out


@offline_router.post("/scenario/{name}")
@_recorded("scenario", starts_run=True)
def run_scenario(name: str, use_llm: bool = False) -> dict:
    """Named, deterministic demo scenarios: golden | maintenance | flapping."""
    return _run_named(name, use_llm)


@router.get("/queue/{draft_id}/evidence")
def get_evidence(draft_id: str) -> dict:
    """Why this incident: per-signal join evidence, exclusions, root-cause
    candidates, severity and confidence breakdowns."""
    result = _state.result
    if result is None or _state.graph is None:
        raise HTTPException(404, "no run yet")
    for inc in result.incidents:
        if inc.draft.draft_id == draft_id:
            return build_evidence(inc, _state.graph, result.noise)
    raise HTTPException(404, f"no incident for draft {draft_id}")


@router.get("/report")
def get_report() -> dict:
    return _report_dict()


@router.get("/queue")
def get_queue(status: str | None = None) -> list[dict]:
    """List review-queue items, optionally filtered by status
    (awaiting_review | published | rejected | merged)."""
    items = list(_state.queue.items.values())
    if status:
        items = [i for i in items if i.status.value == status]
    items.sort(key=lambda i: i.draft.severity_score, reverse=True)
    return [_queue_summary(i) for i in items]


@router.get("/queue/{draft_id}")
def get_draft(draft_id: str) -> dict:
    item = _state.queue.items.get(draft_id)
    if item is None:
        raise HTTPException(404, f"no draft {draft_id}")
    return _draft_detail(item)


def _approve_unlocked(draft_id: str, body: ApproveRequest) -> dict:
    """The one path to Jira. See app/engine/review.py — this route is a
    thin wrapper; every guarantee (approval token, single-use, audit log)
    is enforced inside ReviewQueue.approve, not here."""
    try:
        item = _state.queue.approve(draft_id, body.actor, body.edits)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except Exception as e:  # ApprovalRequired and friends
        raise HTTPException(400, str(e))
    return _draft_detail(item)


class LateSignalRequest(BaseModel):
    kind: str = "matching"   # matching | unrelated


def _late_signal(inc, kind: str):
    """A demo late arrival, in CloudWatch's native shapes so it exercises the adapter."""
    from datetime import timedelta
    from .engine import adapters

    at = inc.cluster.end + timedelta(minutes=6)
    if kind == "unrelated":
        return adapters.from_cloudwatch_alarm({
            "AlarmName": "batch-report-CPUUtilization-alarm", "NewStateValue": "ALARM",
            "NewStateReason": "Threshold Crossed: 1 datapoint [93.0 (26/08/26 14:09:00)] was greater than the threshold (85.0).",
            "StateChangeTime": at.isoformat().replace("+00:00", "Z"), "Region": "ap-south-1",
            "Trigger": {"MetricName": "CPUUtilization", "Namespace": "AWS/ECS", "Threshold": 85.0,
                        "ComparisonOperator": "GreaterThanThreshold",
                        "Dimensions": [{"name": "ServiceName", "value": "batch-report"}]},
        })
    # matching: the failing dependency is still throwing the same errors, seen
    # on a service that calls it, so it passes the shared-context gate.
    victim = next((s.service for s in inc.cluster.signals if s.service != inc.causal.root_cause_service),
                  inc.causal.root_cause_service)
    root = inc.causal.root_cause_signal
    message = (root.message if root else "still failing")[:80]
    sigs = adapters.from_cloudwatch_logs({
        "logGroupName": f"/aws/ecs/{victim}",
        "events": [{"timestamp": int(at.timestamp() * 1000),
                    "message": f"ERROR still failing after recovery attempt: {message}",
                    "logStreamName": f"{victim}/task/late01"}],
    })
    return sigs[0] if sigs else None


@offline_router.post("/queue/{draft_id}/late-signal")
@_recorded("late_signal", {"body": LateSignalRequest})
def late_signal(draft_id: str, body: LateSignalRequest) -> dict:
    """Demo hook: a signal arrives after the incident was created."""
    result = _state.result
    if result is None or _state.graph is None:
        raise HTTPException(404, "no run yet")
    inc = next((i for i in result.incidents if i.draft.draft_id == draft_id), None)
    if inc is None:
        raise HTTPException(404, f"no incident for draft {draft_id}")
    sig = _late_signal(inc, body.kind)
    if sig is None:
        raise HTTPException(400, "could not build a late signal")
    try:
        outcome = attach_late_signal(result, _state.graph, _state.queue, sig,
                                     criticality=_state.criticality)
    except Exception as e:  # ApprovalRequired etc.
        raise HTTPException(400, str(e))
    return {**outcome, "item": _draft_detail(_state.queue.items[draft_id])}


class ResolveRequest(BaseModel):
    actor: str


def _resolve_unlocked(draft_id: str, body: ResolveRequest) -> dict:
    try:
        item = _state.queue.resolve(draft_id, body.actor)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(400, str(e))
    return _draft_detail(item)


def _reject_unlocked(draft_id: str, body: RejectRequest) -> dict:
    try:
        item = _state.queue.reject(draft_id, body.actor, body.note)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(400, str(e))
    _apply_feedback(item, "reject")
    return _draft_detail(item)


def _merge_unlocked(draft_id: str, body: MergeRequest) -> dict:
    try:
        item = _state.queue.merge(draft_id, body.into, body.actor, body.note)
    except KeyError as e:
        raise HTTPException(404, str(e))
    except Exception as e:
        raise HTTPException(400, str(e))
    _apply_feedback(item, "merge")
    return _draft_detail(item)


def _apply_feedback(item: QueueItem, action: str) -> None:
    adj = feedback_mod.apply_feedback(action, item.draft.affected_services)
    if adj and _state.queue.feedback:
        _state.queue.feedback[-1].adjustment = adj
        changed = ", ".join(
            f"{k} {adj['before'][k]:.2f}->{adj['after'][k]:.2f}"
            for k in adj["after"] if adj["before"][k] != adj["after"][k]
        )
        _state.queue._log("system", "weights_adjusted", item.draft.draft_id, f"{action}: {changed}")


@router.get("/feedback")
def get_feedback() -> dict:
    """What reviewers have taught the correlator so far, and the live weights."""
    return {
        "decisions": [
            {"draft_id": f.draft_id, "action": f.action, "services": f.services,
             "note": f.note, "adjustment": f.adjustment}
            for f in _state.queue.feedback
        ],
        "patterns": feedback_mod.current(),
    }


@router.post("/feedback/reset")
@_recorded("feedback_reset")
def reset_feedback() -> dict:
    feedback_mod.reset()
    return {"patterns": []}


# --------------------------------------------------------------------------
# live ingest (push receivers - read-only, nothing here writes outward)
# --------------------------------------------------------------------------


def _ingest(signals: list, edges: set | None = None) -> dict:
    """Route pushed telemetry: into the running system, or start a new batch.

    With a run in progress every signal goes through the same lifecycle router
    as a late arrival: it attaches to an open incident only if it passes the
    shared-context gate, otherwise it is parked as noise. With no run yet, the
    first push starts one.
    """
    if not signals:
        return {"received": 0, "mode": "empty"}

    # A webhook body is arbitrary client JSON, and one payload can normalize
    # into many signals. Correlation is superlinear in signal count, so an
    # uncapped push is a cheap way to make the engine expensive.
    security.require_items(signals, MAX_INGEST_SIGNALS, "signals")

    if _state.result is None or _state.graph is None:
        graph = DependencyGraph(edges or set())
        queue = ReviewQueue()
        result = run_pipeline(signals, graph, queue=queue, use_llm=False)
        _state.result, _state.graph, _state.queue = result, graph, queue
        _state.criticality, _state.evaluation = None, None
        _state.scenario_desc = "live ingest"
        return {"received": len(signals), "mode": "new_batch",
                "incidents": len(result.incidents), "noise": len(result.noise)}

    if edges:
        _state.graph.add_edges(edges)
    attached, parked, drafts = 0, 0, set()
    for sig in signals:
        out = attach_late_signal(_state.result, _state.graph, _state.queue, sig,
                                 criticality=_state.criticality)
        if out["attached"]:
            attached += 1
            drafts.add(out["draft_id"])
        else:
            parked += 1
    return {"received": len(signals), "mode": "attached", "attached": attached,
            "parked_as_noise": parked, "drafts": sorted(drafts)}


@offline_router.post("/ingest/grafana")
@_recorded("ingest_grafana", starts_run=lambda o: o.get("mode") == "new_batch")
def ingest_grafana(payload: dict) -> dict:
    """Grafana unified-alerting webhook (POST target for a contact point)."""
    return _ingest(adapters.from_grafana_webhook(payload))


@offline_router.post("/ingest/cloudwatch/alarm")
@_recorded("ingest_cloudwatch_alarm", starts_run=lambda o: o.get("mode") == "new_batch")
def ingest_cloudwatch_alarm(payload: dict) -> dict:
    """CloudWatch alarm state change (e.g. delivered via SNS -> HTTPS)."""
    sig = adapters.from_cloudwatch_alarm(payload)
    return _ingest([sig] if sig else [])


@offline_router.post("/ingest/otel/logs")
@_recorded("ingest_otel_logs", starts_run=lambda o: o.get("mode") == "new_batch")
def ingest_otel_logs(payload: dict) -> dict:
    """OTLP/JSON logs from an OpenTelemetry Collector."""
    return _ingest(adapters.from_otlp_logs(payload))


@offline_router.post("/ingest/otel/traces")
@_recorded("ingest_otel_traces", starts_run=lambda o: o.get("mode") == "new_batch")
def ingest_otel_traces(payload: dict) -> dict:
    """OTLP/JSON traces. Every span teaches the dependency graph an edge."""
    return _ingest(adapters.from_otlp_traces(payload), adapters.service_dependency_edges(payload))


@offline_router.post("/ingest/generic")
@_recorded("ingest_generic", starts_run=lambda o: o.get("mode") == "new_batch")
def ingest_generic(payload: Any = Body(...), fresh: bool = False) -> dict:
    """Fallback for an alert export that isn't CloudWatch/Grafana/OTel-shaped.

    Accepts a bare list of alert dicts, or an object wrapping them under
    `alerts`/`signals`/`records`/`data`/`events`, and best-effort-matches
    common field-name variants (see adapters.from_generic_records). This is
    the safety net for "we'll hand you a sample data file instead of a
    webhook" — whatever the file's exact schema, this endpoint still feeds
    the same real engine (dedup, detect, correlate, causal, severity, draft,
    review, Jira), not a separate toy path.

    `?fresh=true` starts a new run from this payload instead of routing it into
    the current one as late arrivals, which is what a whole file wants.
    """
    signals = adapters.from_generic_records(payload)
    if fresh and signals:
        _state.result = None
        _state.graph = None
    return _ingest(signals)


@router.get("/audit")
def get_audit() -> list[dict]:
    return [
        {
            "at": e.at.isoformat(), "actor": e.actor, "action": e.action,
            "draft_id": e.draft_id, "detail": e.detail,
        }
        for e in reversed(_state.queue.audit)
    ]


_STARTED_AT = datetime.now(timezone.utc)


@router.get("/health")
def health() -> dict:
    """Self-observability for the engine itself.

    An AIOps platform that watches everyone else's systems should be able to
    answer "are you actually working" about itself - queue depth, whether
    the last pipeline run is stale, and whether persistence, paging and the
    LLM path are for-real-configured or running on their safe mock/template
    fallback. Nothing here is fabricated: every field reflects an actual
    in-memory object, not a hardcoded "ok".
    """
    queue = _state.queue
    pending = queue.pending()
    p1_pending = sum(1 for i in pending if i.draft.priority == "P1")
    last_run = _state.result

    notif_transport = type(queue.notifications._transport).__name__
    jira_transport = type(queue.jira._transport).__name__

    now = datetime.now(timezone.utc)
    return {
        "status": "ok",
        "uptime_seconds": round((now - _STARTED_AT).total_seconds(), 1),
        "started_at": _STARTED_AT.isoformat(),
        "persistence_enabled": _PERSIST,
        "run_loaded": last_run is not None,
        "scenario": _state.scenario_desc,
        "queue": {
            "awaiting_review": len(pending),
            "awaiting_review_p1": p1_pending,
            "total_drafts": len(queue.items),
            "audit_entries": len(queue.audit),
        },
        "notifications": {
            "transport": notif_transport,
            "live": notif_transport != "MockNotificationTransport",
            "sent": len(queue.notifications.events),
            "recent": [
                {"at": e.at.isoformat(), "draft_id": e.draft_id, "reason": e.reason, "priority": e.priority}
                for e in queue.notifications.events[-5:]
            ],
        },
        "jira": {
            "transport": jira_transport,
            "live": jira_transport != "MockJiraTransport",
            "published": len(queue.jira._published),
        },
        "llm": {
            "configured_providers": [name for name, *_ in summarizer._configured_providers()],
            "live": len(summarizer._configured_providers()) > 0,
        },
        "last_pipeline_run": (
            None if last_run is None else {
                "signals_ingested": last_run.report.signals_ingested,
                "incidents_formed": last_run.report.incidents_formed,
                "elapsed_ms": last_run.report.elapsed_ms,
                "calibration_warning": last_run.report.calibration_warning,
            }
        ),
    }


@router.get("/benchmark")
def engine_benchmark() -> dict:
    """The engine scored across generated estates on held-out seeds.

    The golden run proves the engine reproduces one known answer; this is the
    generalisation measurement. Computed once per process (deterministic), so
    the first call takes a few seconds and later calls are instant.
    """
    return benchmark_mod.benchmark()


@offline_router.get("/topologies")
def list_topologies() -> list[dict]:
    """What /demo/run accepts for `topology`, so the frontend doesn't
    hardcode a list that could drift from scenarios.py."""
    return [
        {
            "name": t.name,
            "services": sorted(t.services()),
            "archetype_roles": sorted({r for r in t.roles.values()}),
        }
        for t in scenarios.TOPOLOGIES
    ]


@router.post("/queue/{draft_id}/approve")
@_recorded("approve", {"body": ApproveRequest})
def approve(draft_id: str, body: ApproveRequest) -> dict:
    with _LOCK:
        return _approve_unlocked(draft_id, body)


@router.post("/queue/{draft_id}/resolve")
@_recorded("resolve", {"body": ResolveRequest})
def resolve(draft_id: str, body: ResolveRequest) -> dict:
    with _LOCK:
        return _resolve_unlocked(draft_id, body)


@router.post("/queue/{draft_id}/reject")
@_recorded("reject", {"body": RejectRequest})
def reject(draft_id: str, body: RejectRequest) -> dict:
    with _LOCK:
        return _reject_unlocked(draft_id, body)


@router.post("/queue/{draft_id}/merge")
@_recorded("merge", {"body": MergeRequest})
def merge(draft_id: str, body: MergeRequest) -> dict:
    with _LOCK:
        return _merge_unlocked(draft_id, body)


# --------------------------------------------------------------------------
# live runtime: the three Nexus SSE streams
# --------------------------------------------------------------------------


def start_live(connect: bool = True):
    """Build the stream engine over the reference graph and start the readers.

    The live engine's result and queue *become* the engine state, so every
    route above (queue, evidence, report, approve/reject) serves live data.
    """
    global _live
    from .engine import live as live_mod

    from .engine.tickets import FileTicketTransport

    # Approved tickets are written to output/tickets/ - the only write path.
    _state.queue = ReviewQueue(transport=FileTicketTransport())
    runtime = live_mod.build_runtime(queue=_state.queue)
    runtime.lock = _LOCK
    with _LOCK:
        _state.result = runtime.engine.result
        _state.graph = runtime.engine.graph
        _state.criticality = runtime.engine.criticality
        _state.evaluation = None
        _state.scenario_desc = f"live: Nexus signal streams ({live_mod.BASE_URL})"
    runtime.start(connect=connect)
    _live = runtime
    return runtime


def stop_live() -> None:
    if _live is not None:
        _live.stop()


def _require_live():
    if _live is None:
        raise HTTPException(404, "live streams are not running (NEXUS_LIVE=0)")
    return _live


@router.get("/stream/status")
def stream_status() -> dict:
    """Per-stream connection state (last event id, keepalives, reconnects) and
    the engine's counters: received, anomalous, pending, incidents, noise."""
    return _require_live().status()


@router.get("/stream/signals")
def stream_signals(
    limit: int = 200, source: str | None = None, service: str | None = None, min_score: float | None = None
) -> dict:
    """Most recent normalised signals, in the challenge's canonical schema.
    Every record is already redacted; nothing raw is kept. `min_score` keeps
    only signals whose anomaly_score is at least that value."""
    runtime = _require_live()
    limit = max(1, min(limit, 2000))
    with _LOCK:
        rows = list(runtime.engine.canonical)
    if source:
        rows = [r for r in rows if r.get("source") == source]
    if service:
        rows = [r for r in rows if r.get("service") == service]
    if min_score is not None:
        rows = [r for r in rows if float(r.get("anomaly_score") or 0.0) >= min_score]
    return {"total": len(rows), "signals": list(reversed(rows[-limit:]))}


@router.get("/stream/metrics")
def stream_metrics() -> dict:
    """Volume per minute by stream, anomaly-score histogram, deduplication
    totals and the conditions that repeat most - all measured from the streams."""
    runtime = _require_live()
    with _LOCK:
        return runtime.engine.metrics()


@router.get("/stream/rejections")
def stream_rejections() -> list[dict]:
    """Candidate groups that failed validation (C4) and were not raised."""
    runtime = _require_live()
    with _LOCK:
        return list(reversed(runtime.engine.rejections))


@router.get("/graph")
def dependency_graph() -> dict:
    """The service dependency graph in use, with each service's criticality
    (0-100) and whether it currently belongs to an open incident."""
    from .engine.live import CRITICALITY_0_100, DEFAULT_CRITICALITY

    graph = _state.graph
    if graph is None:
        raise HTTPException(404, "no graph loaded")
    with _LOCK:
        involved: dict[str, list[str]] = {}
        roots: dict[str, list[str]] = {}
        if _state.result is not None:
            for inc in _state.result.incidents:
                item = _state.queue.items.get(inc.draft.draft_id)
                if item is None or item.lifecycle == "resolved" or item.status.value in ("rejected", "merged"):
                    continue
                for svc in inc.cluster.services:
                    involved.setdefault(svc, []).append(inc.draft.draft_id)
                if inc.causal.root_cause_service:
                    roots.setdefault(inc.causal.root_cause_service, []).append(inc.draft.draft_id)
        nodes = [
            {"id": n, "criticality": CRITICALITY_0_100.get(n, DEFAULT_CRITICALITY),
             "incidents": involved.get(n, []), "root_cause_of": roots.get(n, [])}
            for n in sorted(graph.graph.nodes)
        ]
        edges = [{"caller": a, "callee": b} for a, b in sorted(graph.graph.edges)]
    return {"nodes": nodes, "edges": edges,
            "origin": _live.graph_origin if _live is not None else "offline scenario"}
