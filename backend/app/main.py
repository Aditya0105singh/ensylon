"""FastAPI app for the Ensylon AIOps Challenge.

Runtime input is the three Nexus SSE streams and nothing else (challenge rule):
on startup the app loads the service dependency graph from the reference
endpoint and starts one reader per stream (app/engine/live.py). Everything the
dashboard shows comes from the engine routes under /engine.

Offline mode (AIOPS_OFFLINE_DEMO=1) additionally mounts the generated-scenario
and push-ingest routes and the legacy AlertLens batch routes. It exists for the
test suite, the benchmark and development without network access; it is off
by default and never feeds the live engine.

NEXUS_LIVE=0 skips connecting to the streams (tests, air-gapped dev).
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path

os.environ.setdefault("USE_TF", "0")

from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import threading
from concurrent.futures import ThreadPoolExecutor

from pydantic import BaseModel

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "data"))
from synthetic_alert_generator import generate_batch  # noqa: E402

from . import clustering, db, dedup, security
from .assistant import IncidentAssistantRequest, WorkspaceAssistantRequest, ask_incident_assistant, ask_workspace_assistant
from .engine.redaction import redact_alert_dicts
from .alert_dna import AlertDNA
from .clustering import cluster_alerts, group_by_label, pick_root_cause
from .correlation_explain import build_correlation_explanation
from .incident_ticket import approve_ticket, get_ticket
from .dedup import deduplicate
from .forecast import compute_forecast
from .root_cause_confidence import build_root_cause_confidence
from .playbook import generate_playbook
from .real_data_bgl import load_bgl_alerts
from .risk_score import escalation_risk
from .summarizer import summarize, summarize_with_source

OFFLINE_DEMO = os.environ.get("AIOPS_OFFLINE_DEMO", "").strip() == "1"
LIVE_STREAMS = os.environ.get("NEXUS_LIVE", "1").strip() != "0"


def _offline_only() -> None:
    """Legacy/synthetic inputs are not allowed as runtime input in the challenge."""
    if not OFFLINE_DEMO:
        raise HTTPException(status_code=404, detail="offline demo routes are disabled (AIOPS_OFFLINE_DEMO=1 enables them)")


_dna: AlertDNA | None = None
_state: dict = {"dedup_stats": None, "clusters": [], "noise": [], "raw_alerts": [], "evaluation": None, "dataset": "none", "redaction_counts": {}}

# An /ingest payload is arbitrary client JSON. These caps bound what a single
# request can turn into memory, DB rows and clustering work.
MAX_INGEST_ALERTS = 20_000

# Rough triage-time model for the MTTR framing: minutes an on-call engineer
# would spend manually reading and grouping this many raw alerts (~30s each),
# minus the ~2 min it takes to read one correlated incident card.
LLM_SUMMARY_LIMIT = 12
TRIAGE_SEC_PER_ALERT = 30
TRIAGE_MIN_PER_INCIDENT = 2

# Fixed incident_key -> seed_incident_library.json id, used only to measure
# whether Alert DNA matched the *correct* past incident (evaluation page).
EXPECTED_DNA_MATCH = {
    "db_connection_exhaustion": "INC-0389",
    "redis_memory_pressure": "INC-0412",
    "disk_full_logging": "INC-0367",
    "auth_cascade_failure": "INC-0401",
    "network_packet_loss": "INC-0355",
}
EVAL_SEEDS = [42, 7, 123, 2026, 555, 9, 77, 314]


def get_dna() -> AlertDNA:
    global _dna
    if _dna is None:
        _dna = AlertDNA()
    return _dna


def _apply_actions(alerts: list[dict]) -> list[dict]:
    """Merge persisted user actions (ack/assign/dismiss/escalate) onto a raw
    alert batch. Actions live in their own table keyed by alert id, separate
    from the alert payload itself, so they survive independently of whatever
    batch happened to bring that id in."""
    actions = db.get_actions()
    if not actions:
        return alerts
    merged = []
    for a in alerts:
        action = actions.get(a["id"])
        if not action:
            merged.append(a)
            continue
        a = dict(a)
        a["acked"] = action["acked"]
        a["assignee"] = action["assignee"]
        a["escalated"] = action["escalated"]
        if action["status_override"]:
            a["status"] = action["status_override"]
        merged.append(a)
    return merged


def _apply_maintenance_windows(alerts: list[dict]) -> list[dict]:
    """Real, wall-clock-evaluated suppression - unlike a manual dismiss,
    this isn't a persisted per-alert action, so it stops applying the
    instant a window's end_time passes, without needing anyone to undo it."""
    windows = db.list_active_maintenance_windows()
    if not windows:
        return alerts
    merged = []
    for a in alerts:
        if a.get("status") != "suppressed" and any(
            w["service"] is None or w["service"] == a.get("service")
            for w in windows
        ):
            a = dict(a)
            a["status"] = "suppressed"
        merged.append(a)
    return merged


