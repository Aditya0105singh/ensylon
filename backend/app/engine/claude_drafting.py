"""Claude-written ticket prose, grounded in facts the engine already computed.

Division of labour (see drafting.py): the engine decides every fact - which
signals, which services, severity, confidence, the suspected root cause
service. Claude writes three things from those facts and nothing else:

  summary               what broke and the blast radius, observed facts only
  suspected_root_cause  the hypothesis, worded as a hypothesis
  investigation_steps   what an on-call engineer should check, in order

The reply is constrained to a JSON schema (structured outputs), then checked:
it must not introduce a service the incident does not contain, and the
suspected root cause must name the service causal analysis selected. Anything
that fails the check, and any API error, falls back to the template draft - a
ticket with plain prose still reaches the reviewer.

The key comes from ANTHROPIC_API_KEY in the environment (or a .env that is
git-ignored); it is never written to disk or logged. Only redacted evidence is
ever sent.
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any

log = logging.getLogger(__name__)

MODEL = os.getenv("CLAUDE_MODEL", "claude-opus-5")
EFFORT = os.getenv("CLAUDE_EFFORT", "medium")
TIMEOUT_S = float(os.getenv("CLAUDE_TIMEOUT_SECONDS", "90"))

SCHEMA = {
    "type": "object",
    "properties": {
        "summary": {"type": "string"},
        "suspected_root_cause": {"type": "string"},
        "investigation_steps": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["summary", "suspected_root_cause", "investigation_steps"],
    "additionalProperties": False,
}

SYSTEM = """You write incident tickets for an SRE on-call team at an insurance platform.
You are given facts an automated correlation engine has already established. Write only from them.

Rules:
- "summary": 2-3 sentences of observed fact: what failed, where, when, blast radius. No speculation here.
- "suspected_root_cause": 1-3 sentences, worded as a hypothesis ("Suspected: ..."), naming the root-cause
  service the engine selected and the evidence that points to it. Say what would confirm or refute it.
- "investigation_steps": 3-5 concrete steps, most useful first, each naming the service to check.
- Never introduce a service, metric, number, time or cause that is not in the facts.
- Do not restate the severity score or confidence numbers; they are shown separately.
- Evidence is already redacted; never try to reconstruct redacted values."""


def enabled() -> bool:
    return bool(os.getenv("ANTHROPIC_API_KEY", "").strip()) and os.getenv("CLAUDE_DRAFTING", "1") != "0"


_client = None


def _get_client():
    global _client
    if _client is None:
        import anthropic

        _client = anthropic.Anthropic(timeout=TIMEOUT_S, max_retries=2)
    return _client


def build_prompt(draft) -> str:
    timeline = "\n".join(f"  {e.render()}" for e in draft.timeline)
    facts = "\n".join(f"  - {f}" for f in draft.facts)
    reasoning = "\n".join(f"  - {r}" for r in draft.causal_reasoning)
    return f"""Incident facts (computed, authoritative):

Priority: {draft.priority}
Services involved: {', '.join(draft.affected_services)}
Root-cause service selected by causal analysis: {draft.root_cause_service or 'undetermined'}
Root-cause evidence: {draft.root_cause_detail}

Facts:
{facts}

Evidence timeline (time, [source stream], service - evidence):
{timeline}

Causal analysis notes:
{reasoning}

Write the ticket fields."""


_SERVICE_LIKE = re.compile(r"\b[a-z][a-z0-9]*(?:-[a-z0-9]+)*-(?:service|gateway|db)\b|\brulesforge\b|\bdocforge\b")


def _grounded(out: dict[str, Any], draft) -> str | None:
    """None if the reply is grounded, else the reason it was discarded."""
    allowed = set(draft.affected_services) | {s.service for s in draft.considered_excluded}
    text = " ".join([out["summary"], out["suspected_root_cause"], *out["investigation_steps"]])
    unknown = {m for m in _SERVICE_LIKE.findall(text)} - allowed
    if unknown:
        return f"mentions services outside the incident: {sorted(unknown)}"
    if draft.root_cause_service and draft.root_cause_service not in out["suspected_root_cause"]:
        return "suspected root cause does not name the selected service"
    if not out["summary"].strip() or not out["investigation_steps"]:
        return "empty fields"
    return None


def narrate(draft) -> dict[str, Any] | None:
    """Claude's summary / suspected root cause / steps for this draft, or None."""
    if not enabled():
        return None
    import anthropic

    try:
        response = _get_client().messages.create(
            model=MODEL,
            max_tokens=4000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": SCHEMA}},
            messages=[{"role": "user", "content": build_prompt(draft)}],
        )
    except anthropic.AuthenticationError:
        log.warning("Claude drafting: API key rejected; using template drafts")
        return None
    except anthropic.RateLimitError:
        log.warning("Claude drafting: rate limited; using template draft")
        return None
    except anthropic.APIStatusError as e:
        log.warning("Claude drafting: API error %s; using template draft", e.status_code)
        return None
    except anthropic.APIConnectionError:
        log.warning("Claude drafting: connection error; using template draft")
        return None

    if response.stop_reason in ("refusal", "max_tokens"):
        log.warning("Claude drafting: stop_reason=%s; using template draft", response.stop_reason)
        return None
    text = next((b.text for b in response.content if b.type == "text"), "")
    try:
        out = json.loads(text)
    except json.JSONDecodeError:
        return None
    problem = _grounded(out, draft)
    if problem:
        log.warning("Claude drafting: reply discarded (%s)", problem)
        return None
    out["investigation_steps"] = [s.strip() for s in out["investigation_steps"] if s.strip()][:6]
    out["model"] = response.model
    return out
