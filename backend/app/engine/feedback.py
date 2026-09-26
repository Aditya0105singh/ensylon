"""Reviewer decisions become a small, visible adjustment to similarity weights.

The design's promise: when a reviewer splits or merges an incident, the system
adjusts the similarity weights for THAT signal pattern - lightweight and
inspectable, not opaque retraining. This is that, and only that:

  * reject as noise -> the grouping was too eager for this pattern, so weight
    moves from the loosest evidence (time, template) to structural evidence
    (service, dependency), making future grouping of these services stricter.
  * merge -> the grouping was too strict, so weight moves the other way.

A rule-based nudge of STEP per decision, renormalised to sum to 1, capped so no
weight leaves [FLOOR, CEIL]. Every change is returned so the UI can show the
before/after, and reset() restores the design defaults.
"""

from __future__ import annotations

from .correlate import PATTERN_WEIGHTS, default_weights

STEP = 0.04
FLOOR, CEIL = 0.05, 0.55

LOOSE = ("time", "template")
STRUCTURAL = ("service", "dependency", "component")


def _clamp_normalise(w: dict[str, float]) -> dict[str, float]:
    w = {k: min(CEIL, max(FLOOR, v)) for k, v in w.items()}
    total = sum(w.values())
    return {k: round(v / total, 3) for k, v in w.items()}


def apply_feedback(action: str, services: list[str]) -> dict | None:
    """Adjust the weights for the pattern `services`. Returns before/after."""
    if action not in ("reject", "merge") or not services:
        return None
    key = frozenset(services)
    before = dict(PATTERN_WEIGHTS.get(key, default_weights()))
    after = dict(before)

    give, take = (LOOSE, STRUCTURAL) if action == "reject" else (STRUCTURAL, LOOSE)
    for name in give:
        after[name] -= STEP / len(give)
    for name in take:
        after[name] += STEP / len(take)
    after = _clamp_normalise(after)

    PATTERN_WEIGHTS[key] = after
    return {"pattern": sorted(key), "action": action, "before": before, "after": after}


def reset() -> None:
    PATTERN_WEIGHTS.clear()


def current() -> list[dict]:
    return [{"pattern": sorted(k), "weights": v} for k, v in PATTERN_WEIGHTS.items()]
