"""SQLite persistence layer.

Alerts and clustering are still recomputed in-memory on every pipeline run
(see main.py) — that part of the architecture doesn't need a database. What
was missing is durability: raw ingested alerts and user actions (ack/assign/
dismiss/escalate) lived only in the `_state` dict and the frontend's React
state, so a backend restart or page refresh silently threw them away.

This module gives those two things a home:
  - `alerts` table: every raw alert ever ingested/generated, so a restart
    doesn't lose history.
  - `alert_actions` table: one row per alert id holding the user-applied
    overrides (ack, assignee, status override, escalated), keyed so they
    survive independently of whatever batch the alert came from.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from sqlalchemy import Column, Integer, String, Boolean, DateTime, Text, create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker

DB_PATH = Path(__file__).resolve().parents[1] / "alertlens.db"
engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)
Base = declarative_base()


class AlertRow(Base):
    __tablename__ = "alerts"

    id = Column(String, primary_key=True)
    payload = Column(String, nullable=False)  # full alert dict, JSON-encoded
    timestamp = Column(DateTime, nullable=False)


class AlertAction(Base):
    __tablename__ = "alert_actions"

    alert_id = Column(String, primary_key=True)
    acked = Column(Boolean, default=False)
    assignee = Column(String, nullable=True)
    status_override = Column(String, nullable=True)  # "suppressed" | "resolved" | None
    escalated = Column(Boolean, default=False)
    updated_at = Column(DateTime, default=datetime.utcnow)


def init_db() -> None:
    Base.metadata.create_all(engine)


def save_alerts(alerts: list[dict]) -> None:
    """Upsert a batch of raw alerts (id is the natural key). Existing rows are
    looked up a chunk at a time rather than one query per alert."""
    if not alerts:
        return
    with SessionLocal() as db:
        for i in range(0, len(alerts), 500):
            chunk = alerts[i : i + 500]
            existing = {
                r.id: r
                for r in db.query(AlertRow).filter(AlertRow.id.in_([a["id"] for a in chunk]))
            }
            for a in chunk:
                ts = a["timestamp"]
                if isinstance(ts, str):
                    ts = datetime.fromisoformat(ts)
                payload = json.dumps(a, default=str)
                row = existing.get(a["id"])
                if row:
                    row.payload = payload
                    row.timestamp = ts
                else:
                    db.add(AlertRow(id=a["id"], payload=payload, timestamp=ts))
        db.commit()


def load_alerts() -> list[dict]:
    with SessionLocal() as db:
        rows = db.query(AlertRow).order_by(AlertRow.timestamp.desc()).all()
        return [json.loads(r.payload) for r in rows]


def clear_alerts() -> None:
    """Used before persisting a fresh batch (new demo batch, dataset switch,
    or /ingest payload) so the alerts table always mirrors exactly what's
    currently shown, rather than accumulating every batch ever loaded.

    Deliberately leaves alert_actions alone: on a plain backend restart,
    run_pipeline() re-saves the *same* persisted alerts (same ids), and
    actions taken on them must survive that round-trip. Rows for ids that
    genuinely never reappear (e.g. after a real dataset switch) just become
    inert — cheap enough to leave as-is rather than add clear-on-switch
    logic that would risk wiping actions on the restart path too."""
    with SessionLocal() as db:
        db.query(AlertRow).delete()
        db.commit()


def get_actions() -> dict[str, dict]:
    with SessionLocal() as db:
        rows = db.query(AlertAction).all()
        return {
            r.alert_id: {
                "acked": r.acked,
                "assignee": r.assignee,
                "status_override": r.status_override,
                "escalated": r.escalated,
            }
            for r in rows
        }


def _get_or_create_action(db, alert_id: str) -> AlertAction:
    action = db.get(AlertAction, alert_id)
    if not action:
        action = AlertAction(alert_id=alert_id)
        db.add(action)
    return action


def set_ack(alert_id: str, value: bool) -> None:
    with SessionLocal() as db:
        action = _get_or_create_action(db, alert_id)
        action.acked = value
        action.updated_at = datetime.utcnow()
        db.commit()


def set_assignee(alert_id: str, assignee: str | None) -> None:
    with SessionLocal() as db:
        action = _get_or_create_action(db, alert_id)
        action.assignee = assignee
        action.updated_at = datetime.utcnow()
        db.commit()


def set_status_override(alert_id: str, status: str | None) -> None:
    with SessionLocal() as db:
        action = _get_or_create_action(db, alert_id)
        action.status_override = status
        action.updated_at = datetime.utcnow()
        db.commit()


def set_escalated(alert_id: str, value: bool) -> None:
    with SessionLocal() as db:
        action = _get_or_create_action(db, alert_id)
        action.escalated = value
        action.updated_at = datetime.utcnow()
        db.commit()


class EngineEventRow(Base):
    """Append-only log of the engine run: which scenario ran, then every human
    decision, late signal and push since. Scenarios are deterministic, so
    replaying this log after a restart rebuilds the same incident state."""

    __tablename__ = "engine_events"
    seq = Column(Integer, primary_key=True, autoincrement=True)
    kind = Column(String, nullable=False)
    payload = Column(Text, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)


def engine_events_clear() -> None:
    with SessionLocal() as db:
        db.query(EngineEventRow).delete()
        db.commit()


def engine_event_add(kind: str, payload: dict) -> None:
    with SessionLocal() as db:
        db.add(EngineEventRow(kind=kind, payload=json.dumps(payload, default=str)))
        db.commit()


def engine_events_load() -> list[dict]:
    with SessionLocal() as db:
        rows = db.query(EngineEventRow).order_by(EngineEventRow.seq).all()
        return [{"kind": r.kind, "payload": json.loads(r.payload)} for r in rows]


class MaintenanceWindowRow(Base):
    """A real time window during which alerts from a service (or every
    service, if unset) are suppressed - evaluated against wall-clock time on
    every run_pipeline() call, not a persisted per-alert action, so a window
    stops applying the moment it ends."""
    __tablename__ = "maintenance_windows"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False)
    service = Column(String, nullable=True)  # None = applies to every service
    start_time = Column(DateTime, nullable=False)
    end_time = Column(DateTime, nullable=False)
    enabled = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)


def _maintenance_window_dict(row: MaintenanceWindowRow) -> dict:
    now = datetime.utcnow()
    return {
        "id": row.id,
        "name": row.name,
        "service": row.service,
        "start_time": row.start_time.isoformat(),
        "end_time": row.end_time.isoformat(),
        "enabled": row.enabled,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "active": bool(row.enabled and row.start_time <= now <= row.end_time),
    }


def list_maintenance_windows() -> list[dict]:
    with SessionLocal() as db:
        rows = (
            db.query(MaintenanceWindowRow)
            .order_by(MaintenanceWindowRow.start_time.desc())
            .all()
        )
        return [_maintenance_window_dict(r) for r in rows]


def list_active_maintenance_windows() -> list[dict]:
    """Real, computed right now - not a cached "is active" flag that could
    go stale between pipeline runs."""
    now = datetime.utcnow()
    with SessionLocal() as db:
        rows = (
            db.query(MaintenanceWindowRow)
            .filter(
                MaintenanceWindowRow.enabled == True,  # noqa: E712
                MaintenanceWindowRow.start_time <= now,
                MaintenanceWindowRow.end_time >= now,
            )
            .all()
        )
        return [_maintenance_window_dict(r) for r in rows]


def create_maintenance_window(window_id: str, name: str, service: str | None,
                               start_time: datetime, end_time: datetime,
                               enabled: bool = True) -> dict:
    with SessionLocal() as db:
        row = MaintenanceWindowRow(
            id=window_id, name=name, service=service,
            start_time=start_time, end_time=end_time, enabled=enabled,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
        return _maintenance_window_dict(row)


def set_maintenance_window_enabled(window_id: str, enabled: bool) -> dict | None:
    with SessionLocal() as db:
        row = db.get(MaintenanceWindowRow, window_id)
        if not row:
            return None
        row.enabled = enabled
        db.commit()
        db.refresh(row)
        return _maintenance_window_dict(row)


def delete_maintenance_window(window_id: str) -> None:
    with SessionLocal() as db:
        row = db.get(MaintenanceWindowRow, window_id)
        if row:
            db.delete(row)
            db.commit()
