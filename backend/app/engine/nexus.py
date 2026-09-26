"""Nexus Agency signal formats: the three challenge streams in, Signals out.

One parser per stream, written against the payloads in the problem statement:

  * aiops-logs        plain-text lines: `<ts> <LEVEL> <service> <component> [ctx] message`
  * aiops-cloudwatch  CloudWatch alarm state changes with an AffectedResources block
  * aiops-grafana     Grafana (legacy) alerting webhooks with evalMatches

PII is removed inside each parser, so no un-redacted Signal ever leaves this
module. Two layers:

  1. By field meaning. Context keys and payload fields that *are* personal or
     account data (user, ip, session, acc, accountId, serviceAccount, a host tag
     holding an IP) are replaced outright, whatever their value looks like. A
     pattern might miss an unusual value; a field known to hold PII never can.
  2. By pattern, on all free text (messages, descriptions, titles), via
     redaction.redact_text: emails, IPs, session tokens, account numbers, cloud
     account ids, phone numbers, and personal names.

Each parser also records which *other* known services a signal names, for
example "Circuit breaker OPEN for payments-service" or a Grafana `upstream` tag.
That is structural evidence the correlator can use (see correlate._gate_reason).
"""

from __future__ import annotations

import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Iterable

from .redaction import learn_names, redact_text
from .signal import Severity, Signal, SignalSource, normalize_timestamp

# --------------------------------------------------------------------------
# shared helpers
# --------------------------------------------------------------------------

_LEVELS = {
    "FATAL": Severity.CRITICAL, "CRITICAL": Severity.CRITICAL, "ERROR": Severity.HIGH,
    "WARN": Severity.WARNING, "WARNING": Severity.WARNING,
    "INFO": Severity.INFO, "DEBUG": Severity.INFO, "TRACE": Severity.INFO,
}

# Context / payload keys whose values are personal or account data. Replaced
# by key, never passed through a pattern first.
_PII_KEYS = {
    "user": "EMAIL", "email": "EMAIL", "ip": "IPV4", "client_ip": "IPV4",
    "session": "SESSION", "sess": "SESSION", "acc": "ACCOUNT", "account": "ACCOUNT",
    "accountid": "CLOUD_ACCOUNT", "serviceaccount": "SERVICE_ACCOUNT",
    "phone": "PHONE", "name": "NAME",
}

_ENV_TOKENS = (("prod", "prod"), ("staging", "staging"), ("stg", "staging"), ("dev", "dev"))


def _env_from_host(host: str | None) -> str | None:
    if not host:
        return None
    parts = re.split(r"[-_.]", host.lower())
    for token, env in _ENV_TOKENS:
        if token in parts:
            return env
    return None


def _redact_field(key: str, value: Any, found: list[str]) -> str:
    kind = _PII_KEYS.get(key.lower().replace("_", "").replace("-", ""))
    text = "" if value is None else str(value)
    if kind:
        learn_names(text)  # an email in a user field teaches the name pass
        found.append(kind)
        return f"[REDACTED:{kind}]"
    clean, kinds = redact_text(text)
    found.extend(kinds)
    return clean


def _redact_free_text(text: str, found: list[str]) -> str:
    clean, kinds = redact_text(text or "")
    found.extend(kinds)
    return clean


def referenced_services(text: str, known: Iterable[str], exclude: str | None = None) -> list[str]:
    """Known service names that appear in free text, other than the signal's own."""
    lowered = (text or "").lower()
    out = []
    for svc in known:
        # A hyphen may precede the name (alarm "HighDBConnections-payments-service")
        # but not follow it, so "payments-service" never matches inside
        # "payments-service-v2".
        if svc and svc != exclude and re.search(rf"(?<![A-Za-z0-9_]){re.escape(svc.lower())}(?![\w-])", lowered):
            out.append(svc)
    return sorted(out)


def _finalise(signal: Signal, found: list[str], known_services: Iterable[str], extra_text: str = "") -> Signal:
    signal.redacted_fields = list(dict.fromkeys(found))
    mentions = referenced_services(f"{signal.message} {extra_text}", known_services, exclude=signal.service)
    if mentions:
        signal.labels["mentions"] = ",".join(mentions)
    return signal


# --------------------------------------------------------------------------
# aiops-logs: plain text
# --------------------------------------------------------------------------

_LOG_LINE = re.compile(
    r"^\s*(?P<ts>\S+)\s+(?P<level>[A-Za-z]+)\s+(?P<service>\S+)\s+(?P<component>\S+)\s+"
    r"(?:\[(?P<ctx>[^\]]*)\]\s*)?(?P<msg>.*?)\s*$"
)
_CTX_PAIR = re.compile(r"([A-Za-z_][\w-]*):(\S+)")


