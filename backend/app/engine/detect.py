"""DETECT — establish per-source baselines and flag genuine deviations.

Three source families need three different treatments, and conflating them is
how naive pipelines end up either missing real incidents or paging on noise:

  * Metrics get an EWMA baseline with a z-score. Exponential weighting is
    robust to gradual drift (traffic grows week over week; a fixed threshold
    set in January is wrong by March) while still reacting to a step change.
  * Logs get Drain3 template mining. Raw log lines are unique — ids, durations
    and counts differ every time — so counting them directly is meaningless.
    Mining them into templates makes "this same error, 12 times" countable.
  * Grafana alerts arrive already thresholded by their own alert rule and are
    passed through untouched. Re-judging them would either double-count or,
    worse, silently overrule an operator's deliberately-tuned rule.

Everything here is deliberately explainable. A z-score and a template count
can be printed into the ticket ("3.4σ above 7-day baseline", "template seen
12× vs 0.3 expected") and argued with. A learned detector cannot, and under a
24-hour clock a detector we can debug beats one we can only trust.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from .signal import Severity, Signal, SignalSource

# --------------------------------------------------------------------------
# tunables
# --------------------------------------------------------------------------

EWMA_ALPHA = 0.3          # weight on the newest observation
Z_THRESHOLD = 3.0         # deviations before a metric is anomalous
MIN_WARMUP = 5            # observations before a baseline is trusted at all
BURST_MIN_COUNT = 3       # repeats of one template before it counts as a burst
BURST_RATIO = 4.0         # ...or this many times its historical rate


# --------------------------------------------------------------------------
# metric baselines
# --------------------------------------------------------------------------


@dataclass
class SeriesBaseline:
    """Running EWMA mean and variance for one (service, metric) series.

    Welford-style online variance would be exact, but it weights a data point
    from a month ago the same as one from a minute ago. EWMA variance is the
    right trade for telemetry, where the recent past is the only relevant
    reference.
    """

    mean: float = 0.0
    var: float = 0.0
    count: int = 0

    def update(self, value: float) -> None:
        if self.count == 0:
            self.mean, self.var = value, 0.0
        else:
            delta = value - self.mean
            self.mean += EWMA_ALPHA * delta
            self.var = (1 - EWMA_ALPHA) * (self.var + EWMA_ALPHA * delta * delta)
        self.count += 1

    @property
    def std(self) -> float:
        return math.sqrt(self.var)

    def z_score(self, value: float) -> float | None:
        """None while still warming up, or when the series has never varied.

        A zero-variance series is the dangerous case: dividing by it yields
        infinity and flags a metric that has simply been constant. Returning
        None makes the caller decide explicitly instead of inheriting an inf.
        """
        if self.count < MIN_WARMUP:
            return None
        std = self.std
        if std < 1e-9:
            return None
        return (value - self.mean) / std


# --------------------------------------------------------------------------
# log templates
# --------------------------------------------------------------------------


class LogTemplateMiner:
    """Drain3 wrapper that also tracks how often each template is seen.

    Falls back to a crude normalizer if Drain3 is unavailable, so the pipeline
    degrades rather than dies — the same posture taken in redaction.py.
    """

    def __init__(self) -> None:
        self._miner: Any = None
        self.template_counts: dict[str, int] = {}
        self.template_text: dict[str, str] = {}
        try:
            from drain3 import TemplateMiner
            from drain3.template_miner_config import TemplateMinerConfig

            config = TemplateMinerConfig()
            config.drain_sim_th = 0.4       # similarity to join an existing cluster
            config.drain_depth = 4
            config.drain_max_children = 100
            config.masking_instructions = []
            self._miner = TemplateMiner(config=config)
        except Exception:
            self._miner = None

    @property
    def backend(self) -> str:
        return "drain3" if self._miner is not None else "regex-fallback"

    def add(self, message: str, weight: int = 1) -> tuple[str, str]:
        """Return (template_id, template_text) for one log line.

        `weight` lets a caller feed an already-deduplicated signal (one
        representative standing in for N collapsed originals) without
        breaking burst detection downstream. DEDUPLICATE runs before DETECT,
        so by the time a signal reaches here it may carry an occurrence_count
        greater than one — counting it as a single observation would make a
        genuine 12x burst look like a single, unremarkable log line.
        """
        if not message:
            return "empty", ""
        if self._miner is not None:
            result = self._miner.add_log_message(message)
            tid = f"T{result['cluster_id']}"
            text = result["template_mined"]
        else:
            text = _crude_template(message)
            tid = f"T{abs(hash(text)) % 100000}"
        self.template_counts[tid] = self.template_counts.get(tid, 0) + weight
        self.template_text[tid] = text
        return tid, text


def _crude_template(message: str) -> str:
    """Digit/hex/UUID blanking — enough to group identical errors if Drain3
    is missing, without pretending to be as good as it."""
    import re

    text = re.sub(r"\b[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}\b", "<*>", message)
    text = re.sub(r"\b[0-9a-fA-F]{16,}\b", "<*>", text)
    text = re.sub(r"\b\d+(?:\.\d+)?\b", "<*>", text)
    return text


# --------------------------------------------------------------------------
# detector
# --------------------------------------------------------------------------


@dataclass
class DetectorState:
    """Carried across batches so baselines survive a restart."""

    baselines: dict[str, SeriesBaseline] = field(default_factory=dict)
    template_rates: dict[str, float] = field(default_factory=dict)
    # One miner for the life of the state, so a template keeps the same id from
    # one micro-batch to the next. A fresh miner per call renumbered templates
    # on every batch, which made template_rates compare unrelated templates as
    # soon as signals arrived as a stream rather than one batch.
    miner: Any = field(default=None, repr=False, compare=False)

    def baseline_for(self, key: str) -> SeriesBaseline:
        return self.baselines.setdefault(key, SeriesBaseline())


@dataclass
class DetectionReport:
    total: int = 0
    anomalous: int = 0
    within_baseline: int = 0
    pre_flagged: int = 0
    by_reason: dict[str, int] = field(default_factory=dict)
    template_backend: str = "drain3"
    novel_templates: int = 0


_ERROR_SEVERITIES = {Severity.CRITICAL, Severity.HIGH}

# Severities allowed to trigger novelty and burst detection. Warnings are
# included because plenty of real failures never emit an ERROR at all — a
# replica falling further and further behind logs WARN the whole way down, and
# a detector keyed purely on severity would watch that incident unfold in
# silence. INFO is excluded: a healthy service repeats its heartbeat line
# forever, so volume alone says nothing there.
_NOTABLE_SEVERITIES = _ERROR_SEVERITIES | {Severity.WARNING}


def detect(
    signals: list[Signal], state: DetectorState | None = None
) -> tuple[list[Signal], DetectionReport, DetectorState]:
    """Annotate each signal with is_anomaly / anomaly_score / reason.

    Returns the state so a caller can persist it — baselines are only useful
    if they outlive the process.
    """
    state = state or DetectorState()
    if state.miner is None:
        state.miner = LogTemplateMiner()
    miner = state.miner
    miner.template_counts = {}  # burst counts are per batch; ids are not
    report = DetectionReport(total=len(signals), template_backend=miner.backend)

    # Pass 1: mine templates so burst counts are known before we judge.
    log_signals = [
        s for s in signals
        if s.source in (SignalSource.APP_LOG, SignalSource.CLOUDWATCH_LOG)
    ]
    for signal in log_signals:
        tid, text = miner.add(signal.message, weight=signal.occurrence_count)
        signal.template_id = tid
        signal.labels.setdefault("log_template", text)

    # Pass 2: judge each signal by its kind.
    for signal in signals:
        # Baselines learn from every metric observation, including ones already
        # flagged upstream. Skipping those would mean a series only ever learns
        # from its quiet periods, and its variance would understate reality.
        z = _update_metric_baseline(signal, state)

        if signal.is_anomaly and signal.detection_reason:
            # Already decided upstream (CloudWatch alarm, Grafana rule, span
            # ERROR status). Trust the decision, but enrich it with baseline
            # context where we have any — "in ALARM state" is a fact, "4.1σ
            # above the 7-day mean" is what makes it arguable in a ticket.
            # The score is ours, not the source's: how far past its threshold the
            # observed value is (0.6 at the line, 1.0 at 20% beyond it), and the
            # baseline z-score where one exists. A flat constant would rank a
            # 1% breach and a 2x breach the same.
            breach = None
            if signal.value is not None and signal.threshold:
                margin = abs(signal.value - signal.threshold) / abs(signal.threshold)
                breach = min(1.0, 0.6 + 2.0 * margin)
                signal.detection_reason += (
                    f"; {signal.value:g} vs threshold {signal.threshold:g} ({margin:+.0%} past it)"
                )
            if z is not None and abs(z) >= Z_THRESHOLD:
                signal.detection_reason += f"; {abs(z):.1f}σ from baseline"
                signal.anomaly_score = max(signal.anomaly_score, min(abs(z) / 6.0, 1.0), breach or 0.0)
            else:
                signal.anomaly_score = max(signal.anomaly_score, breach if breach is not None else 0.7)
            report.pre_flagged += 1
            report.anomalous += 1
            _tally(report, signal.detection_reason)
            continue

        if signal.source == SignalSource.CLOUDWATCH_METRIC:
            _judge_metric(signal, z)
        elif signal.source in (SignalSource.APP_LOG, SignalSource.CLOUDWATCH_LOG):
            _judge_log(signal, miner, state, report)
        else:
            signal.is_anomaly = signal.severity in _ERROR_SEVERITIES
            signal.detection_reason = (
                f"severity={signal.severity}" if signal.is_anomaly else ""
            )

        if signal.is_anomaly:
            report.anomalous += 1
            _tally(report, signal.detection_reason)
        else:
            report.within_baseline += 1

    # Fold this batch's template counts into the long-run rate for next time.
    for tid, count in miner.template_counts.items():
        prior = state.template_rates.get(tid, 0.0)
        state.template_rates[tid] = (1 - EWMA_ALPHA) * prior + EWMA_ALPHA * count

    return signals, report, state


def _tally(report: DetectionReport, reason: str) -> None:
    key = reason.split(":")[0].split("(")[0].strip() or "unspecified"
    report.by_reason[key] = report.by_reason.get(key, 0) + 1


def _update_metric_baseline(signal: Signal, state: DetectorState) -> float | None:
    """Feed one metric observation into its series baseline.

    Returns the z-score computed *before* the update, so a point is never
    scored against a baseline it has already contributed to.
    """
    if signal.source != SignalSource.CLOUDWATCH_METRIC or signal.value is None:
        return None
    baseline = state.baseline_for(f"{signal.service}|{signal.metric or 'value'}")
    z = baseline.z_score(signal.value)
    baseline.update(signal.value)
    return z


def _judge_metric(signal: Signal, z: float | None) -> None:
    """Metric anomaly for a signal that arrived *without* a firing alarm.

    This path handles polled datapoints rather than alarm notifications — an
    alarm in ALARM state is already trusted upstream. With no alarm to lean on,
    a z-score against the series baseline is the only evidence available, and
    on a cold start (every series on day one) there is none, so the signal is
    correctly left unflagged rather than guessed at.
    """
    if z is not None and abs(z) >= Z_THRESHOLD:
        signal.is_anomaly = True
        signal.anomaly_score = min(abs(z) / 6.0, 1.0)
        signal.detection_reason = (
            f"metric {signal.metric} at {signal.value:g} is {abs(z):.1f}σ from baseline"
        )
        return

    signal.is_anomaly = False
    signal.anomaly_score = min(abs(z) / 6.0, 1.0) if z is not None else 0.0
    signal.detection_reason = ""


def _judge_log(
    signal: Signal,
    miner: LogTemplateMiner,
    state: DetectorState,
    report: DetectionReport,
) -> None:
    """Log anomaly via template novelty, burst rate, or error severity."""
    tid = signal.template_id or ""
    count = miner.template_counts.get(tid, 1)
    expected = state.template_rates.get(tid)
    is_error = signal.severity in _ERROR_SEVERITIES
    notable = signal.severity in _NOTABLE_SEVERITIES

    # A template never seen before is inherently interesting — a brand-new
    # error message is exactly what a fresh failure mode looks like.
    if expected is None and notable:
        report.novel_templates += 1
        signal.is_anomaly = True
        signal.anomaly_score = 0.8
        kind = "error" if is_error else "warning"
        signal.detection_reason = f"novel {kind} template {tid} not seen in baseline"
        return

    # Burst detection. "Repeated a lot" is only evidence of a problem relative
    # to how often that template *normally* repeats — a healthy service emits
    # its heartbeat line thousands of times an hour. So a rate comparison
    # requires a baseline, and on a cold start (every series on day one) there
    # isn't one. Rather than guess, we fall back to severity: an error
    # repeating is a burst, an INFO line repeating is just a working system.
    if count >= BURST_MIN_COUNT:
        # INFO is never a burst, baseline or not: "Premium collected" 26 times
        # is a busy, healthy service, not an incident.
        if expected is not None and notable and count >= expected * BURST_RATIO:
            signal.is_anomaly = True
            signal.anomaly_score = min(count / 20.0 + 0.4, 1.0)
            signal.detection_reason = (
                f"log burst: template {tid} seen {count}× vs {expected:.1f} expected"
            )
            return
        if expected is None and notable:
            signal.is_anomaly = True
            signal.anomaly_score = min(count / 20.0 + 0.4, 1.0)
            kind = "error" if is_error else "warning"
            signal.detection_reason = (
                f"{kind} burst: template {tid} seen {count}× (no baseline yet)"
            )
            return

    if is_error:
        signal.is_anomaly = True
        signal.anomaly_score = 0.6
        signal.detection_reason = f"error-severity log ({signal.severity})"
        return

    signal.is_anomaly = False
    signal.anomaly_score = 0.0
    signal.detection_reason = ""
