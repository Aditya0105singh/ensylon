"""DRAFT — turn an analysed incident into a human-ready Jira ticket.

Facts and prose come from two different mechanisms, deliberately.

Everything a reviewer needs to *act* — title, priority, affected services,
evidence timeline, root cause, what was considered and excluded — is assembled
deterministically from the cluster. It is reproducible on replay, debuggable
when wrong, and identical every time the same incident is drafted.

Only the narrative summary and the suggested investigation steps come from an
LLM, and its prompt is restricted to facts already computed above. The model
narrates data it is handed; it is never the source of a fact.

That boundary is what makes the output safe to put in front of a reviewer. A
hallucinated sentence is visible and correctable in seconds. A hallucinated
severity score would not be — it would look exactly like a real one.

If no LLM is configured, or the call fails, drafting degrades to a templated
summary and a rule-derived checklist rather than failing. A ticket with plain
prose still gets the incident in front of a human; no ticket does not.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime

from .causal import CausalResult
from .history import match_history
from .correlate import Cluster
from .severity import SeverityBreakdown
from .signal import Signal, SignalSource

MAX_TIMELINE_ROWS = 12


@dataclass
class TimelineEntry:
    at: datetime
    source: str
    service: str
    detail: str
    count: int = 1

    def render(self) -> str:
        stamp = self.at.strftime("%H:%M:%S")
        multiplier = f" ×{self.count}" if self.count > 1 else ""
        return f"{stamp}  [{self.source}]  {self.service}{multiplier} — {self.detail}"


@dataclass
class ExcludedSignal:
    service: str
    at: datetime
    detail: str
    reason: str


@dataclass
class IncidentDraft:
    """A complete ticket, pending human review. Never auto-published."""

    draft_id: str
    title: str
    priority: str
    severity_score: float
    severity_line: str
    correlation_confidence: float
    causal_confidence: int
    root_cause_service: str | None
    root_cause_detail: str
    affected_services: list[str]
    signal_count: int
    started_at: datetime
    timeline: list[TimelineEntry]
    considered_excluded: list[ExcludedSignal]
    severity_factors: dict[str, str]
    causal_reasoning: list[str]
    summary: str = ""
    investigation_steps: list[str] = field(default_factory=list)
    summary_source: str = "template"
    suppressed: bool = False
    suppression_reason: str = ""
    redaction_kinds: list[str] = field(default_factory=list)
    historical_match: dict | None = None   # context only, from history.py
    status: str = "awaiting_review"
    # Observed facts (deterministic) kept apart from the hypothesis about cause.
    facts: list[str] = field(default_factory=list)
    suspected_root_cause: str = ""
    drafted_by: str = "template"

    # Fields a reviewer may change with edit-and-approve. Everything else is
    # computed evidence and stays as the engine produced it.
    EDITABLE = ("title", "priority", "summary", "suspected_root_cause",
                "investigation_steps", "affected_services")

    def to_ticket(self) -> dict:
        """The ticket as the challenge specifies it (written on approval)."""
        return {
            "draft_id": self.draft_id,
            "title": self.title,
            "severity": {"priority": self.priority, "impact_0_100": round(self.severity_score * 100),
                         "detail": self.severity_line},
            "correlation_confidence": round(self.correlation_confidence, 3),
            "affected_services": self.affected_services,
            "started_at": self.started_at.isoformat(),
            "timeline": [{"at": e.at.isoformat(), "source": e.source, "service": e.service,
                          "evidence": e.detail, "count": e.count} for e in self.timeline],
            "facts": self.facts,
            "summary": self.summary,
            "suspected_root_cause": self.suspected_root_cause,
            "root_cause_service": self.root_cause_service,
            "investigation_steps": self.investigation_steps,
            "considered_and_excluded": [{"service": x.service, "at": x.at.isoformat(),
                                         "evidence": x.detail, "reason": x.reason}
                                        for x in self.considered_excluded],
            "redacted_before_processing": self.redaction_kinds,
            "drafted_by": self.drafted_by,
        }

    def render_markdown(self) -> str:
        lines = [
            f"# {self.title}", "",
            f"**Severity:** {self.priority} - impact {round(self.severity_score * 100)}/100",
            f"**Correlation confidence:** {self.correlation_confidence:.2f}",
            f"**Services:** {', '.join(self.affected_services)}",
            f"**Started:** {self.started_at.isoformat()}", "",
            "## Summary (observed)", self.summary or "(none)", "",
            "## Facts", *[f"- {f}" for f in self.facts], "",
            "## Timeline", "| time (UTC) | source | service | evidence |", "|---|---|---|---|",
            *[f"| {e.at.strftime('%H:%M:%S')} | {e.source} | {e.service} | "
              f"{e.detail.replace('|', '/')}{f' (x{e.count})' if e.count > 1 else ''} |" for e in self.timeline],
            "", "## Suspected root cause (hypothesis, not confirmed)", self.suspected_root_cause or "(none)",
            "", "## Investigation steps", *[f"{i}. {st}" for i, st in enumerate(self.investigation_steps, 1)],
        ]
        if self.considered_excluded:
            lines += ["", "## Considered and excluded",
                      *[f"- {x.service} at {x.at.strftime('%H:%M:%S')}: {x.reason}" for x in self.considered_excluded]]
        lines += ["", f"_PII redacted before processing: {', '.join(self.redaction_kinds) or 'none found'}. "
                      f"Drafted by {self.drafted_by}; written only after human approval._"]
        return "\n".join(lines)

    def to_jira_fields(self) -> dict:
        """Shape this into Jira REST API v3 issue fields."""
        return {
            "summary": self.title,
            "description": self.render_description(),
            "labels": ["alertlens", f"priority-{self.priority.lower()}"]
                      + [f"svc-{s}" for s in self.affected_services[:5]],
        }

    def render_description(self) -> str:
        lines = [
            f"*Severity*: {self.severity_line}",
            f"*Correlation confidence*: {self.correlation_confidence:.2f}",
            f"*Causal confidence*: {self.causal_confidence}%",
            "",
            f"*Root cause*: {self.root_cause_detail}",
            "",
            f"*Affected services* ({len(self.affected_services)}): "
            + ", ".join(self.affected_services),
            "",
            "*Summary*",
            self.summary or "(no summary available)",
            "",
            "*Evidence timeline*",
        ]
        lines += [f"  {entry.render()}" for entry in self.timeline]

        if self.causal_reasoning:
            lines += ["", "*Why this root cause*"]
            lines += [f"  - {reason}" for reason in self.causal_reasoning]

        if self.investigation_steps:
            lines += ["", "*Suggested investigation*"]
            lines += [f"  {i}. {step}" for i, step in enumerate(self.investigation_steps, 1)]

        if self.considered_excluded:
            lines += ["", "*Considered and excluded*"]
            lines += [
                f"  - {x.service} at {x.at.strftime('%H:%M:%S')} ({x.detail}) — {x.reason}"
                for x in self.considered_excluded
            ]

        lines += ["", "*Severity factors*"]
        lines += [f"  - {name}: {detail}" for name, detail in self.severity_factors.items()]

        if self.redaction_kinds:
            lines += ["", f"_Redacted before processing: {', '.join(self.redaction_kinds)}_"]
        if self.suppressed:
            lines += ["", f"_Suppressed from escalation: {self.suppression_reason}_"]

        lines += ["", "_Drafted by AlertLens. Not published until a human approves._"]
        return "\n".join(lines)


# --------------------------------------------------------------------------
# deterministic assembly
# --------------------------------------------------------------------------

# The challenge's canonical source names, so every timeline row says which
# stream it came from.
_SOURCE_LABEL = {
    SignalSource.CLOUDWATCH_METRIC: "cloudwatch_metrics",
    SignalSource.CLOUDWATCH_LOG: "application_logs",
    SignalSource.GRAFANA_ALERT: "grafana_alerts",
    SignalSource.APP_LOG: "application_logs",
    SignalSource.TRACE_SPAN: "trace",
}


def build_timeline(cluster: Cluster) -> list[TimelineEntry]:
    """Collapse repeats so a 12× log burst is one readable row, not twelve.

    A raw event dump is technically complete and practically useless — the
    reviewer has to reconstruct the shape of the incident themselves. Grouping
    consecutive identical events preserves every fact while making the
    sequence legible at a glance.
    """
    entries: list[TimelineEntry] = []
    for signal in sorted(cluster.signals, key=lambda s: s.timestamp):
        label = _SOURCE_LABEL.get(signal.source, str(signal.source))
        detail = _signal_detail(signal)
        if entries:
            last = entries[-1]
            if last.service == signal.service and last.detail == detail and last.source == label:
                last.count += 1
                continue
        entries.append(TimelineEntry(signal.timestamp, label, signal.service, detail))

    if len(entries) > MAX_TIMELINE_ROWS:
        head = entries[: MAX_TIMELINE_ROWS - 1]
        hidden = len(entries) - len(head)
        tail = entries[-1]
        tail.detail = f"(+{hidden} further events) {tail.detail}"
        return head + [tail]
    return entries


def _signal_detail(signal: Signal) -> str:
    if signal.metric and signal.value is not None:
        threshold = f" (threshold {signal.threshold:g})" if signal.threshold is not None else ""
        return f"{signal.metric} = {signal.value:g}{threshold}"
    text = (signal.message or "").strip().replace("\n", " ")
    return text[:110] + ("…" if len(text) > 110 else "")


def build_title(cluster: Cluster, causal: CausalResult, severity: SeverityBreakdown) -> str:
    root = causal.root_cause_service or (cluster.services[0] if cluster.services else "unknown")
    signal = causal.root_cause_signal
    what = "failure"
    if signal is not None:
        if signal.metric:
            what = signal.metric
        elif signal.labels.get("alertname"):
            what = signal.labels["alertname"]
        elif signal.message:
            what = signal.message.split(":")[0][:48]

    others = [s for s in cluster.services if s != root]
    spread = f" cascading to {len(others)} service(s)" if others else ""
    return f"[DRAFT] {root}: {what}{spread}"


def _root_cause_detail(causal: CausalResult) -> str:
    if not causal.root_cause_service:
        return "not determined — no candidate survived causal analysis"
    signal = causal.root_cause_signal
    detail = causal.root_cause_service
    if signal is not None:
        detail += f" — {_signal_detail(signal)}"
        detail += f" (first seen {signal.timestamp.strftime('%H:%M:%S')})"
    return detail


def build_facts(cluster: Cluster, causal: CausalResult) -> list[str]:
    """Observed, checkable statements. No inference about cause lives here."""
    signals = sorted(cluster.signals, key=lambda s: s.timestamp)
    if not signals:
        return []
    sources = sorted({_SOURCE_LABEL.get(s.source, str(s.source)) for s in signals})
    first, last = signals[0], signals[-1]
    facts = [
        f"{len(signals)} anomalous signals from {len(sources)} stream(s) ({', '.join(sources)}) "
        f"between {first.timestamp.strftime('%H:%M:%S')} and {last.timestamp.strftime('%H:%M:%S')} UTC.",
        f"First signal: {first.service} - {_signal_detail(first)}.",
    ]
    peak = max(signals, key=lambda s: s.anomaly_score)
    facts.append(f"Strongest anomaly (score {peak.anomaly_score:.2f}): {peak.service} - {_signal_detail(peak)}.")
    envs = sorted({s.environment for s in signals if s.environment})
    if envs:
        facts.append(f"Environment: {', '.join(envs)}.")
    for check in getattr(cluster, "validation", []) or []:
        if check.get("passed"):
            facts.append(f"Validation - {check['name']}: {check['detail']}.")
    return facts


def _suspected_root_cause(causal: CausalResult) -> str:
    if not causal.root_cause_service:
        return "Undetermined: no candidate survived counterfactual analysis. Treat the earliest signal as the lead."
    text = f"Suspected: {causal.root_cause_service}"
    if causal.root_cause_signal is not None:
        text += f" ({_signal_detail(causal.root_cause_signal)}, first seen " \
                f"{causal.root_cause_signal.timestamp.strftime('%H:%M:%S')})"
    return text + (f". Selected by counterfactual analysis over the dependency graph "
                   f"({causal.confidence_pct}% causal confidence); unconfirmed until checked on the service.")


def _fallback_summary(cluster: Cluster, causal: CausalResult, severity: SeverityBreakdown) -> str:
    root = causal.root_cause_service or "an unidentified service"
    others = [s for s in cluster.services if s != causal.root_cause_service]
    text = (
        f"{len(cluster.signals)} correlated signals across {len(cluster.services)} "
        f"service(s), scored {severity.priority}. Causal analysis points to {root}"
    )
    if others:
        text += f", with knock-on failures in {', '.join(others[:3])}"
    return text + "."


def _fallback_steps(causal: CausalResult, cluster: Cluster) -> list[str]:
    root = causal.root_cause_service
    steps: list[str] = []
    if root:
        steps.append(f"Inspect {root} first — causal analysis identifies it as the origin.")
        signal = causal.root_cause_signal
        if signal is not None and signal.metric:
            steps.append(
                f"Check {signal.metric} on {root} against its threshold "
                f"({signal.threshold:g})." if signal.threshold is not None
                else f"Check {signal.metric} on {root}."
            )
    downstream = [s for s in cluster.services if s != root]
    if downstream:
        steps.append(
            f"Confirm {', '.join(downstream[:3])} recover once {root} is healthy — "
            "if they do not, there is a second independent fault."
        )
    return steps


# --------------------------------------------------------------------------
# LLM narrative
# --------------------------------------------------------------------------


def _claude_narrative(draft: IncidentDraft) -> dict | None:
    try:
        from .claude_drafting import narrate
    except Exception:
        return None
    return narrate(draft)


def apply_claude(draft: IncidentDraft) -> bool:
    """Replace the template prose with Claude's, if Claude is configured and its
    reply passes the grounding checks. Returns whether anything changed."""
    out = _claude_narrative(draft)
    if not out:
        return False
    draft.summary = out["summary"]
    draft.suspected_root_cause = out["suspected_root_cause"]
    draft.investigation_steps = out["investigation_steps"]
    draft.summary_source = "llm"
    draft.drafted_by = out.get("model", "claude")
    return True


def _llm_narrative(draft: IncidentDraft) -> tuple[str, list[str]] | None:
    """Ask an LLM for prose, grounded strictly in already-computed facts.

    Reuses the provider plumbing in app.summarizer so both AI features share
    one configuration and one failure path.
    """
    try:
        from ..summarizer import _call_chat_api, _configured_providers
    except Exception:
        return None

    providers = _configured_providers()
    if not providers:
        return None

    timeline = "\n".join(f"  {e.render()}" for e in draft.timeline)
    reasoning = "\n".join(f"  - {r}" for r in draft.causal_reasoning)
    prompt = f"""You are an SRE writing an incident ticket. Using ONLY the facts below,
