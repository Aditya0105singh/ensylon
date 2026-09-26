"""End-to-end proof of rule #1: no raw PII in storage, logs or tickets.

Plant identifiable values in all three stream formats, run a full session
through the same path production uses (reader -> parser -> engine -> drafts ->
review -> ticket files, plus the recording), then scan EVERY artefact for the
planted values and for the PII shapes. One survivor anywhere fails the test.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine import recording  # noqa: E402
from app.engine.evidence import build_evidence  # noqa: E402
from app.engine.live import FALLBACK_GRAPH, StreamReader, criticality_map, graph_from_adjacency, iter_sse  # noqa: E402
from app.engine.review import ReviewQueue  # noqa: E402
from app.engine.stream import StreamEngine  # noqa: E402
from app.engine.tickets import FileTicketTransport  # noqa: E402

KNOWN = sorted(FALLBACK_GRAPH)

# Everything below is planted on purpose. None of it may appear in any artefact.
EMAILS = ["neha.joshi@acmecorp.com", "vikram.singh@acmecorp.com"]
NAMES = ["Neha Joshi", "Rohan Mehta", "Sean O'Brien", "Priya Nair"]
IPS = ["10.0.2.83", "203.0.113.9", "192.168.7.41", "2001:db8::8a2e:370:7334"]
SESSIONS = ["sess_kd3dxt", "sess_58917o", "9f8e7d6c5b4a"]
ACCOUNTS = ["ACC-10000055", "ACC-10000181", "4599120037"]
CLOUD = ["456789012345"]
SERVICE_ACCOUNTS = ["svc-payments@internal.corp.com", "svc_batch@internal.corp.com"]
PHONES = ["98765 43210", "9123456780", "7911 123456"]
DOMAINS = ["acmecorp.com", "internal.corp.com"]
PLANTED = EMAILS + NAMES + IPS + SESSIONS + ACCOUNTS + CLOUD + SERVICE_ACCOUNTS + PHONES + DOMAINS

SHAPES = {
    "email": re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    "ipv4": re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])"),
    "session": re.compile(r"\bsess_[A-Za-z0-9]+\b"),
    "account": re.compile(r"\bACC-\d{4,}\b"),
    "cloud_account": re.compile(r"(?<![\d.-])\d{12}(?![\d.-])"),
}


def _cw(ts, service, component, value, threshold):
    return {
        "AlarmName": f"High-{service}",
        "AlarmDescription": f"pool utilisation high - affects {SERVICE_ACCOUNTS[0]} and {SERVICE_ACCOUNTS[1]}",
        "StateChangeTime": ts, "Region": "ap-south-1", "NewStateValue": "ALARM", "OldStateValue": "OK",
        "Trigger": {"MetricName": "DBConnectionCount", "Namespace": "AWS/RDS", "Threshold": threshold,
                    "ObservedValue": value, "Statistic": "AVERAGE", "Period": 60, "EvaluationPeriods": 3,
                    "Dimensions": [{"name": "DBInstanceIdentifier", "value": "prod-payments-db"}]},
        "AffectedResources": {"service": service, "component": component, "environment": "prod",
                              "region": "ap-south-1", "accountId": CLOUD[0], "serviceAccount": SERVICE_ACCOUNTS[0]},
    }


def _gf(service):
    return {
        "title": f"High Latency — {service}", "state": "alerting", "ruleName": f"HighLatency-{service}",
        "evalMatches": [{"metric": "response_time_p99", "value": 4785,
                         "tags": {"service": service, "environment": "prod", "host": IPS[0]}}],
        "message": f"P99 4785ms above the 4000ms threshold. Last affected user: {EMAILS[1]} "
                   f"(acc: {ACCOUNTS[1]}, session: {SESSIONS[1]}) from {IPS[1]}",
        "tags": {"environment": "prod", "region": "ap-south-1"},
    }


def _logs():
    ctx = f"user:{EMAILS[0]} ip:{IPS[0]} session:{SESSIONS[0]} acc:{ACCOUNTS[0]}"
    return [
        f"2026-09-26T10:01:05Z ERROR payments-service db-connection-pool [{ctx}] "
        f"Connection pool exhausted. Pool size: 100, waiting threads: 22",
        f"2026-09-26T10:01:07Z ERROR payments-service db-connection-pool [{ctx}] "
        f"Premium collection failed for {NAMES[1]} - no DB connection; call +91 {PHONES[0]}",
        f"2026-09-26T10:01:09Z ERROR payments-service db-connection-pool [ip:{IPS[3]}] "
        f"Refund for {NAMES[3]} failed, sms to {PHONES[2]} account {ACCOUNTS[2]} sessionId: {SESSIONS[2]}",
        f"2026-09-26T10:01:48Z ERROR enrollment-service api-handler [host:enrollment-prod-02] "
        f"Circuit breaker OPEN for payments-service after 27 consecutive failures; customer {NAMES[2]} on {IPS[2]} "
        f"reachable at {PHONES[1]}",
    ]


def _sse(events):
    out = []
    for i, data in enumerate(events, 1):
        payload = data if isinstance(data, str) else json.dumps(data)
        out += [f"id: {i:06d}", "event: signal", f"data: {payload}", ""]
    return out


def _feed(reader, events):
    for ev in iter_sse(iter(_sse(events))):
        reader.handle(ev)


def _strings_of(obj) -> str:
    return json.dumps(obj, default=str, ensure_ascii=False)


def _scan(label: str, text: str, problems: list[str]) -> None:
    for token in PLANTED:
        if token in text:
            problems.append(f"{label}: planted value {token!r} survived")
    for name, rx in SHAPES.items():
        for m in rx.findall(text):
            if "REDACTED" not in m:
                problems.append(f"{label}: {name}-shaped value {m!r} survived")
                break


def test_no_pii_in_any_artefact(tmp_path, caplog):
    caplog.set_level(logging.DEBUG)
    tickets = tmp_path / "tickets"
    engine = StreamEngine(graph_from_adjacency(FALLBACK_GRAPH), criticality_map(),
                          queue=ReviewQueue(transport=FileTicketTransport(tickets)))
    rec = recording.Recorder.new_session("test://fake", tmp_path / "rec")

    readers = {}
    for name in ("aiops-logs", "aiops-cloudwatch", "aiops-grafana"):
        r = StreamReader(name, engine, KNOWN, threading.Event())
        r.recorder = rec
        readers[name] = r
    _feed(readers["aiops-logs"], _logs())
    _feed(readers["aiops-cloudwatch"], [_cw("2026-09-26T10:01:00Z", "agency-db", "db-connection-pool", 97.0, 90),
                                        _cw("2026-09-26T10:01:30Z", "payments-service", "db-connection-pool", 95.0, 90)])
    _feed(readers["aiops-grafana"], [_gf("enrollment-service")])
    engine.tick()
    assert engine.result.incidents, "the scenario must form an incident, or the scan proves nothing"

    # a human approves with an edit that pastes PII into the ticket
    draft_id = engine.result.incidents[0].draft.draft_id
    engine.queue.approve(draft_id, "Aditya", {
        "summary": f"Called {NAMES[1]} on +91 {PHONES[0]} and mailed {EMAILS[0]} about {SESSIONS[0]}",
        "investigation_steps": [f"Check {IPS[0]} first", "Inspect payments-service"],
    })
    rec.close()

    problems: list[str] = []
    _scan("canonical feed", _strings_of(list(engine.canonical)), problems)
    _scan("signals", _strings_of([s.model_dump(mode="json") for s in engine.result.signals]), problems)
    _scan("pending", _strings_of([s.model_dump(mode="json") for s in engine.pending]), problems)
    _scan("status", _strings_of(engine.status()), problems)
    _scan("metrics", _strings_of(engine.metrics()), problems)
    for inc in engine.result.incidents:
        _scan("evidence", _strings_of(build_evidence(inc, engine.graph, engine.result.noise)), problems)
        _scan("draft ticket", _strings_of(inc.draft.to_ticket()), problems)
        _scan("draft markdown", inc.draft.render_markdown(), problems)
    for item in engine.queue.items.values():
        _scan("queue draft", _strings_of(item.draft.__dict__), problems)
        _scan("queue history", _strings_of(item.history), problems)
    _scan("audit", "\n".join(a.render() for a in engine.queue.audit), problems)
    files = sorted(tickets.glob("*"))
    assert files, "approval must have written the ticket files"
    for f in files:
        _scan(f"ticket file {f.name}", f.read_text(encoding="utf-8"), problems)
    for f in sorted((tmp_path / "rec").glob("*.jsonl")):
        _scan(f"recording {f.name}", f.read_text(encoding="utf-8"), problems)
    _scan("log output", caplog.text, problems)

    assert not problems, "PII leaked:\n  " + "\n  ".join(problems)


def test_the_scan_itself_detects_a_leak():
    """The scanner must be able to fail, or a clean result means nothing."""
    problems: list[str] = []
    _scan("probe", f"contact {EMAILS[0]} from {IPS[0]}", problems)
    assert len(problems) >= 2
