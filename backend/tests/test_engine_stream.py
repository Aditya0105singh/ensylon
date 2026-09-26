"""Streaming runtime: SSE framing, micro-batch incidents, silence, late attach."""

import json

from app.engine.live import (
    FALLBACK_GRAPH,
    StreamReader,
    criticality_map,
    graph_from_adjacency,
    iter_sse,
)
from app.engine.stream import StreamEngine

KNOWN = sorted(FALLBACK_GRAPH)


def _engine():
    return StreamEngine(graph_from_adjacency(FALLBACK_GRAPH), criticality_map())


def _reader(engine, name):
    import threading
    return StreamReader(name, engine, KNOWN, threading.Event())


def _cw(ts, service, component, value, threshold=90, state="ALARM"):
    return {
        "AlarmName": f"High-{service}", "AlarmDescription": "pool utilisation high",
        "StateChangeTime": ts, "Region": "ap-south-1", "NewStateValue": state, "OldStateValue": "OK",
        "Trigger": {"MetricName": "DBConnectionCount", "Namespace": "AWS/RDS", "Threshold": threshold,
                    "ObservedValue": value, "Statistic": "AVERAGE", "Period": 60, "EvaluationPeriods": 3},
        "AffectedResources": {"service": service, "component": component, "environment": "prod",
                              "region": "ap-south-1", "accountId": "456789012345",
                              "serviceAccount": "svc-payments@internal.corp.com"},
    }


def _gf(service, state="alerting"):
    return {
        "title": f"High Latency — {service}", "state": state, "ruleName": f"HighLatency-{service}",
        "evalMatches": [{"metric": "response_time_p99", "value": 4785,
                         "tags": {"service": service, "environment": "prod", "host": "10.0.4.56"}}],
        "message": "P99 4785ms above the 4000ms threshold. Last affected user: priya.sharma@acmecorp.com",
        "tags": {"environment": "prod", "region": "ap-south-1"},
    }


def _sse(events):
    out = []
    for i, data in enumerate(events, 1):
        if data is None:
            out += [":keepalive", ""]
            continue
        payload = data if isinstance(data, str) else json.dumps(data)
        out += [f"id: {i:06d}", "event: signal", f"data: {payload}", ""]
    return out


def test_sse_framing_ignores_keepalives_and_keeps_ids():
    comments = []
    events = list(iter_sse(iter(["id: 000042", "event: signal", "data: {\"a\": 1}", "",
                                 ":keepalive", "", "id: 000043", "event: signal", "data: x", ""]),
                           comments.append))
    assert [e.id for e in events] == ["000042", "000043"]
    assert events[0].data == '{"a": 1}' and comments == ["keepalive"]


def test_silence_raises_nothing():
    engine = _engine()
    for _ in range(5):
        summary = engine.tick()
    assert summary["new_incidents"] == 0
    assert engine.result.incidents == [] and engine.status()["signals_received"] == 0


def test_cascade_becomes_one_validated_incident_without_pii():
    engine = _engine()
    logs = _reader(engine, "aiops-logs")
    cw = _reader(engine, "aiops-cloudwatch")
    gf = _reader(engine, "aiops-grafana")

    for ev in iter_sse(iter(_sse([
        _cw("2026-09-26T10:01:00Z", "agency-db", "db-connection-pool", 97.0),
        None,
    ]))):
        cw.handle(ev)
    for ev in iter_sse(iter(_sse([
        "2026-09-26T10:01:05Z ERROR payments-service db-connection-pool [user:neha.joshi@acmecorp.com "
        "ip:10.0.2.83 session:sess_kd3dxt acc:ACC-10000055] Connection pool exhausted. Pool size: 100",
        "2026-09-26T10:01:48Z ERROR enrollment-service api-handler [host:enrollment-prod-02] "
        "Circuit breaker OPEN for payments-service after 27 consecutive failures",
    ]))):
        logs.handle(ev)
    for ev in iter_sse(iter(_sse([_gf("enrollment-service"), _gf("docforge", state="ok")]))):
        gf.handle(ev)

    assert logs.status.last_event_id == "000002"
    assert gf.status.skipped == 1            # state ok is not a symptom
    engine.tick()

    assert len(engine.result.incidents) == 1
    incident = engine.result.incidents[0]
    services = set(incident.cluster.services)
    assert {"agency-db", "payments-service"} <= services
    assert 0.0 <= incident.cluster.confidence <= 1.0
    assert 0 <= incident.severity.impact <= 100
    assert incident.cluster.validation, "validation checks must be recorded"
    assert engine.queue.items[incident.draft.draft_id]

    feed = json.dumps(list(engine.canonical))
    for pii in ("neha", "priya", "10.0.", "sess_", "ACC-", "456789012345", "svc-payments@"):
        assert pii not in feed


def test_late_signal_joins_the_open_incident():
    engine = _engine()
    for s in [
        _cw("2026-09-26T10:01:00Z", "agency-db", "db-connection-pool", 97.0),
        _cw("2026-09-26T10:01:30Z", "payments-service", "db-connection-pool", 95.0),
    ]:
        _reader(engine, "aiops-cloudwatch").handle(next(iter_sse(iter(_sse([s])))))
    engine.tick()
    assert len(engine.result.incidents) == 1
    before = len(engine.result.incidents[0].cluster.signals)

    line = ("2026-09-26T10:03:00Z ERROR payments-service db-connection-pool [] "
            "Connection pool exhausted. Pool size: 100")
    _reader(engine, "aiops-logs").handle(next(iter_sse(iter(_sse([line])))))
    summary = engine.tick()
    assert summary["attached"] == 1 and len(engine.result.incidents) == 1
    assert len(engine.result.incidents[0].cluster.signals) == before + 1