def parse_log_line(line: str, known_services: Iterable[str] = (), seq: str | None = None) -> Signal | None:
    """One application log line -> Signal, or None if it is not a log line."""
    m = _LOG_LINE.match(line or "")
    if not m or m.group("level").upper() not in _LEVELS:
        return None
    try:
        ts = normalize_timestamp(m.group("ts"))
    except Exception:
        return None

    found: list[str] = []
    labels: dict[str, str] = {}
    host = None
    for key, value in _CTX_PAIR.findall(m.group("ctx") or ""):
        if key.lower() == "host":
            # Internal hostname: sensitive but not PII (per the brief), and it
            # carries the environment. Kept, unless it is really an IP.
            host = value
            labels["host"] = _redact_free_text(value, found)
        else:
            labels[f"ctx.{key}"] = _redact_field(key, value, found)
    message = _redact_free_text(m.group("msg"), found)

    level = m.group("level").upper()
    signal = Signal(
        id=str(uuid.uuid4()),
        source=SignalSource.APP_LOG,
        service=m.group("service"),
        component=m.group("component"),
        environment=_env_from_host(host),
        severity=_LEVELS[level],
        timestamp=ts,
        message=message,
        labels={**labels, "level": level, **({"stream_seq": seq} if seq else {})},
    )
    return _finalise(signal, found, known_services)


# --------------------------------------------------------------------------
# aiops-cloudwatch: alarm state changes
# --------------------------------------------------------------------------

def from_cloudwatch(payload: dict[str, Any] | str, known_services: Iterable[str] = (),
                    seq: str | None = None) -> Signal | None:
    """One CloudWatch alarm -> Signal. OK transitions are recoveries: None."""
    if isinstance(payload, str):
        payload = json.loads(payload)
    if str(payload.get("NewStateValue", "")).upper() != "ALARM":
        return None
    found: list[str] = []
    trigger = payload.get("Trigger") or {}
    affected = payload.get("AffectedResources") or {}
    dims = {d.get("name"): d.get("value") for d in trigger.get("Dimensions") or [] if isinstance(d, dict)}

    service = (affected.get("service") or dims.get("ServiceName") or dims.get("DBInstanceIdentifier")
               or payload.get("AlarmName") or "unknown")
    try:
        ts = normalize_timestamp(payload.get("StateChangeTime"))
    except Exception:
        return None

    alarm_name = _redact_free_text(str(payload.get("AlarmName") or "CloudWatchAlarm"), found)
    description = _redact_free_text(str(payload.get("AlarmDescription") or ""), found)
    value = trigger.get("ObservedValue")
    threshold = trigger.get("Threshold")

    labels: dict[str, str] = {
        "alarm_name": alarm_name,
        "namespace": str(trigger.get("Namespace") or ""),
        "statistic": str(trigger.get("Statistic") or ""),
        "period_s": str(trigger.get("Period") or ""),
        "evaluation_periods": str(trigger.get("EvaluationPeriods") or ""),
        "old_state": str(payload.get("OldStateValue") or ""),
        **{f"dim.{k}": _redact_free_text(str(v), found) for k, v in dims.items() if k},
    }
    for key in ("accountId", "serviceAccount"):
        if key in affected:
            labels[f"resource.{key}"] = _redact_field(key, affected[key], found)

    signal = Signal(
        id=str(uuid.uuid4()),
        source=SignalSource.CLOUDWATCH_METRIC,
        service=str(service),
        component=affected.get("component") or trigger.get("MetricName"),
        environment=affected.get("environment"),
        region=affected.get("region") or payload.get("Region"),
        severity=Severity.CRITICAL,
        timestamp=ts,
        message=description or alarm_name,
        metric=trigger.get("MetricName"),
        value=float(value) if isinstance(value, (int, float)) else None,
        threshold=float(threshold) if isinstance(threshold, (int, float)) else None,
        labels={**labels, **({"stream_seq": seq} if seq else {})},
        is_anomaly=True,
        detection_reason=f"CloudWatch alarm {alarm_name} in ALARM state",
    )
    return _finalise(signal, found, known_services, extra_text=alarm_name)


# --------------------------------------------------------------------------
# aiops-grafana: legacy alerting webhook, one alert per event
# --------------------------------------------------------------------------

_THRESHOLD_IN_TEXT = re.compile(r"(?:above|below|over|under|exceed(?:s|ed)?)\s+the\s+([\d.]+)\s*[a-z%]*\s+threshold", re.I)


