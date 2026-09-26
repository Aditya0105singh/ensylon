"""The golden incident: one fixed, reproducible failure for demos and tests.

Payloads are emitted in each source's native shape and go through the real
adapters, exactly like the randomised scenarios. Nothing here is random, so the
same click always tells the same story:

    postgres-primary connection pool saturated (CloudWatch alarm, 200/200)
      -> 12 "connection pool exhausted" errors on order-api (CloudWatch logs)
      -> order-api p99 latency breach (Grafana, carries the trace id)
      -> 3 downstream timeouts on checkout-bff / order-api / payment-svc (OTel)
    = 17 signals, ONE incident, root cause postgres-primary

plus one unrelated disk-usage alarm on log-archive that lands inside the same
minute and must be REJECTED by the shared-context gate (no shared service, no
dependency edge, no trace).
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from .scenarios import Scenario, Topology, _nano, _res_span

GOLDEN_INCIDENT_ID = "INC-golden-db_pool_exhaustion"
GOLDEN_TRACE_ID = "trace7a9f0c3e51d2"

GOLDEN_TOPOLOGY = Topology(
    name="golden-ecommerce",
    edges={
        "checkout-bff": ["order-api", "payment-svc"],
        "order-api": ["postgres-primary"],
        "payment-svc": ["postgres-primary"],
    },
    roles={
        "checkout-bff": "api", "order-api": "api", "payment-svc": "api",
        "postgres-primary": "datastore", "log-archive": "worker",
    },
    criticality={
        "checkout-bff": 1.0, "payment-svc": 1.0, "postgres-primary": 0.95,
        "order-api": 0.85, "log-archive": 0.2,
    },
)

_T0 = datetime(2026, 8, 26, 14, 2, 3, tzinfo=timezone.utc)


def _log_event(ts: datetime, i: int) -> dict:
    # Deterministic "random" numbers so the 12 lines differ but never change.
    in_use = 196 + (i * 7) % 5
    waiters = 14 + (i * 11) % 60
    return {
        "timestamp": int(ts.timestamp() * 1000),
        "message": f"ERROR connection pool exhausted: {in_use}/200 in use, waiters={waiters}",
        "logStreamName": f"order-api/task/{0xA10000 + i:06x}",
    }


def golden_scenario() -> Scenario:
    sc = Scenario(topology=GOLDEN_TOPOLOGY)
    sc.incident_count = 1
    t0 = _T0

    # 1. root cause: the CloudWatch alarm on postgres-primary
    sc.cloudwatch_alarms.append({
        "AlarmName": "postgres-primary-DatabaseConnections-alarm",
        "AlarmDescription": "connection pool saturated",
        "NewStateValue": "ALARM",
        "NewStateReason": (
            f"Threshold Crossed: 1 datapoint [200.0 ({t0.strftime('%d/%m/%y %H:%M:%S')})] "
            "was greater than the threshold (180.0)."
        ),
        "StateChangeTime": t0.isoformat().replace("+00:00", "Z"),
        "Region": "ap-south-1",
        "Trigger": {
            "MetricName": "DatabaseConnections", "Namespace": "AWS/RDS",
            "Statistic": "AVERAGE", "Threshold": 180.0,
            "ComparisonOperator": "GreaterThanThreshold",
            "Dimensions": [{"name": "ServiceName", "value": "postgres-primary"}],
        },
    })
    sc.mark("cloudwatch_metric", "postgres-primary", t0, GOLDEN_INCIDENT_ID, root=True)

    # 2. twelve identical application errors on order-api (dedup collapses them)
    events = []
    for i in range(12):
        ts = t0 + timedelta(seconds=8 + i * 4)
        events.append(_log_event(ts, i))
        sc.mark("cloudwatch_log", "order-api", ts, GOLDEN_INCIDENT_ID)
    sc.cloudwatch_logs.append({"logGroupName": "/aws/ecs/order-api", "events": events})

    # 3. Grafana p99 latency breach on order-api, carrying the trace id
    g_ts = t0 + timedelta(seconds=49)
    sc.grafana_batches.append({
        "receiver": "alertlens", "status": "firing",
        "alerts": [{
            "status": "firing",
            "labels": {
                "alertname": "HighLatencyP99", "service": "order-api",
                "severity": "critical", "trace_id": GOLDEN_TRACE_ID,
            },
            "annotations": {"description": "p99 latency 3200ms on order-api"},
            "startsAt": g_ts.isoformat(),
            "valueString": "[ var='B' labels={} value=3200.0 ]",
        }],
    })
    sc.mark("grafana_alert", "order-api", g_ts, GOLDEN_INCIDENT_ID)

    # 4. three downstream timeouts sharing the trace. Parent = caller, child =
    # callee, so the edges the engine learns point the right way.
    err = "upstream timeout acquiring connection"
    spans = [
        ("checkout-bff", "sp001", None, t0 + timedelta(seconds=67)),
        ("order-api", "sp002", "sp001", t0 + timedelta(seconds=76)),
        ("payment-svc", "sp003", "sp001", t0 + timedelta(seconds=85)),
    ]
    resource_spans = []
    for svc, span_id, parent, ts in spans:
        span = {
            "traceId": GOLDEN_TRACE_ID, "spanId": span_id,
            "name": f"{svc} call", "startTimeUnixNano": _nano(ts),
            "status": {"code": 2, "message": err},
        }
        if parent:
            span["parentSpanId"] = parent
        resource_spans.append(_res_span(svc, [span]))
        sc.mark("trace_span", svc, ts, GOLDEN_INCIDENT_ID)
    # Healthy leaf spans: not symptoms, but they teach the graph who calls the DB.
    for svc, span_id, parent in (("postgres-primary", "sp004", "sp002"),
                                 ("postgres-primary", "sp005", "sp003")):
        resource_spans.append(_res_span(svc, [{
            "traceId": GOLDEN_TRACE_ID, "spanId": span_id, "parentSpanId": parent,
            "name": "SELECT", "startTimeUnixNano": _nano(t0 + timedelta(seconds=60)),
            "status": {"code": 1},
        }]))
    sc.otlp_traces.append({"resourceSpans": resource_spans})

    # 5. the decoy: an unrelated disk alarm inside the same minute
    d_ts = t0 + timedelta(seconds=79)
    sc.cloudwatch_alarms.append({
        "AlarmName": "log-archive-DiskUsage-alarm",
        "AlarmDescription": "DiskUsageWarning",
        "NewStateValue": "ALARM",
        "NewStateReason": (
            f"Threshold Crossed: 1 datapoint [86.0 ({d_ts.strftime('%d/%m/%y %H:%M:%S')})] "
            "was greater than the threshold (80.0)."
        ),
        "StateChangeTime": d_ts.isoformat().replace("+00:00", "Z"),
        "Region": "ap-south-1",
        "Trigger": {
            "MetricName": "DiskUsage", "Namespace": "CWAgent",
            "Statistic": "AVERAGE", "Threshold": 80.0,
            "ComparisonOperator": "GreaterThanThreshold",
            "Dimensions": [{"name": "ServiceName", "value": "log-archive"}],
        },
    })
    sc.mark("cloudwatch_metric", "log-archive", d_ts, None)

    sc.manifest.append({
        "incident": GOLDEN_INCIDENT_ID, "archetype": "db_pool_exhaustion",
        "root": "postgres-primary", "telemetry": "full", "signals": 17,
    })
    return sc


# --------------------------------------------------------------------------
# suppression demos
# --------------------------------------------------------------------------


def flapping_scenario() -> Scenario:
    """One service repeatedly crossing a threshold and recovering.

    payment-svc CPU alarms fire four times, six minutes apart (recoveries are not
    signals). Without flap handling that is four tickets; the engine reports ONE
    incident with a flap count.
    """
    sc = Scenario(topology=GOLDEN_TOPOLOGY)
    sc.incident_count = 1
    incident = "INC-flap-payment-cpu"
    for i in range(4):
        ts = _T0 + timedelta(minutes=6 * i)
        sc.cloudwatch_alarms.append({
            "AlarmName": "payment-svc-CPUUtilization-alarm",
            "AlarmDescription": "CPU above threshold",
            "NewStateValue": "ALARM",
            "NewStateReason": (
                f"Threshold Crossed: 1 datapoint [{91.0 + i}.0 ({ts.strftime('%d/%m/%y %H:%M:%S')})] "
                "was greater than the threshold (85.0)."
            ),
            "StateChangeTime": ts.isoformat().replace("+00:00", "Z"),
            "Region": "ap-south-1",
            "Trigger": {
                "MetricName": "CPUUtilization", "Namespace": "AWS/ECS", "Statistic": "AVERAGE",
                "Threshold": 85.0, "ComparisonOperator": "GreaterThanThreshold",
                "Dimensions": [{"name": "ServiceName", "value": "payment-svc"}],
            },
        })
        sc.mark("cloudwatch_metric", "payment-svc", ts, incident, root=(i == 0))
    sc.manifest.append({"incident": incident, "archetype": "flapping_cpu", "root": "payment-svc",
                        "telemetry": "metrics", "signals": 4})
    return sc


def maintenance_windows():
    """A declared deploy window covering every service in the golden incident."""
    from .severity import MaintenanceWindow

    return [MaintenanceWindow(
        services={"postgres-primary", "order-api", "payment-svc", "checkout-bff"},
        start=_T0 - timedelta(minutes=30), end=_T0 + timedelta(minutes=60),
        reason="planned database failover drill",
    )]
