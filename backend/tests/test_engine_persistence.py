"""A backend restart must not wipe the incident, the decisions or the Jira key."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import engine_api  # noqa: E402
from app.engine.review import ReviewQueue  # noqa: E402
from app.main import app  # noqa: E402


def _forget_memory():
    """Simulate a restart: the process state is gone, only the DB remains."""
    engine_api._state.result = None
    engine_api._state.graph = None
    engine_api._state.queue = ReviewQueue()


@pytest.fixture()
def persisted(isolated_db, monkeypatch):
    monkeypatch.setattr(engine_api, "_PERSIST", True)
    return TestClient(app)


def test_run_decision_and_late_signal_survive_a_restart(persisted):
    c = persisted
    d = c.post("/engine/golden").json()["queue"][0]["draft_id"]
    c.post(f"/engine/queue/{d}/late-signal", json={"kind": "matching"})
    key = c.post(f"/engine/queue/{d}/approve", json={"actor": "Aditya"}).json()["jira_key"]
    c.post(f"/engine/queue/{d}/late-signal", json={"kind": "matching"})
    before = c.get(f"/engine/queue/{d}").json()

    _forget_memory()
    assert c.get("/engine/queue").json() == []           # really gone
    applied = engine_api.restore_from_log()
    assert applied == 4

    after = c.get(f"/engine/queue/{d}").json()
    assert after["status"] == "published" and after["jira_key"] == key
    assert after["reviewer"] == "Aditya"
    assert after["updates"] == before["updates"] and len(after["jira_comments"]) == 1
    assert len(engine_api._state.queue.jira._transport.sent) == 1   # still ONE issue


def test_a_new_run_replaces_the_log(persisted):
    c = persisted
    c.post("/engine/golden")
    c.post("/engine/scenario/flapping")
    _forget_memory()
    assert engine_api.restore_from_log() == 1                  # only the latest run
    assert engine_api._state.scenario_desc.startswith("flapping")


def test_rejected_decision_and_learned_weights_survive(persisted):
    c = persisted
    d = c.post("/engine/golden").json()["queue"][0]["draft_id"]
    c.post(f"/engine/queue/{d}/reject", json={"actor": "A", "note": "noise"})
    _forget_memory()
    engine_api.restore_from_log()
    assert c.get(f"/engine/queue/{d}").json()["status"] == "rejected"
    assert len(c.get("/engine/feedback").json()["patterns"]) == 1


def test_nothing_is_recorded_when_persistence_is_off(isolated_db):
    c = TestClient(app)          # _PERSIST is False from the autouse fixture
    c.post("/engine/golden")
    assert isolated_db.engine_events_load() == []


def test_a_stale_log_never_blocks_startup(persisted, isolated_db):
    isolated_db.engine_event_add("approve", {"draft_id": "no-such-draft", "body": {"actor": "x"}})
    _forget_memory()
    assert engine_api.restore_from_log() == 0


def test_replay_does_not_re_page_a_p1_that_already_paged(persisted):
    """golden's draft pages once, live. A restart replays the same submit
    event - that must rebuild the queue, not fire a second real page for an
    incident a human may already be handling."""
    c = persisted
    body = c.post("/engine/golden").json()
    assert len(engine_api._state.queue.notifications.events) == 1
    assert engine_api._state.queue.notifications.events[0].reason == "new_p1_incident"

    _forget_memory()
    assert engine_api._state.queue.notifications.events == []
    engine_api.restore_from_log()

    # the event is still recorded for audit/history continuity...
    events = engine_api._state.queue.notifications.events
    assert len(events) == 1
    # ...but delivery was suppressed, not sent again
    assert engine_api._state.queue.notifications._transport.sent == []


def test_autoseed_creates_the_golden_run_without_paging(persisted):
    """A host that woke up with an empty disk can re-seed the demo run, but
    nobody should be paged for the demo seeding itself."""
    _forget_memory()
    engine_api.seed_golden_quietly()
    queue = engine_api._state.queue
    assert len(queue.items) == 1
    item = next(iter(queue.items.values()))
    assert item.draft.priority == "P1"
    assert len(queue.notifications.events) == 1          # recorded for the audit trail
    assert queue.notifications._transport.sent == []     # but not delivered
