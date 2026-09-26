"""The Signal envelope — one shape every source normalizes into.

The brief names four telemetry sources with four completely different
payload schemas (CloudWatch metric alarms, CloudWatch log events, Grafana
webhook alerts, OTel logs and trace spans). Everything downstream — detection,
correlation, the causal engine, scoring — reads this envelope and nothing else,
so adding a fifth source later means writing one adapter, not touching the
pipeline.

The fields are deliberately a superset: a metric alarm fills `metric`/`value`/
`threshold` and leaves `trace_id` empty, a trace span does the reverse. Code
that needs a field checks for it rather than assuming the source.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class SignalSource(str, Enum):
    CLOUDWATCH_METRIC = "cloudwatch_metric"
    CLOUDWATCH_LOG = "cloudwatch_log"
    GRAFANA_ALERT = "grafana_alert"
    APP_LOG = "app_log"
    TRACE_SPAN = "trace_span"


class Severity(str, Enum):
    CRITICAL = "critical"
    HIGH = "high"
    WARNING = "warning"
    INFO = "info"


# Ordering used wherever "how bad is this" needs to be comparable. Lower is
# worse, so min() picks the most severe.
SEVERITY_RANK: dict[str, int] = {
    Severity.CRITICAL: 0,
    Severity.HIGH: 1,
    Severity.WARNING: 2,
    Severity.INFO: 3,
}


def _utc(ts: Any) -> datetime:
    """Coerce whatever a source gave us into an aware UTC datetime.

    Sources disagree: CloudWatch sends ISO-8601 with a Z, Grafana sends
    RFC3339 with an offset, OTel sends Unix nanoseconds. Correlation compares
    timestamps across all of them, so a naive datetime slipping through would
    silently break time proximity — hence normalizing here, once, rather than
    at each comparison site.
    """
    if isinstance(ts, datetime):
        dt = ts
    elif isinstance(ts, (int, float)):
        # OTel uses nanoseconds; anything that large is clearly not seconds.
        seconds = ts / 1e9 if ts > 1e12 else ts
        dt = datetime.fromtimestamp(seconds, tz=timezone.utc)
    else:
        text = str(ts).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(text)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


class Signal(BaseModel):
    """One normalized observation from any source."""

    id: str
    source: SignalSource
    service: str
    component: str | None = None
    environment: str | None = None   # prod | staging | dev, when the source says
    region: str | None = None
    severity: Severity = Severity.INFO
    timestamp: datetime
    message: str = ""

    # Metric-shaped sources only.
    metric: str | None = None
    value: float | None = None
    threshold: float | None = None

    # Trace-shaped sources only. `parent_service` is what lets the causal
    # engine build a dependency graph without a service registry.
    trace_id: str | None = None
    span_id: str | None = None
    parent_service: str | None = None

    labels: dict[str, str] = Field(default_factory=dict)

    # --- populated by later stages, never by an adapter ---
    redacted_fields: list[str] = Field(default_factory=list)
    template_id: str | None = None
    is_anomaly: bool = False
    anomaly_score: float = 0.0
    detection_reason: str = ""
    occurrence_count: int = 1

    # Evaluation-only ground truth from the synthetic generator. The pipeline
    # never reads this - it exists so precision/recall can be measured.
    truth_incident: str | None = None
    truth_is_root_cause: bool = False

    model_config = {"use_enum_values": True}

    @property
    def context_key(self) -> str:
        """Coarse identity used for deduplication and blocking."""
        return f"{self.service}|{self.component or '-'}|{self.template_id or self.metric or self.message[:40]}"


def make_signal_id(source: str, service: str, timestamp: Any, discriminator: str) -> str:
    """Stable, content-derived id.

    Deterministic rather than random so re-ingesting the same payload yields
    the same id — which is what makes ingestion idempotent, and stops a
    retried webhook delivery from becoming a second signal.
    """
    stamp = _utc(timestamp).isoformat()
    raw = f"{source}|{service}|{stamp}|{discriminator}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def normalize_timestamp(ts: Any) -> datetime:
    """Public wrapper so adapters share one timestamp interpretation."""
    return _utc(ts)