_pipeline_lock = threading.Lock()


def run_pipeline(alerts: list[dict], dataset: str | None = None) -> dict:
    # The startup restore runs in a background thread; a request arriving
    # meanwhile must not clear/re-save the same rows concurrently. The dataset
    # label is set inside the lock so it always matches the batch just run.
    with _pipeline_lock:
        result = _run_pipeline(alerts)
        if dataset:
            _state["dataset"] = dataset
        return result


def _run_pipeline(alerts: list[dict]) -> dict:
    get_dna()

    # Redaction runs before the first write, for the same reason it does in
    # engine/pipeline.py: a store that never received PII cannot leak it. This
    # pipeline persists raw alerts to SQLite, so without this the "no PII
    # stored" constraint would hold on one pipeline and not the other.
    alerts, redaction_counts = redact_alert_dicts(alerts)

    # The DB always mirrors exactly the batch currently shown — each call
    # here represents a full replacement of "the current view" (a fresh demo
    # batch, a dataset switch, or a full /ingest payload), so persisted
    # actions from a previous, unrelated batch are cleared along with it.
    db.clear_alerts()
    db.save_alerts(alerts)
    alerts = _apply_actions(alerts)
    alerts = _apply_maintenance_windows(alerts)

    unique, dedup_stats = deduplicate(alerts)
    labels, _ = cluster_alerts(unique)
    groups = group_by_label(unique, labels)

    clusters = []
    for label, members in sorted(groups.items()):
        if label == -1:
            continue
        root = pick_root_cause(members)
        risk = escalation_risk(members)
        dna = _dna.match(members)
        raw_in_cluster = sum(m.get("duplicate_count", 1) for m in members)
        saved = max(round(raw_in_cluster * TRIAGE_SEC_PER_ALERT / 60) - TRIAGE_MIN_PER_INCIDENT, 0)
        clusters.append({
            "cluster_id": label,
            "size": len(members),
            "raw_alert_count": raw_in_cluster,
            "root_cause": root,
            "risk": risk,
            "dna_match": dna,
            "summary": summarize(members, root, dna, use_llm=False),
            "summary_source": "template",
            "est_triage_minutes_saved": saved,
            "alerts": sorted(members, key=lambda a: a["timestamp"]),
        })

    clusters.sort(key=lambda c: c["risk"]["score"], reverse=True)

    # LLM-written summaries only for the highest-risk incidents, fetched in
    # parallel; the rest keep the deterministic template so a large batch
    # (dozens of incidents) doesn't mean dozens of sequential LLM calls.
    top = clusters[:LLM_SUMMARY_LIMIT]
    with ThreadPoolExecutor(max_workers=8) as pool:
        for cluster, (text, source) in zip(
            top,
            pool.map(
                lambda c: summarize_with_source(c["alerts"], c["root_cause"], c["dna_match"]), top
            ),
        ):
            cluster["summary"] = text
            cluster["summary_source"] = source

    _state.update({
        "dedup_stats": dedup_stats,
        "clusters": clusters,
        "noise": groups.get(-1, []),
        "raw_alerts": sorted(alerts, key=lambda a: a["timestamp"], reverse=True),
        "redaction_counts": redaction_counts,
    })
    # Manual escalations persist straight to the DB, bypassing the alerts list
    # already built into _state - patch the escalated flag onto it in place so
    # it is visible in *this* response.
    actions = db.get_actions()
    for alert in _state["raw_alerts"]:
        action = actions.get(alert["id"])
        if action and action["escalated"]:
            alert["escalated"] = True
    for cluster in _state["clusters"]:
        for alert in cluster["alerts"]:
            action = actions.get(alert["id"])
            if action and action["escalated"]:
                alert["escalated"] = True
    return {
        "raw_alerts": dedup_stats["raw_count"],
        "after_dedup": dedup_stats["unique_count"],
        "clusters_formed": len(clusters),
        "uncorrelated": len(groups.get(-1, [])),
    }