def test_lone_signal_expires_as_noise():
    engine = _engine()
    _reader(engine, "aiops-cloudwatch").handle(
        next(iter_sse(iter(_sse([_cw("2026-09-26T10:01:00Z", "docforge", "renderer", 99.0)])))))
    engine.tick()
    assert engine.result.incidents == [] and engine.status()["pending"] == 1
    engine.observe_event_time(engine.now().replace(hour=11))
    engine.tick()
    assert engine.status()["pending"] == 0 and len(engine.result.noise) == 1


# ---------------------------------------------------------------- C5 tickets

def _one_incident_engine(tmp_path):
    from app.engine.review import ReviewQueue
    from app.engine.tickets import FileTicketTransport

    engine = StreamEngine(graph_from_adjacency(FALLBACK_GRAPH), criticality_map(),
                          queue=ReviewQueue(transport=FileTicketTransport(tmp_path)))
    for s in [_cw("2026-09-26T10:01:00Z", "agency-db", "db-connection-pool", 97.0),
              _cw("2026-09-26T10:01:30Z", "payments-service", "db-connection-pool", 95.0)]:
        _reader(engine, "aiops-cloudwatch").handle(next(iter_sse(iter(_sse([s])))))
    engine.tick()
    assert len(engine.result.incidents) == 1
    return engine, engine.result.incidents[0].draft.draft_id


def test_nothing_is_written_before_approval(tmp_path):
    engine, draft_id = _one_incident_engine(tmp_path)
    assert list(tmp_path.glob("*")) == []
    draft = engine.queue.items[draft_id].draft
    assert draft.facts and draft.suspected_root_cause.startswith("Suspected")
    assert {e.source for e in draft.timeline} == {"cloudwatch_metrics"}


def test_edit_and_approve_writes_the_edited_ticket(tmp_path):
    import pytest

    engine, draft_id = _one_incident_engine(tmp_path)
    with pytest.raises(ValueError):
        engine.queue.approve(draft_id, "priya", {"severity_score": 0.01})   # computed, not editable
    assert list(tmp_path.glob("*")) == []

    item = engine.queue.approve(draft_id, "priya", {"title": "DB pool exhausted", "priority": "P2"})
    ticket = json.loads((tmp_path / f"{item.jira_key}.json").read_text(encoding="utf-8"))
    assert ticket["approved_by"] == "priya"
    assert ticket["ticket"]["title"] == "DB pool exhausted"
    assert ticket["ticket"]["severity"]["priority"] == "P2"
    for key in ("timeline", "facts", "suspected_root_cause", "investigation_steps", "correlation_confidence"):
        assert key in ticket["ticket"]
    md = (tmp_path / f"{item.jira_key}.md").read_text(encoding="utf-8")
    assert "Suspected root cause" in md and "## Facts" in md
    # idempotent: approving again never writes a second ticket
    engine.queue.jira.create_issue(item.draft, None)
    assert len(list(tmp_path.glob("*.json"))) == 1


def test_rejected_draft_writes_nothing(tmp_path):
    engine, draft_id = _one_incident_engine(tmp_path)
    engine.queue.reject(draft_id, "priya", "not an incident")
    assert list(tmp_path.glob("*")) == []


def test_claude_reply_must_stay_grounded(tmp_path, monkeypatch):
    from app.engine import claude_drafting

    engine, draft_id = _one_incident_engine(tmp_path)
    draft = engine.queue.items[draft_id].draft
    root = draft.root_cause_service
    good = {"summary": f"{root} exhausted its pool.", "suspected_root_cause": f"Suspected: {root}.",
            "investigation_steps": [f"Check {root}."]}
    assert claude_drafting._grounded(good, draft) is None
    invented = {**good, "investigation_steps": ["Restart billing-service."]}
    assert "outside the incident" in claude_drafting._grounded(invented, draft)
    wrong_root = {**good, "suspected_root_cause": "Suspected: a network blip."}
    assert claude_drafting._grounded(wrong_root, draft)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert claude_drafting.narrate(draft) is None     # no key -> template, no call


# ---------------------------------------------------------------- metrics / dedup

def test_repeats_collapse_across_batches_and_metrics_are_measured():
    engine = _engine()
    cw = _reader(engine, "aiops-cloudwatch")
    # the same lone condition fires in three separate micro-batches
    for ts in ("10:01:00Z", "10:02:00Z", "10:03:00Z"):
        cw.handle(next(iter_sse(iter(_sse([_cw(f"2026-09-26T{ts}", "docforge", "renderer", 99.0)])))))
        engine.tick()
    assert len(engine.pending) == 1 and engine.pending[0].occurrence_count == 3

    m = engine.metrics()
    assert m["dedup"]["received"] == 3 and m["dedup"]["distinct"] == 1 and m["dedup"]["collapsed"] == 2
    assert m["top_repeats"][0]["count"] == 3 and m["top_repeats"][0]["service"] == "docforge"
    assert sum(b["count"] for b in m["score_histogram"]) == 3
    assert sum(r.get("cloudwatch_metrics", 0) for r in m["timeline"]) == 3
    assert sum(r.get("anomalous", 0) for r in m["timeline"]) == 3
