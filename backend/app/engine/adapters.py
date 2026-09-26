"""Source adapters — real payload shapes in, Signal envelopes out.

One function per source, each written against that system's actual documented
schema rather than a convenient invention:

  * CloudWatch alarms arrive as SNS notifications with a nested `Trigger`.
  * CloudWatch Logs come back from FilterLogEvents as epoch-millisecond events.
  * Grafana unified alerting posts a batch with `alerts[]`, labels and
    annotations.
  * OTel logs and spans arrive as OTLP/JSON, where every attribute is wrapped
    in a `{"key": ..., "value": {"stringValue": ...}}` envelope.

Building these ahead of the hackathon is the mitigation for the "three source
schemas in one 24-hour window" risk: schema discovery happens now, against
sample payloads, not at 3am against a live endpoint.

Every adapter is total — a malformed record is skipped with a reason rather
than raising, because one bad log line should never take down ingestion for
the whole batch.
"""

from __future__ import annotations

from typing import Any, Iterable

from .signal import (
    Severity,
    Signal,
    SignalSource,
    make_signal_id,
    normalize_timestamp,
)

# --------------------------------------------------------------------------
# helpers
# --------------------------------------------------------------------------

# Grafana and OTel both use free-form severity strings; map them onto our
# four-level enum. Anything unrecognised falls back to INFO rather than being
# guessed upward - inventing severity would corrupt scoring downstream.
_SEVERITY_ALIASES = {
    "critical": Severity.CRITICAL, "crit": Severity.CRITICAL, "fatal": Severity.CRITICAL,
    "emergency": Severity.CRITICAL, "alert": Severity.CRITICAL, "error": Severity.HIGH,
    "err": Severity.HIGH, "high": Severity.HIGH, "major": Severity.HIGH,
    "warning": Severity.WARNING, "warn": Severity.WARNING, "minor": Severity.WARNING,
    "info": Severity.INFO, "information": Severity.INFO, "debug": Severity.INFO,
    "trace": Severity.INFO, "notice": Severity.INFO,
}


def _severity(raw: Any, default: Severity = Severity.INFO) -> Severity:
    if raw is None:
        return default
    return _SEVERITY_ALIASES.get(str(raw).strip().lower(), default)


def _otel_value(value: dict[str, Any]) -> Any:
    """Unwrap an OTLP AnyValue into a plain Python value."""
    if not isinstance(value, dict):
        return value
    for key in ("stringValue", "boolValue", "intValue", "doubleValue"):
        if key in value:
            return value[key]
    if "arrayValue" in value:
        return [_otel_value(v) for v in value["arrayValue"].get("values", [])]
    return None


def _otel_attrs(attributes: Iterable[dict[str, Any]] | None) -> dict[str, str]:
    """Flatten OTLP attribute lists into a plain dict."""
    out: dict[str, str] = {}
    for attr in attributes or []:
        key = attr.get("key")
        if not key:
            continue
        val = _otel_value(attr.get("value", {}))
        if val is not None:
            out[key] = str(val)
    return out


def _service_from_attrs(attrs: dict[str, str], fallback: str = "unknown") -> str:
    for key in ("service.name", "service", "k8s.deployment.name", "faas.name"):
        if attrs.get(key):
            return attrs[key]
    return fallback


# --------------------------------------------------------------------------
# AWS CloudWatch — metric alarms (SNS notification shape)
# --------------------------------------------------------------------------