def compute_evaluation() -> dict:
    """Measures the pipeline against the generator's hidden ground truth,
    across a fixed seed set — same methodology as notebooks/poc_clustering.ipynb.
    The pipeline never reads ground_truth; this is an external measurement.

    Also records each seed's own numbers (per_seed) alongside the combined
    total — real per-run results for a trend chart, not a single average
    smoothed over 8 runs."""
    get_dna()
    tp_n = tp_d = dna_ok = dna_t = frag = missed = inc_total = noise_cl = noise_total = 0
    per_seed = []

    for seed in EVAL_SEEDS:
        raw = generate_batch(3, 20, 45, seed=seed)
        unique, _ = deduplicate(raw)
        labels, _ = cluster_alerts(unique)
        groups = group_by_label(unique, labels)

        incidents = {a["ground_truth"] for a in unique if a["ground_truth"] != "noise"}
        inc_total += len(incidents)
        noise_total += sum(1 for a in unique if a["ground_truth"] == "noise")
        inc_map: dict[str, set] = {i: set() for i in incidents}

        # seed-local counters, separate from the running totals above
        s_tp_n = s_tp_d = s_noise_cl = 0
        s_noise_total = sum(1 for a in unique if a["ground_truth"] == "noise")
        s_inc_total = len(incidents)

        for label, members in groups.items():
            if label == -1:
                continue
            counts: dict[str, int] = {}
            for a in members:
                counts[a["ground_truth"]] = counts.get(a["ground_truth"], 0) + 1
            majority = max(counts, key=counts.get)
            tp_n += counts[majority]
            tp_d += len(members)
            noise_cl += counts.get("noise", 0)
            s_tp_n += counts[majority]
            s_tp_d += len(members)
            s_noise_cl += counts.get("noise", 0)
            for truth in counts:
                if truth != "noise":
                    inc_map[truth].add(label)
            if majority in EXPECTED_DNA_MATCH:
                dna_t += 1
                match = _dna.match(members)
                if match and match["incident_id"] == EXPECTED_DNA_MATCH[majority]:
                    dna_ok += 1

        s_missed = sum(1 for v in inc_map.values() if not v)
        frag += sum(max(0, len(v) - 1) for v in inc_map.values())
        missed += s_missed

        per_seed.append({
            "seed": seed,
            "incident_detection_pct": round(100 * (s_inc_total - s_missed) / s_inc_total, 1) if s_inc_total else 0,
            "cluster_purity_pct": round(100 * s_tp_n / s_tp_d, 1) if s_tp_d else 0,
            "noise_excluded_pct": round(100 * (1 - s_noise_cl / s_noise_total), 1) if s_noise_total else 0,
        })

    return {
        "seeds_tested": len(EVAL_SEEDS),
        "per_seed": per_seed,
        "incidents_total": inc_total,
        "incidents_detected": inc_total - missed,
        "incident_detection_pct": round(100 * (inc_total - missed) / inc_total, 1) if inc_total else 0,
        "cluster_purity_pct": round(100 * tp_n / tp_d, 1) if tp_d else 0,
        "fragmentation_events": frag,
        "noise_excluded_pct": round(100 * (1 - noise_cl / noise_total), 1) if noise_total else 0,
        "dna_correct": dna_ok,
        "dna_total": dna_t,
        "dna_accuracy_pct": round(100 * dna_ok / dna_t, 1) if dna_t else 0,
    }


