"""Historical fingerprint matching: context from past incidents, never a verdict.

Each resolved incident leaves a small fingerprint (the vocabulary of its
symptoms) plus how it was fixed. A new incident that resembles one gets that
resolution shown as CONTEXT for the reviewer. It never forces a grouping, never
merges anything, and a weak resemblance is reported as "no strong match" rather
than dressed up as one.

The library below is SEEDED demo history: illustrative past incidents, labelled
as such in the UI. A real deployment would fill it from resolved tickets.

similarity = |cluster vocabulary & fingerprint| / |fingerprint|

i.e. "how much of that past incident's symptom vocabulary shows up here". It is
coverage, not Jaccard, so a big incident with extra unrelated words is not
penalised for the extras, and the number is easy to explain to a reviewer.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .correlate import Cluster, _tokens

LIBRARY_PATH = Path(__file__).with_name("history_library.json")
MATCH_THRESHOLD = 0.40


@lru_cache(maxsize=1)
def _library() -> list[dict[str, Any]]:
    with open(LIBRARY_PATH, encoding="utf-8") as f:
        return json.load(f)


def cluster_vocabulary(cluster: Cluster) -> set[str]:
    vocab: set[str] = set()
    for signal in cluster.signals:
        vocab |= _tokens(signal)
    return vocab


def match_history(cluster: Cluster) -> dict[str, Any] | None:
    """Best past incident above the threshold, or None."""
    vocab = cluster_vocabulary(cluster)
    best: tuple[float, dict[str, Any], list[str]] | None = None
    for entry in _library():
        fingerprint = set(entry["fingerprint"])
        shared = sorted(vocab & fingerprint)
        score = len(shared) / len(fingerprint)
        if best is None or score > best[0]:
            best = (score, entry, shared)
    if best is None or best[0] < MATCH_THRESHOLD:
        return None
    score, entry, shared = best
    return {
        "incident_id": entry["id"],
        "title": entry["title"],
        "similarity_pct": round(score * 100),
        "resolution": entry["resolution"],
        "resolution_minutes": entry["resolution_minutes"],
        "shared_terms": shared,
        "source": "seeded demo history",
    }