def from_cloudwatch_alarm(payload: dict[str, Any]) -> Signal | None:
    """One CloudWatch alarm state change → one Signal.

    Only ALARM transitions become signals. An OK transition is a recovery, not
    an incident symptom, and feeding recoveries into correlation would inflate
    cluster sizes with events that mean the opposite of what they appear to.
    """
    try:
        if str(payload.get("NewStateValue", "")).upper() != "ALARM":
            return None

        trigger = payload.get("Trigger") or {}
        dims = {d.get("name"): d.get("value") for d in trigger.get("Dimensions") or []}
        # The dimension naming the resource is the best available service
        # identity - CloudWatch has no single canonical "service" field.
        service = (
            dims.get("DBInstanceIdentifier")
            or dims.get("ServiceName")
            or dims.get("FunctionName")
            or dims.get("ClusterName")
            or dims.get("LoadBalancer")
            or payload.get("AlarmName", "unknown")
        )
        ts = normalize_timestamp(payload.get("StateChangeTime"))
        alarm_name = payload.get("AlarmName", "CloudWatchAlarm")

        threshold = trigger.get("Threshold")
        value = _extract_alarm_value(payload.get("NewStateReason", ""))

        return Signal(
            id=make_signal_id("cw_metric", str(service), ts, alarm_name),
            source=SignalSource.CLOUDWATCH_METRIC,
            service=str(service),
            component=trigger.get("MetricName"),
            severity=Severity.CRITICAL,  # an alarm firing is, by definition, a breach
            timestamp=ts,
            message=payload.get("NewStateReason") or alarm_name,
            metric=trigger.get("MetricName"),
            value=float(value) if value is not None else None,
            threshold=float(threshold) if threshold is not None else None,
            labels={
                "alarm_name": alarm_name,
                "namespace": trigger.get("Namespace", ""),
                "region": payload.get("Region", ""),
                "comparison": trigger.get("ComparisonOperator", ""),
                **{f"dim.{k}": str(v) for k, v in dims.items() if k},
            },
            # An alarm in ALARM state has already evaluated its own condition,
            # and that condition is not always "greater than" — FreeStorageSpace
            # alarms fire on LessThanThreshold. Re-deriving the comparison here
            # would silently disagree with CloudWatch on every inverted metric,
            # so the alarm is trusted the same way a Grafana rule is. DETECT
            # still enriches it with a z-score where a baseline exists.
            is_anomaly=True,
            detection_reason=f"CloudWatch alarm {alarm_name} in ALARM state",
        )
    except Exception:
        return None


def _extract_alarm_value(reason: str) -> float | None:
    """Pull the observed datapoint out of CloudWatch's prose reason string.

    CloudWatch does not send the breaching value as a field — it only appears
    inside NewStateReason, e.g. "... [200.0 (26/08/26 14:02:00)] was greater
    than the threshold (180.0)". Parsing prose is fragile, so a miss returns
    None and the pipeline simply scores without a magnitude rather than
    guessing one.
    """
    import re

    match = re.search(r"\[([0-9]*\.?[0-9]+)\s*\(", reason)
    if match:
        return float(match.group(1))
    match = re.search(r"was\s+(?:greater|less)\s+than.*?([0-9]*\.?[0-9]+)", reason)
    return float(match.group(1)) if match else None


# --------------------------------------------------------------------------
# AWS CloudWatch — log events (FilterLogEvents shape)
# --------------------------------------------------------------------------


def from_cloudwatch_logs(
    response: dict[str, Any], service: str | None = None
) -> list[Signal]:
    """A FilterLogEvents response → one Signal per event."""
    signals: list[Signal] = []
    group = response.get("logGroupName", "")
    for event in response.get("events") or []:
        try:
            ts = normalize_timestamp(event["timestamp"] / 1000.0)
            stream = event.get("logStreamName", "")
            svc = service or _service_from_log_group(group) or stream or "unknown"
            message = event.get("message", "")
            signals.append(Signal(
                id=make_signal_id("cw_log", svc, ts, message[:64]),
                source=SignalSource.CLOUDWATCH_LOG,
                service=svc,
                severity=_infer_log_severity(message),
                timestamp=ts,
                message=message,
                labels={"log_group": group, "log_stream": stream},
            ))
        except Exception:
            continue
    return signals


def _service_from_log_group(group: str) -> str | None:
    """`/aws/lambda/order-api` → `order-api`."""
    parts = [p for p in (group or "").split("/") if p]
    return parts[-1] if parts else None


_LOG_LEVEL_HINTS = (
    ("critical", Severity.CRITICAL), ("fatal", Severity.CRITICAL),
    ("error", Severity.HIGH), ("exception", Severity.HIGH),
    ("warn", Severity.WARNING),
)


def _infer_log_severity(message: str) -> Severity:
    lowered = (message or "").lower()
    for token, severity in _LOG_LEVEL_HINTS:
        if token in lowered:
            return severity
    return Severity.INFO


# --------------------------------------------------------------------------
# Grafana unified alerting webhook
# --------------------------------------------------------------------------


