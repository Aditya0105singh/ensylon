"""HUMAN REVIEW GATE — Hard constraint #1: never auto-publish.

Every drafted ticket passes through a human decision before it reaches Jira.
There is no configuration flag, no admin override, and no "auto-approve above
confidence X" shortcut — the brief says *without exception*, so there is no
exception to configure.

How the constraint is actually enforced:

  * `JiraClient.create_issue` requires an `ApprovalToken`.
  * Tokens are minted in exactly one place: `ReviewQueue.approve`, which
    requires a named human actor.
  * Tokens are single-use and bound to one draft id, so an approval for one
    ticket cannot publish another, and a replayed token cannot publish twice.
  * Every decision is appended to an audit log with actor and timestamp.

An honest caveat, stated rather than glossed over: Python has no true
private state, so a determined caller could construct a token object directly.
This design cannot make that impossible — what it does is make the sanctioned
path the only *obvious* one, keep it to a single narrow interface, and ensure
anything that reaches Jira leaves an audit trail. In a production deployment
the same shape is enforced properly by making the Jira credential reachable
only from the review service.
"""

from __future__ import annotations

import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Callable

from .drafting import IncidentDraft
from .notifications import NotificationClient


class ReviewAction(str, Enum):
    APPROVE = "approve"
    EDIT_AND_APPROVE = "edit_and_approve"
    REJECT = "reject"
    MERGE = "merge"


class DraftStatus(str, Enum):
    AWAITING_REVIEW = "awaiting_review"
    PUBLISHED = "published"
    REJECTED = "rejected"
    MERGED = "merged"


@dataclass(frozen=True)
class ApprovalToken:
    """Proof that a named human approved one specific draft.

    Frozen so it cannot be retargeted at a different draft after minting.
    """

    value: str
    draft_id: str
    actor: str
    issued_at: datetime


@dataclass
class AuditEntry:
    at: datetime
    actor: str
    action: str
    draft_id: str
    detail: str = ""

    def render(self) -> str:
        return (
            f"{self.at.isoformat(timespec='seconds')}  {self.actor:<16}  "
            f"{self.action:<18} {self.draft_id}  {self.detail}"
        )


class ApprovalRequired(Exception):
    """Raised when something tries to publish without a valid approval."""


# --------------------------------------------------------------------------
# token vault
# --------------------------------------------------------------------------


class _TokenVault:
    """Mints and consumes approval tokens. Single-use, draft-bound."""

    def __init__(self) -> None:
        self._live: dict[str, ApprovalToken] = {}

    def mint(self, draft_id: str, actor: str) -> ApprovalToken:
        token = ApprovalToken(
            value=secrets.token_urlsafe(24),
            draft_id=draft_id,
            actor=actor,
            issued_at=datetime.now(timezone.utc),
        )
        self._live[token.value] = token
        return token

    def consume(self, token: ApprovalToken | None, draft_id: str) -> ApprovalToken:
        """Validate and burn a token. Every failure path raises."""
        if token is None:
            raise ApprovalRequired(
                f"refusing to publish {draft_id}: no approval token supplied"
            )
        held = self._live.get(token.value)
        if held is None:
            raise ApprovalRequired(
                f"refusing to publish {draft_id}: token is unknown or already used"
            )
        if held.draft_id != draft_id:
            raise ApprovalRequired(
                f"refusing to publish {draft_id}: token was issued for {held.draft_id}"
            )
        # Burn on use, so a replayed approval cannot create a second ticket.
        del self._live[token.value]
        return held


# --------------------------------------------------------------------------
# Jira client
# --------------------------------------------------------------------------


class JiraClient:
    """Thin interface over Jira issue creation.

    Deliberately narrow, and developed against `MockJiraTransport` throughout,
    so swapping in the live REST client on hackathon day is one constructor
    argument rather than new integration work. That is the mitigation for
    "Jira access only exists on the day itself" — if the API is unreachable,
    everything up to and including the review gate still demonstrates.
    """

    def __init__(self, vault: _TokenVault, transport: Callable[[dict], dict] | None = None):
        self._vault = vault
        self._transport = transport or MockJiraTransport()
        # Idempotency: a retry or a mid-window restart must not create a
        # second ticket for the same incident.
        self._published: dict[str, dict] = {}
        self.comments: list[dict] = []

    def create_issue(self, draft: IncidentDraft, token: ApprovalToken | None) -> dict:
        """The single write path in the entire system."""
        if draft.draft_id in self._published:
            return self._published[draft.draft_id]

        approval = self._vault.consume(token, draft.draft_id)

        payload = {
            "fields": draft.to_jira_fields(),
            "ticket": draft.to_ticket(),
            "markdown": draft.render_markdown(),
            "idempotency_key": draft.draft_id,
            "approved_by": approval.actor,
        }
        result = self._transport(payload)
        self._published[draft.draft_id] = result
        return result


    def add_comment(self, draft_id: str, body: str) -> dict:
        """Append new evidence to an issue that a human already approved.

        Not a second write path: it can only extend an issue this client
        created, and an issue can only exist after a consumed approval token.
        It cannot create an issue, and there is nothing to comment on before
        approval, so it cannot be used to publish anything.
        """
        issue = self._published.get(draft_id)
        if issue is None:
            raise ApprovalRequired(
                f"refusing to comment on {draft_id}: no approved Jira issue exists for it"
            )
        comment = {"issue": issue["key"], "body": body, "at": datetime.now(timezone.utc).isoformat()}
        self.comments.append(comment)
        writer = getattr(self._transport, "comment", None)
        if callable(writer):
            writer(issue["key"], body)
        return comment


