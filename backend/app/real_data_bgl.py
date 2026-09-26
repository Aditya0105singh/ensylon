"""Loads the preprocessed real Loghub BGL alert batch (see
data/loghub_bgl_loader.py for how it was built from the raw dataset).

The committed JSON keeps real 2005 collection timestamps (six real days laid back-to-back, see the loader) — this module's only
job is a disclosed presentation transform: shift the whole batch so its latest
real event lands at "now", preserving true relative spacing/order, so a live
demo run today doesn't show alerts from 17 years ago. No alert content, label,
or field value is changed.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from pathlib import Path

from .dedup import WINDOW_SECONDS

DATA_PATH = Path(__file__).resolve().parents[2] / "data" / "loghub_bgl_alerts.json"


def load_bgl_alerts() -> list[dict]:
    with open(DATA_PATH, encoding="utf-8") as f:
        alerts: list[dict] = json.load(f)

    if not alerts:
        return alerts

    timestamps = [datetime.fromisoformat(a["timestamp"]) for a in alerts]
    # Shift by a whole number of dedup windows. Dedup buckets absolute time into
    # WINDOW_SECONDS slots, so an arbitrary shift changed which alerts shared a
    # slot and the unique/incident counts drifted from one reload to the next.
    raw_shift = (datetime.now().replace(microsecond=0) - max(timestamps)).total_seconds()
    shift = timedelta(seconds=(raw_shift // WINDOW_SECONDS) * WINDOW_SECONDS)

    shifted = []
    for alert, ts in zip(alerts, timestamps):
        shifted.append({**alert, "timestamp": (ts + shift).isoformat(timespec="seconds")})
    return shifted
