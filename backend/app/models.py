"""Pydantic schemas shared across the pipeline."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field


class Alert(BaseModel):
    id: str
    service: str
    alertname: str
    message: str
    severity: str  # info | high | critical
    status: str = "firing"
    timestamp: datetime
    source: str
    # Evaluation-only label from the synthetic generator; the pipeline never
    # reads it. Optional so real ingested alerts don't need it.
    ground_truth: str | None = None


class Cluster(BaseModel):
    cluster_id: int
    alerts: list[Alert]
    root_cause: Alert
    risk_score: float = 0.0
    risk_level: str = "low"  # low | medium | high
    dna_match: dict | None = None  # matched past incident, if any
    summary: str = ""


class Incident(BaseModel):
    incident_id: str
    title: str
    cluster: Cluster
    created_at: datetime = Field(default_factory=datetime.now)
    status: str = "open"
    est_triage_minutes_saved: int = 0
