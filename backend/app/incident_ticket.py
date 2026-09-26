"""Turns an AlertLens incident into a reviewable ticket draft, and publishes it
through the review gate.

Nothing new is invented here: the draft is assembled from the cluster the
pipeline already produced, the correlation explanation
(app/correlation_explain.py) and the playbook (app/playbook.py). Publishing
reuses app/engine/review.py, which mints a human approval token and refuses to
create a ticket without one.

Jira reality check: no Jira credentials exist in this deployment, so the review
gate's `MockJiraTransport` records the exact payload that *would* have been
POSTed and returns a synthetic key. The endpoint reports that plainly as
`jira.mode == "simulated"` so nobody mistakes the ticket for a real one.
Swapping in the live REST client is one constructor argument (see JiraClient).
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from .clustering import _ts
from .correlation_explain import build_correlation_explanation
from .engine.drafting import ExcludedSignal, IncidentDraft, TimelineEntry
from .engine.review import ReviewQueue
from .playbook import generate_playbook

MAX_TIMELINE = 12

# One queue for the whole process, so an approval survives between requests.
_queue = ReviewQueue()
# draft_id -> approver, so re-reading a published ticket still shows who signed
# it off (QueueItem tracks status and key, not the actor).
_approvers: dict[str, str] = {}


def _draft_id_for(incident_id: str) -> str:
    return f"alertlens-{incident_id}"


def build_draft(
    cluster: dict[str, Any], all_clusters: list[dict], noise: list[dict]
) -> IncidentDraft:
    """Compose the ticket from what the engine already established."""
    incident_id = str(cluster.get("cluster_id"))
    root = cluster.get("root_cause") or {}
    alerts = sorted(cluster.get("alerts") or [], key=lambda a: a.get("timestamp", ""))
    risk = cluster.get("risk") or {}
    playbook = generate_playbook(cluster)
    # Jira labels are built from this and cannot contain spaces, so collapse
    # the playbook's "Critical P1" / "High P2" wording to the bare level.
    priority = "P1" if str(playbook.get("priority", "")).lower().startswith("critical") else "P2"
    explanation = build_correlation_explanation(cluster, all_clusters, noise)

    services: list[str] = []
    for a in alerts:
        svc = a.get("service")
        if svc and svc not in services:
            services.append(svc)

    timeline = [
        TimelineEntry(
            at=_ts(a),
            source=a.get("source", "alert"),
            service=a.get("service", "unknown"),
            detail=a.get("alertname", ""),
            count=a.get("duplicate_count", 1) or 1,
        )
        for a in alerts[:MAX_TIMELINE]
    ]

    excluded = [
        ExcludedSignal(
            service=x.get("service", "unknown"),
            at=datetime.fromisoformat(x["timestamp"]) if x.get("timestamp") else datetime.now(),
            detail=x.get("alertname", ""),
            reason="; ".join(x.get("reasons", [])) or f"distance {x.get('distance')}",
        )
        for x in explanation.get("excluded", [])
    ]

    severity_factors = {f["label"]: f["detail"] for f in explanation.get("factors", [])}

    return IncidentDraft(
        draft_id=_draft_id_for(incident_id),
        title=f"{root.get('alertname', 'Incident')} on {root.get('service', 'unknown')}",
        priority=priority,
        severity_score=float(risk.get("score", 0.0)),
        severity_line=f"{str(risk.get('level', 'unknown')).title()} risk of escalation "
        f"({round(float(risk.get('score', 0.0)) * 100)}%)",
        correlation_confidence=explanation.get("confidence_pct", 0) / 100,
        causal_confidence=explanation.get("confidence_pct", 0),
        root_cause_service=root.get("service"),
        root_cause_detail=f"{root.get('alertname', '')} — {root.get('message', '')}".strip(" —"),
        affected_services=services,
        signal_count=int(cluster.get("size", len(alerts))),
        started_at=_ts(alerts[0]) if alerts else datetime.now(),
        timeline=timeline,
        considered_excluded=excluded,
        severity_factors=severity_factors,
        causal_reasoning=[r["text"] for r in explanation.get("reasons", []) if r.get("ok")],
        summary=cluster.get("summary", ""),
        investigation_steps=[s.get("title", "") for s in playbook.get("steps", [])],
        # Recorded by the pipeline from whichever path actually produced the
        # summary, rather than assumed.
        summary_source=cluster.get("summary_source", "template"),
    )


def get_ticket(
    cluster: dict[str, Any], all_clusters: list[dict], noise: list[dict]
) -> dict[str, Any]:
    """The draft plus its review state. Read-only: never publishes."""
    draft = build_draft(cluster, all_clusters, noise)
    item = _queue.items.get(draft.draft_id)
    published = item and item.jira_key

    return {
        "draft_id": draft.draft_id,
        "title": draft.title,
        "priority": draft.priority,
        "labels": draft.to_jira_fields().get("labels", []),
        "description": draft.render_description(),
        "summary": draft.summary,
        "summary_source": draft.summary_source,
        "investigation_steps": draft.investigation_steps,
        "affected_services": draft.affected_services,
        "signal_count": draft.signal_count,
        "correlation_confidence": draft.correlation_confidence,
        "status": item.status.value if item else "awaiting_review",
        "jira": {
            # No Jira credentials are configured, so the gate's mock transport
            # records the payload instead of POSTing it. Reported, not hidden.
            "mode": "simulated",
            "configured": False,
            "key": item.jira_key if item else None,
            "approved_by": _approvers.get(draft.draft_id),
        },
        "published": bool(published),
        "audit": [e.render() for e in _queue.audit if draft.draft_id in e.render()][-5:],
    }


def approve_ticket(
    cluster: dict[str, Any], all_clusters: list[dict], noise: list[dict], actor: str
) -> dict[str, Any]:
    """Publish through the review gate. The gate mints the approval token, so
    this cannot create a ticket without a named human."""
    draft = build_draft(cluster, all_clusters, noise)
    if draft.draft_id not in _queue.items:
        _queue.submit(draft)

    item = _queue.items[draft.draft_id]
    if not item.jira_key:
        item = _queue.approve(draft.draft_id, actor=actor)
    _approvers.setdefault(draft.draft_id, actor)

    result = get_ticket(cluster, all_clusters, noise)
    result["jira"]["key"] = item.jira_key
    result["jira"]["approved_by"] = _approvers.get(draft.draft_id, actor)
    result["status"] = item.status.value
    result["published"] = bool(item.jira_key)
    return result
