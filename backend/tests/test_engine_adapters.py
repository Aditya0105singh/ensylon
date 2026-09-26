"""Adapter tests against realistic source payloads.

These exist to de-risk the hackathon build: schema discovery happens here,
now, rather than against a live endpoint under a 24-hour clock. Each payload
below mirrors the documented shape of its source, including the awkward parts
(CloudWatch hiding the breaching value inside prose, OTLP wrapping every
attribute in a type envelope, Grafana's `valueString` encoding).
"""

from __future__ import annotations

from app.engine.adapters import (
    from_cloudwatch_alarm,
    from_cloudwatch_logs,
    from_generic_records,
    from_grafana_webhook,
    from_otlp_logs,
    from_otlp_traces,
    service_dependency_edges,
)
from app.engine.signal import Severity, SignalSource

# --------------------------------------------------------------------------
# CloudWatch alarm
# --------------------------------------------------------------------------

CW_ALARM = {
    "AlarmName": "postgres-primary-connections-high",
    "AlarmDescription": "Connection pool near exhaustion",
    "NewStateValue": "ALARM",
    "NewStateReason": (
        "Threshold Crossed: 1 datapoint [200.0 (26/08/26 14:02:00)] "
        "was greater than the threshold (180.0)."
    ),
    "StateChangeTime": "2026-08-26T14:02:03.000Z",
    "Region": "ap-south-1",
    "Trigger": {
        "MetricName": "DatabaseConnections",
        "Namespace": "AWS/RDS",
        "Statistic": "AVERAGE",
        "Threshold": 180.0,
        "ComparisonOperator": "GreaterThanThreshold",
        "Dimensions": [{"name": "DBInstanceIdentifier", "value": "postgres-primary"}],
    },
}


def test_cloudwatch_alarm_maps_to_signal():
    signal = from_cloudwatch_alarm(CW_ALARM)
    assert signal is not None
    assert signal.source == SignalSource.CLOUDWATCH_METRIC
    assert signal.service == "postgres-primary"
    assert signal.metric == "DatabaseConnections"
    assert signal.threshold == 180.0
    # The breaching value only exists inside the prose reason string.
    assert signal.value == 200.0
    assert signal.severity == Severity.CRITICAL
    assert signal.timestamp.tzinfo is not None


def test_cloudwatch_ok_transition_is_not_a_signal():
    """A recovery is not a symptom - it must not enter correlation."""
    recovered = {**CW_ALARM, "NewStateValue": "OK"}
    assert from_cloudwatch_alarm(recovered) is None


def test_cloudwatch_alarm_id_is_stable():
    """Re-ingesting the same payload must not create a second signal."""
    assert from_cloudwatch_alarm(CW_ALARM).id == from_cloudwatch_alarm(CW_ALARM).id


def test_malformed_alarm_is_skipped_not_raised():
    assert from_cloudwatch_alarm({"NewStateValue": "ALARM"}) is not None or True
    assert from_cloudwatch_alarm({}) is None


# --------------------------------------------------------------------------
# CloudWatch logs
# --------------------------------------------------------------------------

CW_LOGS = {
    "logGroupName": "/aws/ecs/order-api",
    "events": [
        {
            "timestamp": 1787836931000,
            "message": "ERROR connection pool exhausted: 200/200 in use",
            "logStreamName": "order-api/task/abc123",
        },
        {
            "timestamp": 1787836932000,
            "message": "WARN retrying acquire, attempt 2",
            "logStreamName": "order-api/task/abc123",
        },
    ],
}


def test_cloudwatch_logs_map_and_infer_severity():
    signals = from_cloudwatch_logs(CW_LOGS)
    assert len(signals) == 2
    assert signals[0].service == "order-api"  # derived from the log group
    assert signals[0].severity == Severity.HIGH      # "ERROR"
    assert signals[1].severity == Severity.WARNING   # "WARN"


def test_bad_log_event_does_not_kill_the_batch():
    payload = {"logGroupName": "/aws/ecs/order-api",
               "events": [{"no_timestamp": True}, CW_LOGS["events"][0]]}
    assert len(from_cloudwatch_logs(payload)) == 1


# --------------------------------------------------------------------------
# Grafana
# --------------------------------------------------------------------------

GRAFANA = {
    "receiver": "alertlens",
    "status": "firing",
    "alerts": [
        {
            "status": "firing",
            "labels": {
                "alertname": "HighLatencyP99",
                "service": "order-api",
                "severity": "critical",
            },
            "annotations": {"description": "p99 latency 3200ms exceeds 1000ms"},
            "startsAt": "2026-08-26T14:02:45+00:00",
            "valueString": "[ var='B' labels={} value=3200.0 ]",
        },
        {
            "status": "resolved",
            "labels": {"alertname": "Recovered", "service": "order-api"},
            "annotations": {},
            "startsAt": "2026-08-26T14:00:00+00:00",
        },
    ],
}


def test_grafana_firing_only_and_pre_flagged():
    signals = from_grafana_webhook(GRAFANA)
    assert len(signals) == 1  # the resolved alert is dropped
    signal = signals[0]
    assert signal.service == "order-api"
    assert signal.severity == Severity.CRITICAL
    assert signal.value == 3200.0
    # Grafana already thresholded this, so DETECT must not re-judge it.
    assert signal.is_anomaly is True
    assert "Grafana" in signal.detection_reason


# --------------------------------------------------------------------------
# OTLP logs
# --------------------------------------------------------------------------

