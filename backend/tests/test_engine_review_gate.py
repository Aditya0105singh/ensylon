"""Tests for the hard constraints.

The review gate is the one requirement the brief states without exception, so
it gets tested as a security boundary rather than a feature: every route to
Jira that isn't "a named human approved this specific draft" must fail.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.engine.drafting import IncidentDraft
from app.engine.review import (
    ApprovalRequired,
    ApprovalToken,
    DraftStatus,
    MockJiraTransport,
    ReviewQueue,
)


def make_draft(draft_id: str = "draft-1") -> IncidentDraft:
    return IncidentDraft(
        draft_id=draft_id,
        title="[DRAFT] postgres-primary: DatabaseConnections",
        priority="P1",
        severity_score=0.83,
        severity_line="P1 — 0.83",
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
    return ReviewQueue(transport=MockJiraTransport())


# --------------------------------------------------------------------------
# the gate
# --------------------------------------------------------------------------


def test_drafting_alone_never_publishes(queue):
    """Submitting a draft must not create a Jira issue."""
    queue.submit(make_draft())
    assert queue.jira._transport.sent == []
    assert queue.stats()["published"] == 0
    assert queue.stats()["auto_published"] == 0


def test_publish_without_token_is_refused(queue):
    draft = make_draft()
    queue.submit(draft)
    with pytest.raises(ApprovalRequired, match="no approval token"):
        queue.jira.create_issue(draft, None)
    assert queue.jira._transport.sent == []


def test_forged_token_is_refused(queue):
    """A token the vault never minted must not work."""
    draft = make_draft()
    queue.submit(draft)
    forged = ApprovalToken(
        value="clearly-not-real", draft_id=draft.draft_id,
        actor="attacker", issued_at=datetime.now(timezone.utc),
    )
    with pytest.raises(ApprovalRequired, match="unknown or already used"):
        queue.jira.create_issue(draft, forged)
    assert queue.jira._transport.sent == []


def test_token_cannot_publish_a_different_draft(queue):
    """Approval is bound to one draft — it is not a general permit."""
    approved, other = make_draft("draft-A"), make_draft("draft-B")
    queue.submit(approved)
    queue.submit(other)

    token = queue._vault.mint(approved.draft_id, "sre@example.com")
    with pytest.raises(ApprovalRequired, match="issued for draft-A"):
        queue.jira.create_issue(other, token)


def test_token_is_single_use(queue):
    """A replayed approval must not create a second ticket."""
    draft = make_draft()
    queue.submit(draft)
    token = queue._vault.mint(draft.draft_id, "sre@example.com")

    queue.jira.create_issue(draft, token)
    queue.jira._published.clear()  # defeat the idempotency cache to isolate the token check

    with pytest.raises(ApprovalRequired, match="unknown or already used"):
        queue.jira.create_issue(draft, token)


def test_approval_requires_a_named_human(queue):
    draft = make_draft()
    queue.submit(draft)
    with pytest.raises(ApprovalRequired, match="named human"):
        queue.approve(draft.draft_id, actor="   ")
    assert queue.jira._transport.sent == []


# --------------------------------------------------------------------------
# the sanctioned path
# --------------------------------------------------------------------------


def test_approve_publishes_once_and_audits(queue):
    draft = make_draft()
    queue.submit(draft)
    item = queue.approve(draft.draft_id, actor="aditya@example.com")

    assert item.status == DraftStatus.PUBLISHED
    assert item.jira_key == "AIOPS-1"
    assert len(queue.jira._transport.sent) == 1
    assert queue.jira._transport.sent[0]["approved_by"] == "aditya@example.com"

    actions = [entry.action for entry in queue.audit]
    assert "drafted" in actions and "approve" in actions


def test_republish_is_idempotent(queue):
    """A retry must return the original issue, not create a second one."""
    draft = make_draft()
    queue.submit(draft)
    first = queue.approve(draft.draft_id, actor="sre@example.com")
    again = queue.jira.create_issue(draft, None)  # no token needed: already published

    assert again["key"] == first.jira_key
    assert len(queue.jira._transport.sent) == 1


def test_reject_never_publishes_and_feeds_correction_loop(queue):
    draft = make_draft()
    queue.submit(draft)
    queue.reject(draft.draft_id, actor="sre@example.com", note="two unrelated incidents")

    assert queue.jira._transport.sent == []
    assert queue.items[draft.draft_id].status == DraftStatus.REJECTED
    assert queue.feedback[0].action == "reject"
    assert "unrelated" in queue.feedback[0].note


def test_merge_never_publishes_and_records_target(queue):
    draft = make_draft()
    queue.submit(draft)
    queue.merge(draft.draft_id, into="AIOPS-7", actor="sre@example.com")

    assert queue.jira._transport.sent == []
    assert queue.items[draft.draft_id].merged_into == "AIOPS-7"
    assert queue.feedback[0].action == "merge"


def test_decisions_are_final(queue):
    draft = make_draft()
    queue.submit(draft)
    queue.approve(draft.draft_id, actor="sre@example.com")
    with pytest.raises(ApprovalRequired, match="already published"):
        queue.approve(draft.draft_id, actor="someone-else@example.com")
    assert len(queue.jira._transport.sent) == 1


def test_edit_then_approve_applies_edits(queue):
    draft = make_draft()
    queue.submit(draft)
    queue.approve(
        draft.draft_id, actor="sre@example.com",
        edits={"priority": "P2", "title": "[DRAFT] corrected title"},
    )
    sent = queue.jira._transport.sent[0]["fields"]
    assert sent["summary"] == "[DRAFT] corrected title"
    assert "priority-p2" in sent["labels"]