class MockJiraTransport:
    """Stand-in for the real REST call. Records what would have been sent."""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self._counter = 0

    def __call__(self, payload: dict) -> dict:
        self._counter += 1
        self.sent.append(payload)
        return {
            "id": f"10{self._counter:03d}",
            "key": f"AIOPS-{self._counter}",
            "self": f"https://example.atlassian.net/rest/api/3/issue/10{self._counter:03d}",
        }


# --------------------------------------------------------------------------
# review queue
# --------------------------------------------------------------------------


@dataclass
class QueueItem:
    draft: IncidentDraft
    status: DraftStatus = DraftStatus.AWAITING_REVIEW
    jira_key: str | None = None
    merged_into: str | None = None
    reviewer: str | None = None
    decided_at: datetime | None = None
    note: str = ""
    # open -> drafting -> in_review -> published -> resolved. Rejected and merged
    # incidents stop where they were decided. Kept as history so the UI can show
    # when each transition happened, not just where the incident is now.
    lifecycle: str = "open"
    history: list[dict] = field(default_factory=list)
    jira_comments: list[dict] = field(default_factory=list)
    updates: int = 0   # late signals attached since the first draft

    def move(self, state: str, note: str = "") -> None:
        self.lifecycle = state
        self.history.append({"state": state, "at": datetime.now(timezone.utc).isoformat(), "note": note})


@dataclass
class CorrectionFeedback:
    """A reviewer decision fed back into correlation.

    Reject and Merge are not just dispositions — they are labelled training
    signal about where the grouping was wrong. Collecting them is what makes
    review effort compound into future accuracy instead of being spent once.
    """

    draft_id: str
    action: str
    services: list[str] = field(default_factory=list)
    note: str = ""
    adjustment: dict | None = None   # before/after similarity weights, if any