produce exactly two sections and nothing else.

SUMMARY: two sentences describing what broke and the blast radius.
STEPS: three numbered investigation steps, most useful first.

Do not invent metrics, timings, causes, or service names that do not appear below.
Do not restate the severity score.

Root cause (already determined): {draft.root_cause_detail}
Priority: {draft.priority}
Affected services: {', '.join(draft.affected_services)}
Signals correlated: {draft.signal_count}

Evidence timeline:
{timeline}

Causal analysis:
{reasoning}
"""

    for _name, key, url, model in providers:
        try:
            reply = _call_chat_api(key, url, model, prompt)
        except Exception:
            continue
        if reply:
            return _parse_narrative(reply)
    return None


def _parse_narrative(reply: str) -> tuple[str, list[str]]:
    """Split the model's reply into summary and steps.

    Tolerant by design — a model that ignores the format still yields a usable
    summary rather than an empty ticket.
    """
    import re

    summary_part, steps_part = reply, ""
    match = re.search(r"STEPS\s*:?", reply, re.IGNORECASE)
    if match:
        summary_part = reply[: match.start()]
        steps_part = reply[match.end():]

    summary = re.sub(r"^\s*SUMMARY\s*:?", "", summary_part, flags=re.IGNORECASE).strip()

    steps: list[str] = []
    for line in steps_part.splitlines():
        line = line.strip()
        if not line:
            continue
        line = re.sub(r"^[-*\d.)\s]+", "", line).strip()
        if line:
            steps.append(line)

    return summary, steps[:5]


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def _history_enabled() -> bool:
    import os
    return os.environ.get("AIOPS_OFFLINE_DEMO", "").strip() == "1"


def build_draft(
    cluster: Cluster,
    causal: CausalResult,
    severity: SeverityBreakdown,
    excluded: list[ExcludedSignal] | None = None,
    use_llm: bool = True,
) -> IncidentDraft:
    timeline = build_timeline(cluster)
    redaction_kinds = sorted({k for s in cluster.signals for k in s.redacted_fields})

    draft = IncidentDraft(
        draft_id=f"draft-{cluster.cluster_id}-{int(cluster.start.timestamp())}",
        title=build_title(cluster, causal, severity),
        priority=severity.priority,
        severity_score=severity.score,
        severity_line=severity.as_line(),
        correlation_confidence=cluster.confidence,
        causal_confidence=causal.confidence_pct,
        root_cause_service=causal.root_cause_service,
        root_cause_detail=_root_cause_detail(causal),
        affected_services=cluster.services,
        signal_count=len(cluster.signals),
        started_at=cluster.start,
        timeline=timeline,
        considered_excluded=excluded or [],
        severity_factors=severity.factors,
        causal_reasoning=causal.reasoning,
        suppressed=severity.suppressed,
        suppression_reason=severity.suppression_reason,
        redaction_kinds=redaction_kinds,
    )

    # The seeded incident library describes a different, synthetic estate, so it
    # is only consulted in offline mode. At runtime the streams are the only input.
    draft.historical_match = match_history(cluster) if _history_enabled() else None
    draft.facts = build_facts(cluster, causal)
    draft.suspected_root_cause = _suspected_root_cause(causal)

    if use_llm and apply_claude(draft):
        return draft
    narrative = _llm_narrative(draft) if use_llm else None
    if narrative and narrative[0]:
        draft.summary, steps = narrative
        draft.investigation_steps = steps or _fallback_steps(causal, cluster)
        draft.summary_source = "llm"
    else:
        draft.summary = _fallback_summary(cluster, causal, severity)
        draft.investigation_steps = _fallback_steps(causal, cluster)
        draft.summary_source = "template"

    # Past resolution is offered as a step to consider, computed and deterministic
    # (the LLM never sees or writes it), and clearly attributed to its incident.
    if draft.historical_match:
        m = draft.historical_match
        draft.investigation_steps.append(
            f"Compare with {m['incident_id']} ({m['similarity_pct']}% similar, seeded history): "
            f"it was resolved by: {m['resolution']}"
        )

    return draft
