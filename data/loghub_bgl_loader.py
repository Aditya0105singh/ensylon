"""Loghub BGL loader - a 10,000-alert real sample from the BlueGene/L
supercomputer RAS log (Lawrence Livermore National Lab, 4.7M lines over 214
days), converted into the same Alert schema the other loaders produce.

OFFLINE preprocessing script, not part of the live app. It downloads and
caches BGL.zip (57.5 MB, Zenodo record 8196385 - the same Loghub record the
other Loghub loader used) and writes data/loghub_bgl_alerts.json, which
backend/app/real_data_bgl.py reads at request time.

Why BGL: it has six real
severity levels, nine real subsystems and 41 real alert categories, and its
alerts arrive in genuine bursts - so the batch shows a lot happening at once.

Every field traces to literal content in a real BGL line. The disclosed
transformation rules are:

  severity (BGL's own RAS level, order preserved):
      FATAL, FAILURE -> critical     SEVERE  -> high
      ERROR          -> medium       WARNING -> low        INFO -> info
  service:  "bgl-" + the real RAS component (kernel, app, mmcs, discovery, ...)
  status:   resolved for plain INFO lines that carry no alert tag, else firing
  alertname: the real alert category tag when the line has one, plus the
      real message with numbers/hex/locations masked (real text, not invented)
  ground_truth: the dataset's own alert tag ("-" = non-alert), kept only for
      evaluation - the pipeline never reads it

Sampling (deterministic, no randomness): six real days chosen for different
failure stories - a job-termination storm (2005-08-17), a mount-failure wave
(2005-08-31), an application-severity wave (2005-09-30), the day with the most
distinct alert categories (2005-11-17), a hardware/discovery-heavy day with
the widest severity mix (2005-12-03) and a second mount-failure burst
(2005-12-04). Within each day the sample is stratified by (component, level,
alert tag) so every rare event type survives and floods are thinned evenly
across time (bursts stay bursts). The days are laid back-to-back with a 2 hour
gap instead of the real months between them; timestamps inside a day are the
real ones. backend/app/real_data_bgl.py then shifts the whole batch so its
latest event lands at "now", same as the other real datasets.

Usage:
    python loghub_bgl_loader.py --out loghub_bgl_alerts.json
"""

from __future__ import annotations

import argparse
import json
import math
import re
import urllib.request
import uuid
import zipfile
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path

BGL_ZIP_URL = "https://zenodo.org/records/8196385/files/BGL.zip?download=1"

DAYS = ["2005.08.17", "2005.08.31", "2005.09.30", "2005.11.17", "2005.12.03", "2005.12.04"]
TARGET_ALERTS = 10000
GAP = timedelta(hours=2)
MIN_PER_STRATUM = 5
RARE_LEVELS = {"WARNING", "ERROR", "SEVERE", "FAILURE"}  # kept whole so the mid severities show up
RARE_KEEP_ALL_UP_TO = 500
FATAL_DAMPING = 0.35

SEVERITY = {
    "FATAL": "critical", "FAILURE": "critical",
    "SEVERE": "high", "ERROR": "medium", "WARNING": "low", "INFO": "info",
}

HEX_RE = re.compile(r"0x[0-9a-fA-F]+")
LOC_RE = re.compile(r"R\d+-M\d-N\d+(-[A-Z]:J\d+-U\d+)?|R\d+-M\d(-L\d+-U\d+)?")
NUM_RE = re.compile(r"\d+")


def mask_template(content: str) -> str:
    masked = HEX_RE.sub("hex", content)
    masked = LOC_RE.sub("@node", masked)
    masked = NUM_RE.sub("#", masked)
    return re.sub(r"\s+", " ", masked).strip()


def download_and_extract(cache_dir: Path) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    zip_path = cache_dir / "BGL.zip"
    log_path = cache_dir / "extracted" / "BGL.log"
    if not zip_path.exists():
        print(f"Downloading {BGL_ZIP_URL} -> {zip_path} (57.5 MB, one-time)...")
        urllib.request.urlretrieve(BGL_ZIP_URL, zip_path)
    if not log_path.exists():
        print("Extracting BGL.log (743 MB)...")
        with zipfile.ZipFile(zip_path) as zf:
            zf.extract("BGL.log", cache_dir / "extracted")
    return log_path


def read_days(log_path: Path) -> dict[str, list[dict]]:
    wanted = set(DAYS)
    by_day: dict[str, list[dict]] = {d: [] for d in DAYS}
    with open(log_path, encoding="utf-8", errors="replace") as f:
        for line in f:
            parts = line.split(None, 9)
            if len(parts) < 10:
                continue
            label, _unix, date, node, tm, _node2, _typ, component, level, content = parts
            if date not in wanted or level not in SEVERITY:
                continue
            try:
                ts = datetime.strptime(tm, "%Y-%m-%d-%H.%M.%S.%f")
            except ValueError:
                continue
            by_day[date].append({
                "label": label, "node": node, "ts": ts,
                "component": component, "level": level, "content": content.strip(),
            })
    for rows in by_day.values():
        rows.sort(key=lambda r: r["ts"])
    return by_day


