"""The incident archive: what broke, who signed off, and when - kept for the review a day later."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import engine_api  # noqa: E402
from app.engine import archive  # noqa: E402
from app.engine.review import ReviewQueue  # noqa: E402
from app.main import app  # noqa: E402

REVIEWER = {"actor": "Neha Joshi", "actor_email": "neha.joshi@ensylon.com"}


@pytest.fixture()
def live_archive(isolated_db, monkeypatch):
    """Archive on, and sign-off rules as on a live run (email required)."""
    monkeypatch.setattr(engine_api, "_ARCHIVE", True)
    monkeypatch.setattr(engine_api, "_REQUIRE_EMAIL", True)
    c = TestClient(app)
    draft = c.post("/engine/golden").json()["queue"][0]["draft_id"]
    return c, draft


def _restart_and_rebuild(c):
    """A restart: memory gone, the engine rebuilds the same incidents from its
    input (the stream recording on a live run; the deterministic scenario here)."""
    engine_api._state.result = None
    engine_api._state.queue = ReviewQueue()
    c.post("/engine/golden")


def test_a_live_sign_off_needs_a_name_and_a_valid_email(live_archive):
    c, d = live_archive
    no_email = c.post(f"/engine/queue/{d}/approve", json={"actor": "Neha Joshi"})
    assert no_email.status_code == 400 and "email" in no_email.json()["detail"]
    bad = c.post(f"/engine/queue/{d}/approve", json={"actor": "Neha Joshi", "actor_email": "neha"})
    assert bad.status_code == 400
    assert c.get(f"/engine/queue/{d}").json()["status"] == "awaiting_review"   # nothing happened


def test_an_approval_is_archived_with_who_when_and_what_changed(live_archive):
    c, d = live_archive
    title_before = c.get(f"/engine/queue/{d}").json()["title"]
    r = c.post(f"/engine/queue/{d}/approve", json={**REVIEWER, "edits": {"title": "DB pool exhausted on agency-db"}})
    assert r.status_code == 200 and r.json()["reviewer"] == "Neha Joshi <neha.joshi@ensylon.com>"

    listed = c.get("/engine/history").json()
    assert [i["draft_id"] for i in listed] == [d]
    assert listed[0]["status"] == "published"
    assert listed[0]["decided_by"] == {"name": "Neha Joshi", "email": "neha.joshi@ensylon.com"}
    assert listed[0]["ticket_key"] == r.json()["jira_key"]

    record = c.get(f"/engine/history/{d}").json()
    assert record["detail"]["title"] == "DB pool exhausted on agency-db"
    assert record["evidence"]["signals"], "the evidence behind the incident is kept"
    actions = [a["action"] for a in record["audit"]]
    assert actions == ["raised", "edit_and_approve"]
    signed = record["audit"][-1]
    assert signed["actor"] == {"name": "Neha Joshi", "email": "neha.joshi@ensylon.com"}
    assert signed["changes"] == {"title": {"before": title_before, "after": "DB pool exhausted on agency-db"}}


def test_decisions_survive_a_restart_without_a_second_ticket(live_archive):
    c, d = live_archive
    key = c.post(f"/engine/queue/{d}/approve", json=REVIEWER).json()["jira_key"]
    c.post(f"/engine/queue/{d}/resolve", json=REVIEWER)

    _restart_and_rebuild(c)
    assert c.get(f"/engine/queue/{d}").json()["status"] == "awaiting_review"   # memory really gone
    assert engine_api._restore_decisions() == 2

    after = c.get(f"/engine/queue/{d}").json()
    assert after["status"] == "published" and after["jira_key"] == key
    assert after["lifecycle"] == "resolved"
    assert after["reviewer"] == "Neha Joshi <neha.joshi@ensylon.com>"
    queue = engine_api._state.queue
    assert queue.jira._transport.sent == []                      # the restore wrote no ticket
    queue.jira.add_comment(d, "late evidence")                    # and later evidence still lands on it
    assert queue.jira.comments[-1]["issue"] == key


def test_a_rejection_is_archived_and_restored(live_archive):
    c, d = live_archive
    c.post(f"/engine/queue/{d}/reject", json={**REVIEWER, "note": "maintenance, not an incident"})
    audit = c.get(f"/engine/history/{d}").json()["audit"]
    assert audit[-1]["action"] == "reject" and audit[-1]["note"] == "maintenance, not an incident"

    _restart_and_rebuild(c)
    engine_api._restore_decisions()
    assert c.get(f"/engine/queue/{d}").json()["status"] == "rejected"


def test_history_filters_by_time_status_service_and_reviewer(live_archive):
    c, d = live_archive
    c.post(f"/engine/queue/{d}/approve", json=REVIEWER)
    services = c.get("/engine/history").json()[0]["affected_services"]
    assert len(c.get("/engine/history", params={"status": "published"}).json()) == 1
    assert c.get("/engine/history", params={"status": "rejected"}).json() == []
    assert len(c.get("/engine/history", params={"service": services[0]}).json()) == 1
    assert len(c.get("/engine/history", params={"q": "neha.joshi"}).json()) == 1
    assert c.get("/engine/history", params={"q": "somebody-else"}).json() == []
    # the golden scenario is dated in the past, so a 1-hour window excludes it
    assert c.get("/engine/history", params={"hours": 1}).json() == []
    assert c.get("/engine/history/draft-nope").status_code == 404


def test_an_incident_is_raised_once_and_growth_is_logged(isolated_db):
    summary = {"draft_id": "d1", "title": "t", "priority": "P2", "status": "awaiting_review",
               "severity_score": 0.6, "correlation_confidence": 0.8, "root_cause_service": "agency-db",
               "affected_services": ["agency-db"], "signal_count": 3, "started_at": "2026-09-26T07:30:00Z",
               "jira_key": None}
    assert archive.record_incident(summary, {"title": "t"}, None) is True
    assert archive.record_incident(summary, {"title": "t"}, None) is False            # no duplicate "raised"
    archive.record_incident({**summary, "signal_count": 5}, {"title": "t"}, None)
    trail = archive.get_incident("d1")["audit"]
    assert [a["action"] for a in trail] == ["raised", "updated"]
    assert trail[1]["note"].startswith("now 5 signals")


def test_nothing_is_archived_outside_a_live_run(isolated_db):
    c = TestClient(app)
    d = c.post("/engine/golden").json()["queue"][0]["draft_id"]
    assert c.post(f"/engine/queue/{d}/approve", json={"actor": "Neha Joshi"}).status_code == 200   # offline: name is enough
    assert c.get("/engine/history").json() == []


def test_raised_time_is_the_engines_not_when_the_archive_first_saw_it(isolated_db):
    """After a restart the archive may first see an incident hours after it was
    raised; the stream-clock time the engine raised it at is what counts."""
    summary = {"draft_id": "d2", "title": "t", "priority": "P1", "status": "awaiting_review",
               "severity_score": 0.9, "correlation_confidence": 0.8, "root_cause_service": None,
               "affected_services": ["agency-db"], "signal_count": 2, "started_at": "2026-09-25T23:10:00Z",
               "raised_at": "2026-09-25T23:11:30+00:00", "jira_key": None}
    archive.record_incident(summary, {"title": "t"}, None)
    rec = archive.get_incident("d2")
    assert rec["raised_at"] == "2026-09-25T23:11:30+00:00"
    assert rec["audit"][0]["at"] == "2026-09-25T23:11:30+00:00"