def from_grafana_webhook(payload: dict[str, Any]) -> list[Signal]:
    """A Grafana webhook batch → one Signal per firing alert.

    Resolved alerts are skipped for the same reason CloudWatch OK states are:
    a recovery is not a symptom.
    """
    signals: list[Signal] = []
    for alert in payload.get("alerts") or []:
        try:
            if str(alert.get("status", "firing")).lower() != "firing":
                continue
            labels = dict(alert.get("labels") or {})
            annotations = dict(alert.get("annotations") or {})

            service = (
                labels.get("service")
                or labels.get("job")
                or labels.get("instance")
                or "unknown"
            )
            alertname = labels.get("alertname", "GrafanaAlert")
            ts = normalize_timestamp(alert.get("startsAt"))
            message = (
                annotations.get("description")
                or annotations.get("summary")
                or alertname
            )

            signals.append(Signal(
                id=make_signal_id("grafana", service, ts, alertname),
                source=SignalSource.GRAFANA_ALERT,
                service=service,
                component=labels.get("component") or labels.get("job"),
                severity=_severity(labels.get("severity"), Severity.HIGH),
                timestamp=ts,
                message=message,
                metric=alertname,
                value=_parse_grafana_value(alert.get("valueString", "")),
                trace_id=labels.get("trace_id") or labels.get("traceID"),
                labels={"alertname": alertname, **{k: str(v) for k, v in labels.items()}},
                # Grafana has already applied its own thresholding, so these
                # arrive pre-flagged rather than going through DETECT again.
                is_anomaly=True,
                detection_reason="pre-flagged by Grafana alert rule",
            ))
        except Exception:
            continue
    return signals


def _parse_grafana_value(value_string: str) -> float | None:
    """Grafana encodes values as `[ var='B' labels={...} value=93.4 ]`."""
    import re

    match = re.search(r"value=([0-9]*\.?[0-9]+)", value_string or "")
    return float(match.group(1)) if match else None


# --------------------------------------------------------------------------
# OpenTelemetry — logs (OTLP/JSON)
# --------------------------------------------------------------------------


def from_otlp_logs(payload: dict[str, Any]) -> list[Signal]:
    signals: list[Signal] = []
    for resource_log in payload.get("resourceLogs") or []:
        res_attrs = _otel_attrs((resource_log.get("resource") or {}).get("attributes"))
        service = _service_from_attrs(res_attrs)
        for scope_log in resource_log.get("scopeLogs") or []:
            for record in scope_log.get("logRecords") or []:
                try:
                    ts = normalize_timestamp(int(record.get("timeUnixNano", 0)))
                    body = _otel_value(record.get("body") or {}) or ""
                    attrs = _otel_attrs(record.get("attributes"))
                    signals.append(Signal(
                        id=make_signal_id("otel_log", service, ts, str(body)[:64]),
                        source=SignalSource.APP_LOG,
                        service=service,
                        component=attrs.get("code.namespace") or res_attrs.get("host.name"),
                        severity=_severity(record.get("severityText"), Severity.INFO),
                        timestamp=ts,
                        message=str(body),
                        trace_id=record.get("traceId") or None,
                        span_id=record.get("spanId") or None,
                        labels={**res_attrs, **attrs},
                    ))
                except Exception:
                    continue
    return signals


# --------------------------------------------------------------------------
# OpenTelemetry — trace spans (OTLP/JSON)
# --------------------------------------------------------------------------

# OTLP status codes: 0 UNSET, 1 OK, 2 ERROR.
_STATUS_ERROR = 2


def from_otlp_traces(
    payload: dict[str, Any], errors_only: bool = True
) -> list[Signal]:
    """OTLP spans → Signals.

    Two jobs at once. Error spans are incident symptoms in their own right.
    *Every* span, error or not, also carries a caller→callee edge, and those
    edges are what the causal engine's dependency graph is built from — which
    is why `parent_service` is resolved here rather than being rediscovered
    later.

    With `errors_only` (the default) only failing spans become Signals, but
    `service_dependency_edges` below still reads the full payload, so healthy
    traffic still contributes topology without flooding correlation.
    """
    signals: list[Signal] = []
    span_service = _index_span_services(payload)

    for resource_span in payload.get("resourceSpans") or []:
        res_attrs = _otel_attrs((resource_span.get("resource") or {}).get("attributes"))
        service = _service_from_attrs(res_attrs)
        for scope_span in resource_span.get("scopeSpans") or []:
            for span in scope_span.get("spans") or []:
                try:
                    status = (span.get("status") or {}).get("code", 0)
                    if errors_only and status != _STATUS_ERROR:
                        continue
                    ts = normalize_timestamp(int(span.get("startTimeUnixNano", 0)))
                    attrs = _otel_attrs(span.get("attributes"))
                    name = span.get("name", "span")
                    parent = span_service.get(span.get("parentSpanId") or "")

                    signals.append(Signal(
                        id=make_signal_id("otel_span", service, ts, span.get("spanId", name)),
                        source=SignalSource.TRACE_SPAN,
                        service=service,
                        component=name,
                        severity=Severity.HIGH if status == _STATUS_ERROR else Severity.INFO,
                        timestamp=ts,
                        message=(span.get("status") or {}).get("message") or f"span error: {name}",
                        trace_id=span.get("traceId") or None,
                        span_id=span.get("spanId") or None,
                        parent_service=parent if parent and parent != service else None,
                        labels={**res_attrs, **attrs, "span_name": name},
                        is_anomaly=status == _STATUS_ERROR,
                        detection_reason="span reported ERROR status" if status == _STATUS_ERROR else "",
                    ))
                except Exception:
                    continue
    return signals


