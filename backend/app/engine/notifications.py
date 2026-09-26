"""P1 paging — the push half of the review gate.

The review queue (review.py) is correct to require a named human before
anything reaches Jira, but that gate is pull-based: nothing happens until
someone opens the queue and looks. For a P1 - the priority the engine
reserves for incidents it has scored as genuinely severe - that is the wrong
default. An SRE should find out a P1 formed because something pinged them,
not because they happened to refresh a dashboard.

Same shape as review.py's JiraClient: a thin client over a swappable
transport, developed against a mock so a real webhook (Slack incoming
webhook, PagerDuty Events API, a generic on-call bridge - anything that
accepts an HTTP POST) is one constructor argument away, not new integration
work. No real endpoint is wired in without one being supplied - the mock
transport is the default so this never silently tries to reach the network
in tests or in a credential-less demo.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable


@dataclass
class NotificationEvent:
    at: datetime
    draft_id: str
    reason: str          # "new_p1_incident" | "escalated_to_p1"
    priority: str
    title: str
    root_cause_service: str
    affected_services: list[str]
    severity_score: float


class MockNotificationTransport:
    """Records what would have been paged. No network call."""

    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    def __call__(self, payload: dict[str, Any]) -> dict[str, Any]:
        self.sent.append(payload)
        return {"delivered": False, "reason": "mock transport - no real endpoint configured"}


class WebhookNotificationTransport:
    """POSTs the payload to a real webhook URL (Slack incoming webhook,
    PagerDuty Events API v2, or any endpoint that accepts a JSON POST).

    Kept dependency-free (stdlib `urllib`) since this is the one piece of
    the engine that talks to the outside world unprompted; a short timeout
    means a dead or slow webhook can never block incident processing.
    """

    def __init__(self, url: str, timeout: float = 3.0) -> None:
        self._url = url
        self._timeout = timeout

    def __call__(self, payload: dict[str, Any]) -> dict[str, Any]:
        import json
        import urllib.request

        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            self._url, data=body, method="POST",
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return {"delivered": True, "status": resp.status}
        except Exception as e:  # a paging failure must never break ingest
            return {"delivered": False, "reason": str(e)}


def default_transport() -> Callable[[dict], dict]:
    """`ALERT_WEBHOOK_URL` env var swaps the mock for a real webhook - the
    same "one constructor argument on the day" pattern as JiraClient, and
    just as honestly unwired until that variable is actually set."""
    url = os.environ.get("ALERT_WEBHOOK_URL", "").strip()
    return WebhookNotificationTransport(url) if url else MockNotificationTransport()


# Set around event-log replay (see engine_api.restore_from_log). A P1 that
# already paged a human before a backend restart must not page them again
# just because the process rebuilt its state - with a real webhook
# configured that would re-fire an actual page for an incident someone may
# have already handled.
_SUPPRESSED = False


def set_suppressed(value: bool) -> None:
    global _SUPPRESSED
    _SUPPRESSED = value


class NotificationClient:
    """Fires exactly when a draft is or becomes P1. Never blocks, never raises."""

    def __init__(self, transport: Callable[[dict], dict] | None = None) -> None:
        self._transport = transport or default_transport()
        self.events: list[NotificationEvent] = []

    def notify_p1(self, *, draft_id: str, reason: str, priority: str, title: str,
                  root_cause_service: str, affected_services: list[str],
                  severity_score: float) -> dict[str, Any]:
        event = NotificationEvent(
            at=datetime.now(timezone.utc), draft_id=draft_id, reason=reason,
            priority=priority, title=title, root_cause_service=root_cause_service,
            affected_services=list(affected_services), severity_score=severity_score,
        )
        self.events.append(event)
        if _SUPPRESSED:
            return {"delivered": False, "reason": "suppressed during event-log replay"}
        payload = {
            "text": f"[{priority}] {title}",
            "draft_id": draft_id,
            "reason": reason,
            "root_cause_service": root_cause_service,
            "affected_services": event.affected_services,
            "severity_score": severity_score,
            "at": event.at.isoformat(),
        }
        try:
            return self._transport(payload)
        except Exception as e:  # paging must never break the pipeline it's watching
            return {"delivered": False, "reason": str(e)}
