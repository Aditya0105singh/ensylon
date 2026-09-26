"""DEDUPLICATE — collapse repeated firings of the same underlying condition.

Sits between INGEST/REDACT and DETECT. A stuck health check re-fires on every
evaluation interval; a saturated connection pool logs the same "exhausted"
line every few seconds while it stays saturated. None of that repetition is
new information — it is the same condition, observed again — so counting each
occurrence as an independent signal would inflate volume without adding
anything DETECT or CORRELATE could act on differently.

Fingerprint: service + component + a content key, matched within a fixed time
bucket. The content key differs by shape, because "the same condition" means
something different for a metric alarm than for a log line:

  * Log-shaped signals (app/CloudWatch logs) use their mined Drain3 template
    — "connection pool exhausted: {n}/200" is one template regardless of
    which number fills the gap, and it's exactly variation like that which
    would otherwise defeat a naive text-equality dedup.
  * Everything else (metric alarms, Grafana alerts, trace spans) uses its
    alert/metric name — these don't carry ad-hoc bracketed numbers the same
    way log lines do, and a metric name is already the stable identity of a
    recurring condition.

Within a match, the earliest signal survives as the representative and
absorbs the group's size into `occurrence_count`. Collapsing to the earliest
rather than the latest preserves true onset time, which the causal engine's
temporal-precedence pass depends on.

Template mining happens here, not redone in DETECT: this module owns the one
LogTemplateMiner instance for the run, and DETECT reads the template_id this
stage already assigned rather than re-mining with a second, differently
seeded miner that could cluster the same text into a different id.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime

from .detect import LogTemplateMiner
from .signal import Signal, SignalSource

# "bucket = 5 minutes" - matches a typical alert-rule evaluation interval, so
# a health check re-firing every 1-2 minutes collapses into one signal, while
# two genuinely separate incidents hours apart never accidentally merge.
BUCKET_MINUTES = 5.0

_LOG_SOURCES = {SignalSource.APP_LOG, SignalSource.CLOUDWATCH_LOG}


def _bucket_index(signal: Signal, bucket_minutes: float) -> int:
    return int(signal.timestamp.timestamp() // (bucket_minutes * 60))


def _content_key(signal: Signal, miner: LogTemplateMiner) -> str:
    if signal.source in _LOG_SOURCES:
        if not signal.template_id:
            tid, text = miner.add(signal.message)
            signal.template_id = tid
            signal.labels.setdefault("log_template", text)
        return f"tpl:{signal.template_id}"
    return f"alert:{signal.labels.get('alertname') or signal.metric or signal.message[:60]}"


def _fingerprint(signal: Signal, miner: LogTemplateMiner, bucket_minutes: float) -> tuple:
    return (
        signal.service,
        signal.component or "",
        _content_key(signal, miner),
        _bucket_index(signal, bucket_minutes),
    )


@dataclass
class DedupReport:
    raw_signals: int = 0
    unique_signals: int = 0
    collapsed: int = 0
    bucket_minutes: float = BUCKET_MINUTES
    template_backend: str = "drain3"

    @property
    def collapsed_pct(self) -> float:
        if not self.raw_signals:
            return 0.0
        return round(100.0 * self.collapsed / self.raw_signals, 1)


def deduplicate(
    signals: list[Signal], bucket_minutes: float = BUCKET_MINUTES
) -> tuple[list[Signal], DedupReport]:
    """Collapse fingerprint-matching signals within each time bucket.

    Runs on every signal, not just anomalous ones - DETECT hasn't executed
    yet at this point in the pipeline, so anomaly status doesn't exist to
    filter on. Deduplication is a volume-reduction step independent of
    whether a signal will later turn out to matter.
    """
    miner = LogTemplateMiner()
    groups: dict[tuple, list[Signal]] = defaultdict(list)

    for signal in sorted(signals, key=lambda s: s.timestamp):
        key = _fingerprint(signal, miner, bucket_minutes)
        groups[key].append(signal)

    unique: list[Signal] = []
    for members in groups.values():
        members.sort(key=lambda s: s.timestamp)
        representative = members[0]
        representative.occurrence_count = len(members)
        unique.append(representative)

    unique.sort(key=lambda s: s.timestamp)
    report = DedupReport(
        raw_signals=len(signals),
        unique_signals=len(unique),
        collapsed=len(signals) - len(unique),
        bucket_minutes=bucket_minutes,
        template_backend=miner.backend,
    )
    return unique, report