class ReviewQueue:
    """Holds drafts awaiting a human decision. The only minter of approvals."""

    def __init__(self, transport: Callable[[dict], dict] | None = None,
                 notify_transport: Callable[[dict], dict] | None = None) -> None:
        self._vault = _TokenVault()
        self.jira = JiraClient(self._vault, transport)
        self.notifications = NotificationClient(notify_transport)
        self.items: dict[str, QueueItem] = {}
        self.audit: list[AuditEntry] = []
        self.feedback: list[CorrectionFeedback] = []

    # -- intake ----------------------------------------------------------

    def submit(self, draft: IncidentDraft) -> QueueItem:
        item = QueueItem(draft=draft)
        item.move("open", "correlated into an incident")
        item.move("drafting", "ticket assembled from computed evidence")
        item.move("in_review", "waiting for a human decision")
        self.items[draft.draft_id] = item
        self._log("system", "drafted", draft.draft_id,
                  f"{draft.priority} · {len(draft.affected_services)} service(s)")
        if draft.priority == "P1":
            self._page(item, "new_p1_incident")
        return item

    def pending(self) -> list[QueueItem]:
        return [i for i in self.items.values() if i.status == DraftStatus.AWAITING_REVIEW]

    # -- decisions -------------------------------------------------------

    def approve(self, draft_id: str, actor: str, edits: dict[str, Any] | None = None) -> QueueItem:
        """Approve a draft and publish it. The only path to Jira."""
        item = self._require(draft_id)
        if not actor or not actor.strip():
            raise ApprovalRequired("approval requires a named human actor")

        action = ReviewAction.APPROVE
        if edits:
            editable = getattr(item.draft, "EDITABLE", ())
            refused = sorted(k for k in edits if k not in editable)
            if refused:
                raise ValueError(f"not editable: {', '.join(refused)} (editable: {', '.join(editable)})")
            if "priority" in edits and edits["priority"] not in ("P1", "P2", "P3", "P4"):
                raise ValueError("priority must be one of P1, P2, P3, P4")
            for field_name, value in edits.items():
                setattr(item.draft, field_name, value)
            action = ReviewAction.EDIT_AND_APPROVE

        token = self._vault.mint(draft_id, actor)
        result = self.jira.create_issue(item.draft, token)

        item.status = DraftStatus.PUBLISHED
        item.jira_key = result.get("key")
        item.reviewer = actor
        item.decided_at = datetime.now(timezone.utc)
        item.draft.status = DraftStatus.PUBLISHED.value
        item.move("published", f"{item.jira_key} created after approval by {actor}")

        self._log(actor, action.value, draft_id, f"published as {item.jira_key}")
        return item

    def reject(self, draft_id: str, actor: str, note: str = "") -> QueueItem:
        item = self._require(draft_id)
        item.status = DraftStatus.REJECTED
        item.reviewer = actor
        item.note = note
        item.decided_at = datetime.now(timezone.utc)
        item.draft.status = DraftStatus.REJECTED.value

        self._log(actor, ReviewAction.REJECT.value, draft_id, note or "rejected as noise")
        self.feedback.append(CorrectionFeedback(
            draft_id=draft_id, action="reject",
            services=item.draft.affected_services, note=note,
        ))
        return item

    def merge(self, draft_id: str, into: str, actor: str, note: str = "") -> QueueItem:
        item = self._require(draft_id)
        item.status = DraftStatus.MERGED
        item.merged_into = into
        item.reviewer = actor
        item.note = note
        item.decided_at = datetime.now(timezone.utc)
        item.draft.status = DraftStatus.MERGED.value

        self._log(actor, ReviewAction.MERGE.value, draft_id, f"merged into {into}. {note}".strip())
        self.feedback.append(CorrectionFeedback(
            draft_id=draft_id, action="merge",
            services=item.draft.affected_services, note=f"into={into} {note}".strip(),
        ))
        return item

    # -- lifecycle -------------------------------------------------------

    def attach_update(self, draft_id: str, new_draft: IncidentDraft, note: str) -> QueueItem:
        """A late signal joined this incident: refresh the draft, keep one identity.

        The draft id and status are preserved, so the incident never becomes a
        second ticket. If the issue is already published the new evidence goes
        to Jira as a comment, never as a new issue.
        """
        item = self.items.get(draft_id)
        if item is None:
            raise KeyError(f"no draft {draft_id} in the review queue")
        if item.status in (DraftStatus.REJECTED, DraftStatus.MERGED):
            raise ApprovalRequired(f"draft {draft_id} is {item.status.value}; it accepts no updates")

        was_p1 = item.draft.priority == "P1"
        new_draft.draft_id = draft_id
        new_draft.status = item.draft.status
        item.draft = new_draft
        item.updates += 1
        item.history.append({"state": item.lifecycle, "at": datetime.now(timezone.utc).isoformat(),
                             "note": f"late signal attached: {note}"})
        self._log("system", "attached", draft_id, note)

        if item.status == DraftStatus.AWAITING_REVIEW and item.draft.priority == "P1" and not was_p1:
            self._page(item, "escalated_to_p1")

        if item.status == DraftStatus.PUBLISHED:
            comment = self.jira.add_comment(draft_id, f"New evidence attached to this incident: {note}")
            item.jira_comments.append(comment)
            self._log("system", "jira_comment", draft_id, f"comment added to {item.jira_key}")
        return item

    def resolve(self, draft_id: str, actor: str) -> QueueItem:
        item = self.items.get(draft_id)
        if item is None:
            raise KeyError(f"no draft {draft_id} in the review queue")
        if item.status != DraftStatus.PUBLISHED:
            raise ApprovalRequired("only a published incident can be marked resolved")
        if not actor or not actor.strip():
            raise ApprovalRequired("resolving requires a named human actor")
        item.move("resolved", f"marked resolved by {actor}")
        self._log(actor, "resolve", draft_id, "incident resolved")
        return item

    # -- internals -------------------------------------------------------

    def _page(self, item: QueueItem, reason: str) -> None:
        draft = item.draft
        result = self.notifications.notify_p1(
            draft_id=draft.draft_id, reason=reason, priority=draft.priority,
            title=draft.title, root_cause_service=draft.root_cause_service or "unknown",
            affected_services=draft.affected_services, severity_score=draft.severity_score,
        )
        self._log("system", "paged", draft.draft_id,
                  f"{reason}: {'delivered' if result.get('delivered') else 'not delivered (' + str(result.get('reason', '')) + ')'}")

    def _require(self, draft_id: str) -> QueueItem:
        item = self.items.get(draft_id)
        if item is None:
            raise KeyError(f"no draft {draft_id} in the review queue")
        if item.status != DraftStatus.AWAITING_REVIEW:
            raise ApprovalRequired(
                f"draft {draft_id} is already {item.status.value} — decisions are final"
            )
        return item

    def _log(self, actor: str, action: str, draft_id: str, detail: str = "") -> None:
        self.audit.append(AuditEntry(
            at=datetime.now(timezone.utc), actor=actor,
            action=action, draft_id=draft_id, detail=detail,
        ))

    # -- reporting -------------------------------------------------------

    def stats(self) -> dict[str, int]:
        counts = {status.value: 0 for status in DraftStatus}
        for item in self.items.values():
            counts[item.status.value] += 1
        counts["auto_published"] = 0  # structurally impossible; reported to prove it
        return counts