def stratified_sample(rows: list[dict], budget: int) -> list[dict]:
    """Deterministic. Rare severity levels (WARNING/ERROR/SEVERE/FAILURE) are
    kept whole; every other stratum keeps at least MIN_PER_STRATUM lines (or all
    of it if smaller) and the rest of the budget is shared in proportion to the
    square root of stratum size, so one enormous flood can't drown everything
    else. Picks are evenly spaced through each stratum, so bursts keep their
    shape."""
    strata: dict[tuple, list[dict]] = defaultdict(list)
    for r in rows:
        strata[(r["component"], r["level"], r["label"])].append(r)

    picked: list[dict] = []
    rest: dict[tuple, list[dict]] = {}
    for k, v in strata.items():
        if k[1] in RARE_LEVELS and len(v) <= RARE_KEEP_ALL_UP_TO:
            picked.extend(v)
        else:
            rest[k] = v

    base = {k: min(len(v), MIN_PER_STRATUM) for k, v in rest.items()}
    spare = max(budget - len(picked) - sum(base.values()), 0)
    # FATAL is ~18% of all BGL lines; damp it further so the milder severities
    # stay visible next to it (still every FATAL category is represented).
    weight = {
        k: math.sqrt(len(v) - base[k]) * (FATAL_DAMPING if k[1] == "FATAL" else 1.0)
        for k, v in rest.items()
    }
    weight_total = sum(weight.values()) or 1.0

    for k, v in rest.items():
        take = min(base[k] + int(spare * weight[k] / weight_total), len(v))
        if take >= len(v):
            picked.extend(v)
        else:
            step = len(v) / take
            picked.extend(v[int(i * step)] for i in range(take))
    picked.sort(key=lambda r: r["ts"])
    return picked


def build_alerts(by_day: dict[str, list[dict]]) -> list[dict]:
    budget = TARGET_ALERTS // len(DAYS)
    alerts: list[dict] = []
    cursor: datetime | None = None

    for day in DAYS:
        chosen = stratified_sample(by_day[day], budget)
        if not chosen:
            continue
        first = chosen[0]["ts"]
        if cursor is None:
            cursor = first
        offset = cursor - first
        for r in chosen:
            tagged = r["label"] != "-"
            template = mask_template(r["content"])
            name = f"{r['label']}: {template[:60]}" if tagged else template[:70]
            plain_info = r["level"] == "INFO" and not tagged
            alerts.append({
                "id": str(uuid.uuid4()),
                "service": f"bgl-{r['component'].lower()}",
                "alertname": name,
                "message": r["content"],
                "severity": SEVERITY[r["level"]],
                "status": "resolved" if plain_info else "firing",
                "timestamp": (r["ts"] + offset).isoformat(timespec="seconds"),
                "source": "loghub-bgl",
                "assignee": "n/a",
                "dismissed": plain_info,
                "ground_truth": r["label"] if tagged else "Normal",
                "host": r["node"],
                "bgl_day": day,
            })
        cursor = chosen[-1]["ts"] + offset + GAP

    alerts.sort(key=lambda a: a["timestamp"])
    return alerts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--cache-dir", type=str, default=str(Path(__file__).parent / ".cache" / "loghub_bgl"))
    parser.add_argument("--out", type=str, default=str(Path(__file__).parent / "loghub_bgl_alerts.json"))
    args = parser.parse_args()

    log_path = download_and_extract(Path(args.cache_dir))
    by_day = read_days(log_path)
    for d in DAYS:
        print(f"  {d}: {len(by_day[d])} real lines read")
    alerts = build_alerts(by_day)

    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(alerts, f)
    print(f"\nWrote {len(alerts)} real alerts to {args.out}")
    for field in ("severity", "service", "status", "bgl_day"):
        counts: dict[str, int] = defaultdict(int)
        for a in alerts:
            counts[a[field]] += 1
        print(f"  by {field}: {dict(sorted(counts.items(), key=lambda kv: -kv[1]))}")
    tagged = defaultdict(int)
    for a in alerts:
        if a["ground_truth"] != "Normal":
            tagged[a["ground_truth"]] += 1
    print(f"  real alert categories present: {len(tagged)} -> {dict(sorted(tagged.items(), key=lambda kv: -kv[1]))}")


if __name__ == "__main__":
    main()