def _initial_load() -> None:
    # A prior run's batch survives a backend restart in alertlens.db — reload
    # it instead of generating a brand new synthetic batch so acks/dismissed/
    # assignee actions (and whatever dataset was loaded) aren't silently lost
    # every time the server restarts. Holds the pipeline lock for the whole
    # decision and yields to any request that already loaded a batch, so a
    # slow restore can never overwrite what the user just chose.
    with _pipeline_lock:
        if _state["dataset"] != "none":
            return
        persisted = db.load_alerts()
        if persisted:
            _run_pipeline(persisted)
            # Which dataset these came from wasn't itself persisted, so this
            # is deliberately honest rather than guessed.
            _state["dataset"] = "restored-from-db"
            return
        _run_pipeline(generate_batch(n_incidents=4, n_noise=80, window_minutes=45,
                                     seed=7, noise_window_hours=48))
        _state["dataset"] = "synthetic"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    if not OFFLINE_DEMO:
        # Live mode: the Nexus streams are the only input. No synthetic batch,
        # no replayed demo log - an empty dashboard until the streams speak.
        try:
            engine_api.start_live(connect=LIVE_STREAMS)
        except Exception:
            import logging
            logging.getLogger(__name__).exception("could not start the live stream runtime")
        yield
        engine_api.stop_live()
        return
    # Offline demo mode below. Rebuild the engine run (incident, decisions, Jira keys) from its event log,
    # then keep recording. Never blocks startup if the log is stale.
    try:
        engine_api.enable_persistence()
        restored = engine_api.restore_from_log()
        # Hosts with an ephemeral disk (e.g. a free Render instance that sleeps)
        # come back with nothing to replay, so a visitor would land on an empty
        # engine. Opt-in: re-run the deterministic golden scenario instead, the
        # same run "Inject failure" produces. Paging is suppressed as with a
        # replay, because nobody should be paged for a demo seeding itself.
        if not restored and os.environ.get("ALERTLENS_AUTOSEED_GOLDEN", "").strip() == "1":
            engine_api.seed_golden_quietly()
    except Exception:
        pass
    # Loading sentence-transformers/torch is real, unavoidable work — on a
    # low-CPU/low-RAM free-tier host it can take minutes. Running it inline
    # here blocks uvicorn from ever binding its port, which reads as a
    # failed deploy on platforms that health-check via port scan (Render).
    # Push it to a background thread instead: the server comes up and
    # responds immediately; GET /pipeline just returns the empty initial
    # state until this finishes, same as it would for any first-ever visit
    # before the frontend calls a /demo/load* route.
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _initial_load)
    yield


app = FastAPI(title="Alert Correlation & Dedup Engine", lifespan=lifespan)

# Order matters: the last middleware added is the outermost, so CORS answers a
# preflight before the security layer sees it. A browser preflight carries no
# X-API-Key by design, and rejecting it would break every legitimate call.
app.add_middleware(security.SecurityMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=security.allowed_origins(),
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-API-Key"],
)

# AIOps engine (app/engine/) — a separate pipeline exposed under
# its own prefix rather than folded into the routes above, so it can evolve
# independently of the original AlertLens demo endpoints.
from . import engine_api  # noqa: E402
from .engine_api import offline_router as engine_offline_router  # noqa: E402
from .engine_api import router as engine_router  # noqa: E402
app.include_router(engine_router)
if OFFLINE_DEMO:
    app.include_router(engine_offline_router)


def _validate_ingest(alerts: list[dict]) -> None:
    """Reject a malformed batch before the pipeline touches the database.

    `_run_pipeline` clears the alerts table before writing the new batch, and
    `db.save_alerts` indexes `id` and `timestamp` directly. Validating here
    rather than there is the whole point: without it, a single POST of `[{}]`
    wiped the table and *then* raised, so a malformed anonymous request was a
    destructive one.
    """
    security.require_items(alerts, MAX_INGEST_ALERTS, "alerts")
    for index, alert in enumerate(alerts):
        if not isinstance(alert, dict):
            raise HTTPException(status_code=422, detail=f"alert {index} is not an object")
        for required in ("id", "timestamp"):
            if required not in alert:
                raise HTTPException(
                    status_code=422, detail=f"alert {index} is missing required field '{required}'"
                )
        if not isinstance(alert["id"], str) or not alert["id"].strip():
            raise HTTPException(
                status_code=422, detail=f"alert {index} has a non-string or empty 'id'"
            )
        stamp = alert["timestamp"]
        if isinstance(stamp, datetime):
            continue
        if not isinstance(stamp, str):
            raise HTTPException(
                status_code=422, detail=f"alert {index} has a non-string 'timestamp'"
            )
        try:
            datetime.fromisoformat(stamp)
        except ValueError:
            raise HTTPException(
                status_code=422,
                detail=f"alert {index} has a 'timestamp' that is not ISO-8601: {stamp!r}",
            )

    ids = [a["id"] for a in alerts]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=422, detail="alert ids must be unique within a batch")


