"""Score the engine's incidents against hand-labelled ground truth.

The benchmark measures the engine on generated estates; this measures it on a
recorded run of the real simulator, using labels from tools/label_recording.py.

Scored on labelled signals only. Pairs involving `unsure` signals are ignored
(they are ambiguous, so neither a right nor a wrong grouping). Decoys are not
part of any truth incident, so a decoy inside an incident is counted as a
false grouping and reported separately.
"""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from itertools import combinations
from pathlib import Path
from typing import Any

IGNORED = ("unsure",)
DECOY = "decoy"


@dataclass
class GroundTruthScore:
    pair_precision: float = 0.0
    pair_recall: float = 0.0
    pair_f1: float = 0.0
    true_pairs: int = 0
    predicted_pairs: int = 0
    correct_pairs: int = 0
    stories: int = 0                      # distinct labelled incidents present
    incidents: int = 0                    # incidents the engine raised
    decoys_in_incidents: int = 0
    decoys_total: int = 0
    mixed_incidents: int = 0              # incidents holding 2+ labelled stories
    split_stories: int = 0                # labelled incidents spread over 2+ engine incidents
    # Per-story views, so one giant story cannot dominate the pair counts:
    root_correct: int = 0                 # incidents whose root cause is their dominant story's real root
    root_total: int = 0
    purity: float = 0.0                   # signals sitting in their incident's dominant story
    completeness: float = 0.0             # mean over stories: share held by its largest incident
    composition: list[dict[str, Any]] = field(default_factory=list)

    def summary(self) -> str:
        return (f"pair P {self.pair_precision:.3f}  R {self.pair_recall:.3f}  F1 {self.pair_f1:.3f} | "
                f"incidents {self.incidents} for {self.stories} true | mixed {self.mixed_incidents} | "
                f"split {self.split_stories} | decoys in incidents {self.decoys_in_incidents}/{self.decoys_total} | "
                f"purity {self.purity:.2f} completeness {self.completeness:.2f} | "
                f"root {self.root_correct}/{self.root_total}")


def load_labels(path: Path) -> dict[str, dict]:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def score(incidents: list, labels: dict[str, dict], present_ids: set[str] | None = None) -> GroundTruthScore:
    """`incidents` are IncidentResult-like (`.cluster.signals`). `present_ids`
    limits truth to signals the engine actually kept (dedup drops repeats)."""
    truth_of: dict[str, str] = {}
    decoys: set[str] = set()
    for sid, lab in labels.items():
        if present_ids is not None and sid not in present_ids:
            continue
        if lab["story"] == DECOY:
            decoys.add(sid)
        elif lab["story"] not in IGNORED and lab.get("incident"):
            truth_of[sid] = lab["incident"]

    groups: dict[str, list[str]] = defaultdict(list)
    for sid, inc in truth_of.items():
        groups[inc].append(sid)
    true_pairs = {frozenset(p) for members in groups.values() for p in combinations(members, 2)}

    predicted: set[frozenset] = set()
    composition = []
    mixed = 0
    decoys_in = 0
    spread: dict[str, set[int]] = defaultdict(set)
    for n, inc in enumerate(incidents):
        ids = [s.id for s in inc.cluster.signals]
        scored = [i for i in ids if i in truth_of]
        predicted |= {frozenset(p) for p in combinations(scored, 2)}
        kinds = Counter(truth_of[i] for i in scored)
        d = sum(1 for i in ids if i in decoys)
        decoys_in += d
        for i in scored:
            spread[truth_of[i]].add(n)
        if len(kinds) > 1:
            mixed += 1
        composition.append({
            "incident": n, "services": sorted({s.service for s in inc.cluster.signals}),
            "signals": len(ids), "labelled": dict(kinds), "decoys": d,
            "root_cause": getattr(getattr(inc, "causal", None), "root_cause_service", None),
        })

    # purity: of the labelled signals inside incidents, the share in the incident's dominant story
    dominant = total_labelled = 0
    holds: dict[str, Counter] = defaultdict(Counter)   # story -> {engine incident: count}
    for n, inc in enumerate(incidents):
        kinds = Counter(truth_of[s.id] for s in inc.cluster.signals if s.id in truth_of)
        if kinds:
            dominant += max(kinds.values())
            total_labelled += sum(kinds.values())
        for story, c in kinds.items():
            holds[story][n] += c
    purity = dominant / total_labelled if total_labelled else 0.0
    completeness = (sum(max(holds[st].values()) / len(groups[st]) if holds[st] else 0.0 for st in groups) / len(groups)
                    if groups else 0.0)

    # root cause: for each incident dominated (>= 60%) by one story, is its root that story's real root?
    root_of = {lab["incident"]: lab.get("root") for lab in labels.values() if lab.get("incident")}
    root_ok = root_n = 0
    for n, inc in enumerate(incidents):
        kinds = Counter(truth_of[s.id] for s in inc.cluster.signals if s.id in truth_of)
        if not kinds:
            continue
        story, cnt = kinds.most_common(1)[0]
        if cnt / sum(kinds.values()) >= 0.6 and root_of.get(story):
            root_n += 1
            causal = getattr(inc, "causal", None)
            root_ok += int(getattr(causal, "root_cause_service", None) == root_of[story])

    correct = true_pairs & predicted
    p = len(correct) / len(predicted) if predicted else 0.0
    r = len(correct) / len(true_pairs) if true_pairs else 0.0
    f1 = 2 * p * r / (p + r) if p + r else 0.0
    return GroundTruthScore(
        pair_precision=p, pair_recall=r, pair_f1=f1,
        true_pairs=len(true_pairs), predicted_pairs=len(predicted), correct_pairs=len(correct),
        stories=len(groups), incidents=len(incidents), decoys_in_incidents=decoys_in, decoys_total=len(decoys),
        mixed_incidents=mixed, split_stories=sum(1 for v in spread.values() if len(v) > 1),
        root_correct=root_ok, root_total=root_n, purity=purity, completeness=completeness, composition=composition,
    )
