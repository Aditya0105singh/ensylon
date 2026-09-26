"""Replay a labelled recording through the engine and score the incidents.

    python tools/eval_recording.py <recording.jsonl> <labels.json> [--detail]

Read-only: builds an in-process engine, needs no network and no server.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.engine import groundtruth, recording  # noqa: E402
from app.engine.live import FALLBACK_GRAPH, criticality_map, graph_from_adjacency  # noqa: E402
from app.engine.stream import StreamEngine  # noqa: E402


def run(rec_path: Path, labels_path: Path):
    signals = recording.load(rec_path).signals
    engine = StreamEngine(graph_from_adjacency(FALLBACK_GRAPH), criticality_map())
    recording.fast_forward(engine, signals, 2.0)
    labels = groundtruth.load_labels(labels_path)
    present = {s.id for s in engine.result.signals}
    return engine, groundtruth.score(engine.result.incidents, labels, present)


def main() -> None:
    rec, lab = Path(sys.argv[1]), Path(sys.argv[2])
    engine, sc = run(rec, lab)
    print(sc.summary())
    if "--detail" in sys.argv:
        for c in sorted(sc.composition, key=lambda c: -c["signals"]):
            print(f"  #{c['incident']:<2d} {c['signals']:3d} sig  root={str(c['root_cause']):16s} decoys={c['decoys']}  "
                  + ", ".join(f"{k}:{v}" for k, v in sorted(c["labelled"].items())))


if __name__ == "__main__":
    main()