@app.post("/ingest")
def ingest(alerts: list[dict]) -> dict:
    _offline_only()
    _validate_ingest(alerts)
    return run_pipeline(alerts, dataset="custom-ingest")


@app.post("/demo/load")
def demo_load(incidents: int = 4, noise: int = 80, seed: int | None = None,
              scenario: str | None = None) -> dict:
    _offline_only()
    return run_pipeline(generate_batch(incidents, noise, 45, seed=seed,
                                       noise_window_hours=48, force_scenario=scenario),
                        dataset="synthetic")


@app.post("/demo/load-bgl")
def demo_load_bgl() -> dict:
    """Loads the 10,000-alert real Loghub BGL (BlueGene/L supercomputer) sample
    through the same pipeline. See data/loghub_bgl_loader.py for the disclosed
    sampling and severity mapping."""
    _offline_only()
    return run_pipeline(load_bgl_alerts(), dataset="loghub-bgl")


@app.post("/demo/inject-chaos")
def demo_inject_chaos(scenario: str = "db_connection_exhaustion") -> dict:
    """Live Chaos Engineering Fault Injector.
    Forces a specific real-time infrastructure failure scenario into a fresh synthetic batch."""
    _offline_only()
    return run_pipeline(generate_batch(n_incidents=4, n_noise=60, window_minutes=30,
                                       force_scenario=scenario, noise_window_hours=24))



@app.get("/health")
def health() -> dict:
    """Liveness probe — the one route reachable without a key.

    Deliberately says nothing about incidents, alerts or configuration: an
    orchestrator needs to know the process is up, and an anonymous caller
    should learn nothing else.
    """
    return {"status": "ok"}


@app.get("/pipeline")
def pipeline_state() -> dict:
    return _state


class AckRequest(BaseModel):
    value: bool


class AssignRequest(BaseModel):
    assignee: str | None = None


class DismissRequest(BaseModel):
    status: str | None = None  # "suppressed" | "resolved" | None (None clears the override)


class EscalateRequest(BaseModel):
    value: bool


def _rerun_current_pipeline() -> dict:
    """Actions below change how an already-loaded batch renders (ack badge,
    assignee, status override) — not the batch itself — so replay the last
    persisted batch through the pipeline rather than regenerating anything."""
    return run_pipeline(db.load_alerts())


@app.post("/alerts/{alert_id}/ack")
def ack_alert(alert_id: str, body: AckRequest) -> dict:
    db.set_ack(alert_id, body.value)
    return _rerun_current_pipeline()


@app.post("/alerts/{alert_id}/assign")
def assign_alert(alert_id: str, body: AssignRequest) -> dict:
    db.set_assignee(alert_id, body.assignee)
    return _rerun_current_pipeline()


@app.post("/alerts/{alert_id}/dismiss")
def dismiss_alert(alert_id: str, body: DismissRequest) -> dict:
    db.set_status_override(alert_id, body.status)
    return _rerun_current_pipeline()


@app.post("/alerts/{alert_id}/escalate")
def escalate_alert(alert_id: str, body: EscalateRequest) -> dict:
    db.set_escalated(alert_id, body.value)
    return _rerun_current_pipeline()


@app.get("/forecast/{incident_id}")
def get_forecast(incident_id: str) -> dict:
    """Predictive Blast Radius Forecast endpoint.
    Computes an explainable forecast for the specified incident_id (cluster_id)
    reusing in-memory pipeline state.
    """
    clusters = _state.get("clusters", [])
    cluster = next((c for c in clusters if str(c.get("cluster_id")) == str(incident_id)), None)
    if not cluster:
        raise HTTPException(status_code=404, detail=f"Incident {incident_id} not found in pipeline state")
    return compute_forecast(cluster)


