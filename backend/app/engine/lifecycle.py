"""Stateful incidents: a late signal joins the open incident, it does not fork one.

A correlation pass over a batch is not how incidents behave. Failures keep
emitting after the first ticket exists. Treating each pass as a new batch turns
one ongoing failure into several tickets, so an incident here is an object with
an identity that accumulates evidence:

    open -> drafting -> in_review -> published -> resolved

A late signal is attached only if it meets the same bar the correlator uses to
merge two signals: the shared-context gate (same service, dependency edge,
common trace) AND a weighted similarity at or above the merge threshold, with
at least one member. The gate alone is not enough: an open incident would then
grow one dependency hop at a time and swallow every unrelated failure nearby
(seen on the live simulator, where an SMTP outage joined a DB incident through
carrier-service). Time alone never attaches anything. A shared trace id is the
same request, so it attaches on its own.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import Any

from . import causal as causal_mod
from . import correlate as corr
from .correlate import DependencyGraph, _gate_reason, near_misses, similarity
from .drafting import ExcludedSignal, build_draft
from .pipeline import IncidentResult, PipelineResult
from .redaction import redact_signal
from .review import DraftStatus, ReviewQueue
from .severity import score_incident
from .signal import Signal

# An incident stays open until a human resolves it, but a signal hours later on
# the same service is a new problem, not a late arrival of this one.
LATE_ATTACH_MAX_MIN = 60.0

_OPEN_STATUSES = (DraftStatus.AWAITING_REVIEW, DraftStatus.PUBLISHED)


def _find_incident(
    result: PipelineResult, queue: ReviewQueue, graph: DependencyGraph, signal: Signal
) -> tuple[IncidentResult, str] | None:
    """The open incident this signal may join, with the gate reason, or None."""
    horizon = timedelta(minutes=LATE_ATTACH_MAX_MIN)
    threshold = 1.0 - corr.EPS
    # rank: shared trace first, then the strongest similarity to any member
    best: tuple[tuple[int, float], IncidentResult, str] | None = None
    for incident in result.incidents:
        item = queue.items.get(incident.draft.draft_id)
        if item is None or item.status not in _OPEN_STATUSES or item.lifecycle == "resolved":
            continue
        if signal.timestamp > incident.cluster.end + horizon:
            continue
        for member in incident.cluster.signals:
            gate = _gate_reason(signal, member, graph)
            if gate is None:
                continue
            if gate == "shared trace_id":
                key = (0, 0.0)
            else:
                sim = similarity(signal, member, graph)
                if sim is None or sim.total < threshold:
                    continue
                key = (1, -sim.total)
            if best is None or key < best[0]:
                best = (key, incident, gate)
    return None if best is None else (best[1], best[2])


def attach_late_signal(
    result: PipelineResult,
    graph: DependencyGraph,
    queue: ReviewQueue,
    signal: Signal,
    use_llm: bool = False,
    criticality: dict[str, float] | None = None,
    maintenance: list | None = None,
    record: bool = True,
) -> dict[str, Any]:
    """Route one late signal: attach to an open incident, or park it as noise.

    `record=False` is for the streaming engine, which has already stored the
    signal and keeps an unmatched one as a pending candidate for a *new*
    incident rather than writing it off as noise.
    """
    redact_signal(signal)  # before storage, like every other signal
    signal.is_anomaly = True

    match = _find_incident(result, queue, graph, signal)
    if match is None:
        if record:
            result.noise.append(signal)
            result.signals.append(signal)
        return {"attached": False, "reason": "no shared service, dependency edge, or trace with any open incident",
                "draft_id": None, "incidents": len(result.incidents)}

    incident, gate = match
    cluster = incident.cluster

    repeat = next((m for m in cluster.signals if m.context_key == signal.context_key), None)
    if repeat is not None:
        repeat.occurrence_count += signal.occurrence_count   # same condition again
        note = f"{signal.service}: another occurrence of an existing signal (x{repeat.occurrence_count})"
    else:
        cluster.signals.append(signal)
        note = f"{signal.service}: {(signal.metric or signal.message)[:60]}"
    if record:
        result.signals.append(signal)

    analysed = causal_mod.analyse(cluster, graph)
    severity = score_incident(cluster, analysed, graph, maintenance, criticality)
    excluded = [
        ExcludedSignal(service=s.service, at=s.timestamp,
                       detail=(s.metric or s.message or "")[:70], reason=reason)
        for s, reason in near_misses(cluster, result.noise, graph)
    ]
    draft = build_draft(cluster, analysed, severity, excluded, use_llm=use_llm)

    change = ""
    if incident.draft.priority != draft.priority:
        change = f"; priority re-scored {incident.draft.priority} -> {draft.priority} ({draft.severity_line})"
    item = queue.attach_update(incident.draft.draft_id, draft, f"{note} (joined via {gate}){change}")
    incident.causal, incident.severity, incident.draft = analysed, severity, item.draft
    return {
        "attached": True, "gate": gate, "draft_id": item.draft.draft_id,
        "commented_on_jira": item.jira_key if item.status == DraftStatus.PUBLISHED else None,
        "incidents": len(result.incidents),
    }