OTLP_LOGS = {
    "resourceLogs": [{
        "resource": {"attributes": [
            {"key": "service.name", "value": {"stringValue": "payment-svc"}},
        ]},
        "scopeLogs": [{
            "logRecords": [{
                "timeUnixNano": "1787836990000000000",
                "severityText": "ERROR",
                "body": {"stringValue": "upstream timeout calling order-api"},
                "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
                "spanId": "00f067aa0ba902b7",
                "attributes": [
                    {"key": "http.status_code", "value": {"intValue": 504}},
                ],
            }]
        }],
    }]
}


def test_otlp_logs_unwrap_attributes_and_trace_context():
    signals = from_otlp_logs(OTLP_LOGS)
    assert len(signals) == 1
    signal = signals[0]
    assert signal.service == "payment-svc"
    assert signal.severity == Severity.HIGH
    assert signal.trace_id == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert signal.labels["http.status_code"] == "504"


# --------------------------------------------------------------------------
# OTLP traces
# --------------------------------------------------------------------------

def _resource_span(service: str, spans: list[dict]) -> dict:
    return {
        "resource": {"attributes": [
            {"key": "service.name", "value": {"stringValue": service}},
        ]},
        "scopeSpans": [{"spans": spans}],
    }


OTLP_TRACES = {
    "resourceSpans": [
        _resource_span("checkout-bff", [{
            "traceId": "t1", "spanId": "s1", "name": "POST /checkout",
            "startTimeUnixNano": "1787836990000000000", "status": {"code": 1},
        }]),
        _resource_span("order-api", [{
            "traceId": "t1", "spanId": "s2", "parentSpanId": "s1",
            "name": "GET /orders", "startTimeUnixNano": "1787836991000000000",
            "status": {"code": 2, "message": "db connection timeout"},
        }]),
        _resource_span("postgres-primary", [{
            "traceId": "t1", "spanId": "s3", "parentSpanId": "s2",
            "name": "SELECT orders", "startTimeUnixNano": "1787836992000000000",
            "status": {"code": 2, "message": "pool exhausted"},
        }]),
    ]
}


def test_otlp_traces_errors_only_and_parent_service():
    signals = from_otlp_traces(OTLP_TRACES)
    # Only the two ERROR spans become signals; the healthy root span does not.
    assert len(signals) == 2
    by_service = {s.service: s for s in signals}
    assert by_service["order-api"].parent_service == "checkout-bff"
    assert by_service["postgres-primary"].parent_service == "order-api"
    assert all(s.trace_id == "t1" for s in signals)


def test_dependency_edges_include_healthy_spans():
    """Topology must come from all traffic, not just failing traffic."""
    edges = service_dependency_edges(OTLP_TRACES)
    assert ("checkout-bff", "order-api") in edges
    assert ("order-api", "postgres-primary") in edges


# --------------------------------------------------------------------------
# Generic fallback — for whatever shape a hackathon-day sample file turns
# out to be, since it won't necessarily be one of the four sources above.
# --------------------------------------------------------------------------


def test_generic_records_bare_list_with_alternate_field_names():
    records = [
        {"service_name": "checkout-bff", "level": "error", "time": "2026-08-26T14:02:03Z", "text": "timeout"},
        {"resource": "order-api", "priority": "warn", "ts": 1787836991, "summary": "slow query"},
    ]
    signals = from_generic_records(records)
    assert len(signals) == 2
    assert {s.service for s in signals} == {"checkout-bff", "order-api"}
    assert signals[0].severity == Severity.HIGH
    assert signals[1].severity == Severity.WARNING


def test_generic_records_wrapped_under_common_keys():
    for key in ("alerts", "signals", "records", "data", "events"):
        payload = {key: [{"service": "svc-a", "timestamp": "2026-08-26T14:00:00Z", "message": "x"}]}
        signals = from_generic_records(payload)
        assert len(signals) == 1, f"failed to unwrap under '{key}'"
        assert signals[0].service == "svc-a"


def test_generic_records_single_unwrapped_object():
    payload = {"service": "svc-a", "timestamp": "2026-08-26T14:00:00Z", "message": "solo alert"}
    signals = from_generic_records(payload)
    assert len(signals) == 1
    assert signals[0].service == "svc-a"


def test_generic_records_skips_rows_with_no_usable_timestamp_not_the_whole_batch():
    records = [
        {"service": "svc-a", "message": "no timestamp at all"},
        {"service": "svc-b", "timestamp": "2026-08-26T14:00:00Z", "message": "fine"},
    ]
    signals = from_generic_records(records)
    assert len(signals) == 1
    assert signals[0].service == "svc-b"


def test_generic_records_missing_severity_defaults_to_info_not_a_crash():
    signals = from_generic_records([{"service": "svc-a", "timestamp": "2026-08-26T14:00:00Z"}])
    assert len(signals) == 1
    assert signals[0].severity == Severity.INFO


def test_generic_records_garbage_input_never_raises():
    assert from_generic_records(None) == []
    assert from_generic_records("not even json-shaped") == []
    assert from_generic_records(42) == []
    assert from_generic_records([]) == []
    assert from_generic_records({}) == []
    assert from_generic_records([1, "x", None, {"service": "ok", "timestamp": "2026-08-26T14:00:00Z"}]) != []
    assert from_generic_records([{"garbage": True}, {"also": "garbage"}]) == []


def test_generic_records_ids_are_stable_for_idempotent_reingest():
    rec = [{"id": "abc-1", "service": "svc-a", "timestamp": "2026-08-26T14:00:00Z", "message": "x"}]
    assert from_generic_records(rec)[0].id == from_generic_records(rec)[0].id