@app.get("/incidents/{incident_id}/comparison")
def get_incident_comparison(incident_id: str) -> dict:
    """Historical Incident Comparator endpoint.
    Compares the specified current incident against its matched historical Alert DNA
    incident using existing pipeline state without re-embedding.
    """
    clusters = _state.get("clusters", [])
    cluster = next((c for c in clusters if str(c.get("cluster_id")) == str(incident_id)), None)
    if not cluster:
        raise HTTPException(status_code=404, detail=f"Incident {incident_id} not found in pipeline state")

    dna = cluster.get("dna_match")
    root = cluster.get("root_cause", {})
    risk = cluster.get("risk", {})
    alerts = cluster.get("alerts", [])
    current_services = list({a.get("service") for a in alerts if a.get("service")})
    current_risk_pct = int(round(risk.get("score", 0.5) * 100))

    if not dna:
        # Novel incident signature response
        return {
            "incident_id": incident_id,
            "has_match": False,
            "similarity": 0.0,
            "confidence": 0.0,
            "similarity_breakdown": {
                "root_cause": 0,
                "affected_services": 0,
                "timeline_pattern": 0,
                "alert_pattern": 0,
                "severity_trend": 0,
            },
            "current_incident": {
                "service": root.get("service", "unknown"),
                "alertname": root.get("alertname", "unknown"),
                "severity": root.get("severity", "info"),
                "risk_score": current_risk_pct,
                "risk_level": risk.get("level", "low"),
                "alert_count": cluster.get("raw_alert_count", len(alerts)),
                "services": current_services,
            },
            "historical_incident": None,
            "comparison_metrics": [],
            "timeline_comparison": {"current": [], "historical": []},
            "historical_resolution": None,
            "suggested_actions": [f"Investigate novel symptom pattern on {root.get('service')}."],
        }

    # Everything below is either measured directly off this incident and the
    # matched library entry, or explicitly marked as an estimate — no field is
    # a plausible-looking number invented to fill a slot the data doesn't
    # have. The seed library records only title/date/root_cause/resolution/
    # resolution_minutes/services_affected, so a past severity, risk score or
    # alert count simply isn't there to compare against, and this endpoint
    # used to fabricate "CRITICAL" / "91% (HIGH)" / "18 alerts" for every
    # single match. That's gone.
    similarity_pct = float(dna.get("similarity_pct", 85.0))
    hist_services = dna.get("services_affected", [])
    overlap = len(set(current_services).intersection(set(hist_services)))
    svc_overlap_pct = int(round((overlap / max(1, len(current_services))) * 100)) if current_services else 0
    root_in_text = bool(root.get("service")) and root.get("service") in dna.get("root_cause", "")

    # Real, measured similarity: the TF-IDF cosine AlertDNA actually computed,
    # and how much of the current incident's service set overlaps with the
    # matched incident's. Two numbers, both honest, rather than five that
    # look independently measured but are algebra on one of them.
    breakdown = {
        "symptom_similarity": round(similarity_pct),
        "service_overlap": svc_overlap_pct,
    }

    diff_services = "match" if current_services and set(current_services) == set(hist_services) else (
        "partial" if overlap else "different"
    )

    metrics = [
        {"field": "Root Cause", "current": f"{root.get('service')} / {root.get('alertname')}",
         "historical": dna.get("root_cause", dna.get("title")),
         "status": "partial" if root_in_text else "different"},
        {"field": "Affected Services", "current": ", ".join(current_services[:4]) or "none recorded",
         "historical": ", ".join(hist_services[:4]) or "none recorded", "status": diff_services},
        {"field": "Estimated triage time saved (now) vs actual resolution time (then)",
         "current": f"~{cluster.get('est_triage_minutes_saved', 0)} min", "historical": f"{dna.get('resolution_minutes', 0)} min",
         "status": "info"},
        {"field": "Playbook Resolution", "current": "Pending operator action",
         "historical": dna.get("resolution", "n/a"), "status": "different"},
    ]

    current_timeline = [{"time": a.get("timestamp", "")[11:19], "text": f"{a.get('service')}: {a.get('alertname')}"} for a in alerts[:4]]
    # The library never recorded real timestamps for its symptom list, only
    # their order — labelling them "T+2m" implied a measured cadence that was
    # never captured, so these are ordinal ("Symptom 1", "Symptom 2", ...).
    historical_symptoms = [s.strip() for s in dna.get("symptom_pattern", "").split(",") if s.strip()]
    historical_timeline = [{"time": f"Symptom {i + 1}", "text": symp} for i, symp in enumerate(historical_symptoms[:4])]

    return {
        "incident_id": incident_id,
        "has_match": True,
        "similarity": similarity_pct,
        "confidence": round(similarity_pct / 100, 2),
        "similarity_breakdown": breakdown,
        "current_incident": {
            "service": root.get("service"),
            "alertname": root.get("alertname"),
            "severity": root.get("severity"),
            "risk_score": current_risk_pct,
            "risk_level": risk.get("level"),
            "alert_count": cluster.get("raw_alert_count", len(alerts)),
            "services": current_services,
        },
        "historical_incident": dna,
        "comparison_metrics": metrics,
        "timeline_comparison": {
            "current": current_timeline,
            "historical": historical_timeline,
        },
        "historical_resolution": dna.get("resolution"),
        "resolution_minutes": dna.get("resolution_minutes"),
        "suggested_actions": [
            f"Execute verified playbook from {dna.get('incident_id')}: {dna.get('resolution')}",
            f"Verify upstream dependency status on {root.get('service')}.",
            "Monitor downstream consumer service queue depths.",
        ],
    }