def from_grafana(payload: dict[str, Any] | str, received_at: datetime | None = None,
                 known_services: Iterable[str] = (), seq: str | None = None) -> Signal | None:
    """One Grafana alert -> Signal. `pending` is kept but not pre-flagged;
    `ok` / `no_data` / `paused` are not incident symptoms and return None.

    Grafana's payload carries no timestamp, so the caller supplies the time it
    arrived on the stream (aligned to the other streams' clock).
    """
    if isinstance(payload, str):
        payload = json.loads(payload)
    state = str(payload.get("state", "")).lower()
    if state not in ("alerting", "pending"):
        return None
    found: list[str] = []
    matches = [m for m in payload.get("evalMatches") or [] if isinstance(m, dict)]
    first = matches[0] if matches else {}
    tags = {**(payload.get("tags") or {}), **(first.get("tags") or {})}

    title = _redact_free_text(str(payload.get("title") or ""), found)
    rule = _redact_free_text(str(payload.get("ruleName") or ""), found)
    service = tags.get("service")
    if not service and "—" in title:
        service = title.split("—")[-1].strip()
    service = service or rule or "unknown"

    body = _redact_free_text(str(payload.get("message") or ""), found)
    value = first.get("value")
    threshold = None
    tm = _THRESHOLD_IN_TEXT.search(body)
    if tm:
        try:
            threshold = float(tm.group(1))
        except ValueError:
            threshold = None

    labels: dict[str, str] = {
        "rule_name": rule, "title": title, "grafana_state": state,
        "dashboard_id": str(payload.get("dashboardId") or ""), "panel_id": str(payload.get("panelId") or ""),
    }
    for key, raw in tags.items():
        if key in ("service", "environment", "region"):
            continue
        # tags.host may be an IP; any tag value goes through the pattern pass.
        labels[f"tag.{key}"] = _redact_free_text(str(raw), found)

    alerting = state == "alerting"
    signal = Signal(
        id=str(uuid.uuid4()),
        source=SignalSource.GRAFANA_ALERT,
        service=str(service),
        component=tags.get("component") or tags.get("job"),
        environment=tags.get("environment"),
        region=tags.get("region"),
        severity=Severity.HIGH if alerting else Severity.WARNING,
        timestamp=received_at or datetime.now(timezone.utc),
        message=f"{title}: {body}" if body else title,
        metric=first.get("metric"),
        value=float(value) if isinstance(value, (int, float)) else None,
        threshold=threshold,
        labels={**labels, **({"stream_seq": seq} if seq else {})},
        is_anomaly=alerting,
        detection_reason=f"Grafana rule {rule} alerting" if alerting else "",
    )
    upstream = str(tags.get("upstream") or "")
    return _finalise(signal, found, known_services, extra_text=f"{rule} {upstream}")


# --------------------------------------------------------------------------
# canonical schema (problem statement, section 4)
# --------------------------------------------------------------------------

_CANONICAL_SOURCE = {
    SignalSource.CLOUDWATCH_METRIC.value: "cloudwatch_metrics",
    SignalSource.APP_LOG.value: "application_logs",
    SignalSource.CLOUDWATCH_LOG.value: "application_logs",
    SignalSource.GRAFANA_ALERT.value: "grafana_alerts",
}
_SIGNAL_TYPE = {
    "cloudwatch_metrics": "metric_anomaly",
    "application_logs": "error_log_burst",
    "grafana_alerts": "grafana_alert",
}


def to_canonical(signal: Signal) -> dict[str, Any]:
    """The canonical signal record. Built only from already-redacted fields."""
    source = _CANONICAL_SOURCE.get(str(getattr(signal.source, "value", signal.source)), str(signal.source))
    if signal.template_id:
        evidence = f"{signal.message} — template#{signal.template_id.lstrip('T')}"
    elif signal.metric and signal.value is not None:
        limit = f" vs threshold {signal.threshold:g}" if signal.threshold is not None else ""
        evidence = f"{signal.metric} = {signal.value:g}{limit} — {signal.message}"
    else:
        evidence = signal.message
    metadata = {k: v for k, v in signal.labels.items() if k != "log_template"}
    metadata.update({
        "is_anomaly": signal.is_anomaly,
        "detection_reason": signal.detection_reason,
        "occurrence_count": signal.occurrence_count,
        "severity": str(getattr(signal.severity, "value", signal.severity)),
        "redacted": signal.redacted_fields,
    })
    return {
        "signal_id": signal.id,
        "timestamp": signal.timestamp.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
        "environment": signal.environment or "unknown",
        "region": signal.region or "unknown",
        "service": signal.service,
        "component": signal.component or "unknown",
        "signal_type": _SIGNAL_TYPE.get(source, "unknown"),
        "anomaly_score": round(float(signal.anomaly_score), 3),
        "evidence": evidence,
        "metadata": metadata,
    }
