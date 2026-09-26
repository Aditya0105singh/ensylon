"""ARCHIVE - the incident record and its sign-off trail, kept for post-incident review.

The live engine lives in memory and the stream recording is for replaying one
session. Neither answers the question asked a day or two later: "what broke
last night, how did it unfold, and who signed off on what?" This module does,
the way incident-management tools do it:

  * `incident_archive` - one row per incident, holding its latest snapshot
    (ticket draft, evidence, scores, services). Upserted whenever the incident
    is raised, grows, or is decided. It survives restarts and sessions.
  * `incident_audit`   - append-only. One row per action: raised, updated,
    approved, edited_and_approved, rejected, resolved, merged - each with the
    reviewer's name and email, the time, a note, and the before/after of any
    edit. Rows are never updated or deleted.

Everything stored is already redacted: snapshots are built from redacted
signals, and reviewer identity is the reviewer's own work address.

Uses the app's SQLAlchemy engine (backend/alertlens.db); pointing that at
Postgres needs no change here.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import Column, DateTime, Float, Integer, String, Text

from .. import db

# Actions a human takes. "raised" and "updated" are the engine's own entries.
DECISIONS = ("approve", "edit_and_approve", "reject", "resolve", "merge")


def _now() -> datetime:
    """UTC, stored naive: SQLite keeps no timezone, so every column is UTC by convention."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _naive_utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc).replace(tzinfo=None) if dt.tzinfo else dt


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite drops tzinfo; everything stored here is UTC."""
    return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)


class IncidentRecord(db.Base):
    __tablename__ = "incident_archive"

    draft_id = Column(String, primary_key=True)
    title = Column(String, nullable=False)
    priority = Column(String, nullable=False)
    status = Column(String, nullable=False)
    severity = Column(Float, nullable=False)
    confidence = Column(Float, nullable=False)
    root_cause = Column(String, nullable=True)
    services = Column(Text, nullable=False)          # JSON list
    signal_count = Column(Integer, nullable=False)
    started_at = Column(DateTime, nullable=False)
    raised_at = Column(DateTime, nullable=False)
    updated_at = Column(DateTime, nullable=False)
    decided_at = Column(DateTime, nullable=True)
    decided_by_name = Column(String, nullable=True)
    decided_by_email = Column(String, nullable=True)
    ticket_key = Column(String, nullable=True)
    source = Column(String, nullable=True)            # e.g. the stream base URL
    detail = Column(Text, nullable=False)            # JSON: the draft as the review page shows it
    evidence = Column(Text, nullable=True)           # JSON: signals, joins, root cause


class AuditRecord(db.Base):
    __tablename__ = "incident_audit"

    seq = Column(Integer, primary_key=True, autoincrement=True)
    draft_id = Column(String, nullable=False, index=True)
    at = Column(DateTime, nullable=False)
    action = Column(String, nullable=False)
    actor_name = Column(String, nullable=False)
    actor_email = Column(String, nullable=True)
    note = Column(Text, nullable=False, default="")
    changes = Column(Text, nullable=True)            # JSON: {field: {"before": ..., "after": ...}}


def init() -> None:
    db.Base.metadata.create_all(db.engine, tables=[IncidentRecord.__table__, AuditRecord.__table__])


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------


def record_incident(summary: dict[str, Any], detail: dict[str, Any], evidence: dict[str, Any] | None,
                    source: str | None = None) -> bool:
    """Upsert the incident's snapshot. Adds a "raised" audit row the first time,
    and an "updated" row when its signal count grows. Returns True if new."""
    now = _now()
    with db.SessionLocal() as s:
        row = s.get(IncidentRecord, summary["draft_id"])
        created = row is None
        grew = False
        raised = summary.get("raised_at")
        raised = _naive_utc(datetime.fromisoformat(raised.replace("Z", "+00:00"))) if raised else now
        if created:
            row = IncidentRecord(draft_id=summary["draft_id"], raised_at=raised)
            s.add(row)
        else:
            grew = int(summary["signal_count"]) > int(row.signal_count or 0)
        row.title = summary["title"]
        row.priority = summary["priority"]
        row.status = summary["status"]
        row.severity = float(summary["severity_score"])
        row.confidence = float(summary["correlation_confidence"])
        row.root_cause = summary.get("root_cause_service")
        row.services = json.dumps(summary.get("affected_services") or [])
        row.signal_count = int(summary["signal_count"])
        row.started_at = _naive_utc(datetime.fromisoformat(summary["started_at"].replace("Z", "+00:00")))
        row.updated_at = now
        row.ticket_key = summary.get("jira_key") or row.ticket_key
        row.source = source or row.source
        row.detail = json.dumps(detail, default=str)
        if evidence is not None:
            row.evidence = json.dumps(evidence, default=str)
        if created:
            s.add(AuditRecord(draft_id=row.draft_id, at=raised, action="raised", actor_name="engine",
                              note=f"{row.priority} raised with {row.signal_count} signals across "
                                   f"{', '.join(json.loads(row.services))}"))
        elif grew:
            s.add(AuditRecord(draft_id=row.draft_id, at=now, action="updated", actor_name="engine",
                              note=f"now {row.signal_count} signals; {row.priority}"))
        s.commit()
        return created


def record_decision(draft_id: str, action: str, actor_name: str, actor_email: str | None,
                    note: str = "", changes: dict[str, Any] | None = None,
                    status: str | None = None, ticket_key: str | None = None) -> None:
    """Append a human decision to the audit trail and stamp it on the record."""
    if action not in DECISIONS:
        raise ValueError(f"unknown decision {action!r}")
    now = _now()
    with db.SessionLocal() as s:
        s.add(AuditRecord(draft_id=draft_id, at=now, action=action, actor_name=actor_name,
                          actor_email=actor_email, note=note or "",
                          changes=json.dumps(changes, default=str) if changes else None))
        row = s.get(IncidentRecord, draft_id)
        if row is not None:
            if status:
                row.status = status
            if ticket_key:
                row.ticket_key = ticket_key
            row.decided_at = now
            row.decided_by_name = actor_name
            row.decided_by_email = actor_email
            row.updated_at = now
        s.commit()


# --------------------------------------------------------------------------
# reading
# --------------------------------------------------------------------------


def _summary(row: IncidentRecord) -> dict[str, Any]:
    iso = lambda d: _aware(d).isoformat() if d else None  # noqa: E731
    return {
        "draft_id": row.draft_id, "title": row.title, "priority": row.priority, "status": row.status,
        "severity_score": row.severity, "correlation_confidence": row.confidence,
        "root_cause_service": row.root_cause, "affected_services": json.loads(row.services),
        "signal_count": row.signal_count, "started_at": iso(row.started_at), "raised_at": iso(row.raised_at),
        "updated_at": iso(row.updated_at), "decided_at": iso(row.decided_at),
        "decided_by": ({"name": row.decided_by_name, "email": row.decided_by_email}
                       if row.decided_by_name else None),
        "ticket_key": row.ticket_key, "source": row.source,
    }


def _audit(row: AuditRecord) -> dict[str, Any]:
    return {
        "seq": row.seq, "at": _aware(row.at).isoformat(), "action": row.action,
        "actor": {"name": row.actor_name, "email": row.actor_email},
        "note": row.note or "", "changes": json.loads(row.changes) if row.changes else None,
    }


def list_incidents(since_hours: float | None = None, status: str | None = None,
                   service: str | None = None, q: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    """Newest first. `q` matches title, root cause, services and reviewer."""
    with db.SessionLocal() as s:
        query = s.query(IncidentRecord)
        if since_hours:
            query = query.filter(IncidentRecord.started_at >= _now() - timedelta(hours=since_hours))
        if status:
            query = query.filter(IncidentRecord.status == status)
        rows = query.order_by(IncidentRecord.started_at.desc()).limit(max(1, min(limit, 2000))).all()
        out = [_summary(r) for r in rows]
    if service:
        out = [r for r in out if service in r["affected_services"]]
    if q:
        needle = q.lower()
        out = [r for r in out if needle in " ".join([
            r["title"], r["root_cause_service"] or "", " ".join(r["affected_services"]),
            (r["decided_by"] or {}).get("name") or "", (r["decided_by"] or {}).get("email") or "",
        ]).lower()]
    return out


def get_incident(draft_id: str) -> dict[str, Any] | None:
    with db.SessionLocal() as s:
        row = s.get(IncidentRecord, draft_id)
        if row is None:
            return None
        trail = s.query(AuditRecord).filter(AuditRecord.draft_id == draft_id).order_by(AuditRecord.seq).all()
        return {
            **_summary(row),
            "detail": json.loads(row.detail),
            "evidence": json.loads(row.evidence) if row.evidence else None,
            "audit": [_audit(a) for a in trail],
        }


def decision_history(draft_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
    """Every human decision per incident, oldest first - what a restart
    re-applies (a "resolve" only makes sense after its "approve")."""
    if not draft_ids:
        return {}
    with db.SessionLocal() as s:
        rows = (s.query(AuditRecord)
                .filter(AuditRecord.draft_id.in_(draft_ids), AuditRecord.action.in_(DECISIONS))
                .order_by(AuditRecord.seq).all())
        tickets = {r.draft_id: r.ticket_key for r in
                   s.query(IncidentRecord).filter(IncidentRecord.draft_id.in_(draft_ids)).all()}
        out: dict[str, list[dict[str, Any]]] = {}
        for r in rows:
            out.setdefault(r.draft_id, []).append({**_audit(r), "ticket_key": tickets.get(r.draft_id)})
        return out


__all__ = ["IncidentRecord", "AuditRecord", "init", "record_incident", "record_decision",
           "list_incidents", "get_incident", "decision_history", "DECISIONS"]