def _index_span_services(payload: dict[str, Any]) -> dict[str, str]:
    """spanId → service, so a child span can name its caller."""
    index: dict[str, str] = {}
    for resource_span in payload.get("resourceSpans") or []:
        res_attrs = _otel_attrs((resource_span.get("resource") or {}).get("attributes"))
        service = _service_from_attrs(res_attrs)
        for scope_span in resource_span.get("scopeSpans") or []:
            for span in scope_span.get("spans") or []:
                span_id = span.get("spanId")
                if span_id:
                    index[span_id] = service
    return index


def service_dependency_edges(payload: dict[str, Any]) -> set[tuple[str, str]]:
    """Extract caller→callee edges from a full OTLP trace payload.

    Read from *all* spans, including healthy ones — topology learned only from
    failing traffic would be exactly the topology you cannot trust during an
    incident.
    """
    edges: set[tuple[str, str]] = set()
    span_service = _index_span_services(payload)
    for resource_span in payload.get("resourceSpans") or []:
        res_attrs = _otel_attrs((resource_span.get("resource") or {}).get("attributes"))
        service = _service_from_attrs(res_attrs)
        for scope_span in resource_span.get("scopeSpans") or []:
            for span in scope_span.get("spans") or []:
                parent = span_service.get(span.get("parentSpanId") or "")
                if parent and parent != service:
                    edges.add((parent, service))
    return edges


# --------------------------------------------------------------------------
# Generic fallback — any alert shape that isn't one of the four above
# --------------------------------------------------------------------------

# Accept whatever field name a given export happens to use for the same
# concept. Order matters: first match wins.
_SERVICE_KEYS = ("service", "service_name", "serviceName", "resource", "component", "host", "source", "app", "application")
_SEVERITY_KEYS = ("severity", "level", "priority", "status")
_TIME_KEYS = ("timestamp", "time", "ts", "created_at", "createdAt", "event_time", "eventTime", "date")
_MESSAGE_KEYS = ("message", "description", "text", "summary", "title", "reason", "details")
_ID_KEYS = ("id", "alert_id", "alertId", "uuid", "event_id")


def _first(payload: dict[str, Any], keys: tuple[str, ...]) -> Any:
    for key in keys:
        if payload.get(key) not in (None, ""):
            return payload[key]
    return None


def from_generic_records(payload: Any) -> list[Signal]:
    """Best-effort adapter for a shape none of the named sources match.

    Real hackathon input is a moving target — the brief itself warns the
    problem statement may swap live webhooks for a sample data file in
    whatever schema the organizers happened to export. Rather than betting
    the whole ingest path on the four documented source schemas above, this
    walks any flat list of alert-shaped dicts and matches common field-name
    variants for service, severity, timestamp and message. A record missing
    a mappable timestamp or service is skipped, same as every other adapter
    here - reduced signal quality beats a crashed ingest.
    """
    if isinstance(payload, dict):
        records = payload.get("alerts") or payload.get("signals") or payload.get("records") or payload.get("data") or payload.get("events")
        if records is None and any(k in payload for k in _SERVICE_KEYS + _TIME_KEYS):
            records = [payload]  # a single alert object, not wrapped in a list
        records = records or []
    elif isinstance(payload, list):
        records = payload
    else:
        records = []

    signals: list[Signal] = []
    for i, rec in enumerate(records):
        if not isinstance(rec, dict):
            continue
        try:
            ts = normalize_timestamp(_first(rec, _TIME_KEYS))
            service = str(_first(rec, _SERVICE_KEYS) or "unknown")
            message = str(_first(rec, _MESSAGE_KEYS) or "")
            raw_severity = str(_first(rec, _SEVERITY_KEYS) or "").strip().lower()
            severity = _SEVERITY_ALIASES.get(raw_severity, Severity.INFO)
            discriminator = str(_first(rec, _ID_KEYS) or f"{message[:40]}|{i}")

            signals.append(Signal(
                id=make_signal_id("generic", service, ts, discriminator),
                source=SignalSource.APP_LOG,
                service=service,
                severity=severity,
                timestamp=ts,
                message=message,
                labels={k: str(v) for k, v in rec.items() if isinstance(v, (str, int, float)) and k not in _SERVICE_KEYS},
            ))
        except Exception:
            continue
    return signals
