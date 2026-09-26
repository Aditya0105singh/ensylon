"""P1 paging — the review queue is a pull-based gate by design (a human must
act), but a P1 forming with nobody paged is the one failure mode an incident
tool cannot afford. These tests cover the push side: a P1 draft pages on
submit, an escalation to P1 pages once, and a paging failure never blocks
the pipeline it's watching.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.engine.drafting import IncidentDraft
from app.engine.notifications import MockNotificationTransport, NotificationClient
from app.engine.review import MockJiraTransport, ReviewQueue


def make_draft(draft_id: str = "draft-1", priority: str = "P1") -> IncidentDraft:
    return IncidentDraft(
        draft_id=draft_id,
        title="[DRAFT] postgres-primary: DatabaseConnections",
        priority=priority,
        severity_score=0.83 if priority == "P1" else 0.5,
        severity_line=f"{priority} — 0.83",
        correlation_confidence=0.91,
        causal_confidence=93,
        root_cause_service="postgres-primary",
        root_cause_detail="postgres-primary — DatabaseConnections = 200",
        affected_services=["postgres-primary", "order-api"],
        signal_count=18,
        started_at=datetime(2026, 8, 26, 14, 2, tzinfo=timezone.utc),
        timeline=[],
        considered_excluded=[],
        severity_factors={},
        causal_reasoning=[],
    )


@pytest.fixture
def queue() -> ReviewQueue:
    return ReviewQueue(transport=MockJiraTransport(), notify_transport=MockNotificationTransport())


# --------------------------------------------------------------------------
# NotificationClient in isolation
# --------------------------------------------------------------------------


def test_notify_p1_records_event_and_calls_transport():
    client = NotificationClient(MockNotificationTransport())
    result = client.notify_p1(
        draft_id="d1", reason="new_p1_incident", priority="P1", title="X",
        root_cause_service="svc-a", affected_services=["svc-a"], severity_score=0.9,
    )
    assert result["delivered"] is False  # mock transport, honestly reports it
    assert len(client.events) == 1
    assert client.events[0].reason == "new_p1_incident"
    assert client._transport.sent[0]["draft_id"] == "d1"


def test_notify_p1_never_raises_even_if_the_transport_throws():
    def broken_transport(payload):
        raise ConnectionError("webhook host unreachable")

    client = NotificationClient(broken_transport)
    result = client.notify_p1(
        draft_id="d1", reason="new_p1_incident", priority="P1", title="X",
        root_cause_service="svc-a", affected_services=["svc-a"], severity_score=0.9,
    )
    assert result["delivered"] is False
    assert "unreachable" in result["reason"]
    # The event is still recorded even though delivery failed - paging
    # failure must be visible, not silently dropped.
    assert len(client.events) == 1


def test_mock_transport_never_touches_the_network():
    """No ALERT_WEBHOOK_URL set -> default_transport() must be the mock,
    never a real webhook, so tests and credential-less demos stay offline."""
    from app.engine.notifications import default_transport
    import os

    assert os.environ.get("ALERT_WEBHOOK_URL", "") == ""
    assert type(default_transport()).__name__ == "MockNotificationTransport"


# --------------------------------------------------------------------------
# wired into the review queue
# --------------------------------------------------------------------------


def test_submitting_a_p1_draft_pages(queue):
    queue.submit(make_draft(priority="P1"))
    assert len(queue.notifications.events) == 1
    assert queue.notifications.events[0].reason == "new_p1_incident"


def test_submitting_a_p2_draft_does_not_page(queue):
    queue.submit(make_draft(priority="P2"))
    assert queue.notifications.events == []


def test_late_signal_escalating_p2_to_p1_pages_once(queue):
    queue.submit(make_draft(priority="P2"))
    assert queue.notifications.events == []

    queue.attach_update("draft-1", make_draft(priority="P1"), "late signal joined")
    assert len(queue.notifications.events) == 1
    assert queue.notifications.events[0].reason == "escalated_to_p1"


def test_late_signal_that_stays_p1_does_not_double_page(queue):
    queue.submit(make_draft(priority="P1"))
    assert len(queue.notifications.events) == 1

    queue.attach_update("draft-1", make_draft(priority="P1"), "another late signal")
    assert len(queue.notifications.events) == 1  # still just the original page


def test_paging_is_audited(queue):
    queue.submit(make_draft(priority="P1"))
    paged_entries = [e for e in queue.audit if e.action == "paged"]
    assert len(paged_entries) == 1
    assert "new_p1_incident" in paged_entries[0].detail