@app.get("/incidents/{incident_id}/root_cause_confidence")
def get_root_cause_confidence(incident_id: str) -> dict:
    """Root Cause Confidence Graph (XAI) endpoint.
    Computes deterministic confidence scores and candidate explanations for the specified incident_id.
    """
    clusters = _state.get("clusters", [])
    cluster = next((c for c in clusters if str(c.get("cluster_id")) == str(incident_id)), None)
    if not cluster:
        raise HTTPException(status_code=404, detail=f"Incident {incident_id} not found in pipeline state")
    return build_root_cause_confidence(cluster)


@app.get("/incidents/{incident_id}/correlation")
def get_incident_correlation(incident_id: str) -> dict:
    """Why these alerts were grouped: the real factor scores, the checks that
    passed, and the near-miss alerts the clusterer left out - all recomputed
    with the same distance the run used. See app/correlation_explain.py."""
    clusters = _state.get("clusters", [])
    cluster = next((c for c in clusters if str(c.get("cluster_id")) == str(incident_id)), None)
    if not cluster:
        raise HTTPException(status_code=404, detail=f"Incident {incident_id} not found in pipeline state")
    return build_correlation_explanation(cluster, clusters, _state.get("noise", []))


@app.get("/incidents/{incident_id}/ticket")
def get_incident_ticket(incident_id: str) -> dict:
    """The reviewable ticket draft for this incident, plus its review state.
    Read-only. See app/incident_ticket.py for how it is composed."""
    clusters = _state.get("clusters", [])
    cluster = next((c for c in clusters if str(c.get("cluster_id")) == str(incident_id)), None)
    if not cluster:
        raise HTTPException(status_code=404, detail=f"Incident {incident_id} not found in pipeline state")
    return get_ticket(cluster, clusters, _state.get("noise", []))


@app.post("/incidents/{incident_id}/ticket/approve")
def approve_incident_ticket(incident_id: str, actor: str = "on-call") -> dict:
    """Publish the draft through the review gate, which requires a
    named human approver. No Jira credentials are configured here, so the
    gate's mock transport records the payload and returns a synthetic key -
    the response reports that as jira.mode == "simulated"."""
    clusters = _state.get("clusters", [])
    cluster = next((c for c in clusters if str(c.get("cluster_id")) == str(incident_id)), None)
    if not cluster:
        raise HTTPException(status_code=404, detail=f"Incident {incident_id} not found in pipeline state")
    return approve_ticket(cluster, clusters, _state.get("noise", []), actor=actor)


@app.get("/incidents/{incident_id}/playbook")
def get_incident_playbook(incident_id: str) -> dict:
    """AI Remediation Playbook endpoint.
    Generates structured, step-by-step incident response runbooks for the specified incident_id.
    """
    clusters = _state.get("clusters", [])
    cluster = next((c for c in clusters if str(c.get("cluster_id")) == str(incident_id)), None)
    if not cluster:
        raise HTTPException(status_code=404, detail=f"Incident {incident_id} not found in pipeline state")
    return generate_playbook(cluster)


@app.get("/evaluation")
def evaluation_state() -> dict:
    if _state["evaluation"] is None:
        get_dna()
        _state["evaluation"] = compute_evaluation()
    return _state["evaluation"]


@app.get("/debug/summarizer-check")
def debug_summarizer_check() -> dict:
    """One-click check for whether the LLM summarizer is actually reachable
    from wherever the backend is running — hit this in a browser tab and
    read the JSON. Tries every configured provider (Cerebras, then Groq) and
    reports which one actually worked, so a WAF/network block on one
    provider from one host doesn't look like a code bug."""
    from . import summarizer

    providers = summarizer._configured_providers()
    if not providers:
        return {"status": "no_key", "detail": "Neither CEREBRAS_API_KEY nor GROQ_API_KEY is set"}

    fake_alerts = [{"service": "test-service", "alertname": "TestAlert",
                     "message": "Synthetic check message", "severity": "high"}]
    fake_root = fake_alerts[0]
    prompt = summarizer._build_prompt(fake_alerts, fake_root, None)
    attempts = []
    for provider, api_key, url, model in providers:
        try:
            text = summarizer._call_chat_api(api_key, url, model, prompt)
            return {"status": "working", "provider": provider, "sample_output": text}
        except Exception as e:
            attempts.append(f"{provider}: {e}")
    return {"status": "failed", "detail": "All configured providers failed: " + " | ".join(attempts)}

@app.post("/assistant")
def assistant(payload: IncidentAssistantRequest) -> dict:
    return ask_incident_assistant(_state, payload)


@app.post("/assistant/workspace")
def assistant_workspace(payload: WorkspaceAssistantRequest) -> dict:
    """Global chat widget endpoint — incident-specific when incident_id is set,
    workspace-mode (live pipeline snapshot) otherwise."""
    return ask_workspace_assistant(_state, payload)


@app.get("/settings/status")
def settings_status() -> dict:
    """Real system status: which dataset is loaded, how many alerts are
    persisted, and whether an LLM provider is genuinely reachable (reuses the
    same check /debug/summarizer-check uses)."""
    from . import summarizer

    configured = summarizer._configured_providers()
    return {
        "dataset": _state.get("dataset", "none"),
        "persisted_alert_count": len(db.load_alerts()),
        "active_incident_count": len(_state.get("clusters", [])),
        "llm_configured": bool(configured),
        "llm_provider": configured[0][0] if configured else None,
        # File name only: the absolute path would expose the host's directory layout.
        "db_path": db.DB_PATH.name,
    }


class MaintenanceWindowCreate(BaseModel):
    name: str
    service: str | None = None  # None = applies to every service
    start_time: datetime
    end_time: datetime
    enabled: bool = True


class MaintenanceWindowUpdate(BaseModel):
    enabled: bool


@app.get("/maintenance")
def list_maintenance_windows() -> list[dict]:
    return db.list_maintenance_windows()


@app.post("/maintenance")
def create_maintenance_window(body: MaintenanceWindowCreate) -> dict:
    if body.end_time <= body.start_time:
        raise HTTPException(status_code=400, detail="end_time must be after start_time")
    window_id = uuid.uuid4().hex[:8]
    return db.create_maintenance_window(
        window_id, body.name, body.service, body.start_time, body.end_time, body.enabled,
    )


@app.put("/maintenance/{window_id}")
def update_maintenance_window(window_id: str, body: MaintenanceWindowUpdate) -> dict:
    window = db.set_maintenance_window_enabled(window_id, body.enabled)
    if not window:
        raise HTTPException(status_code=404, detail=f"Maintenance window {window_id} not found")
    return window


@app.delete("/maintenance/{window_id}")
def delete_maintenance_window(window_id: str) -> dict:
    db.delete_maintenance_window(window_id)
    return {"status": "deleted"}
