"""Fingerprint-based alert deduplication.

Monitoring systems re-fire the same alert every evaluation interval, so one
stuck condition produces dozens of identical alerts. Two alerts are duplicates
when the same check fires on the same service within the same time window —
same idea as Keep/Alertmanager fingerprinting, scoped down.

Fingerprint = sha1(service | alertname | timestamp bucketed to WINDOW_SECONDS).
"""

from __future__ import annotations

import hashlib
from datetime import datetime

WINDOW_SECONDS = 300  # alerts from the same check within 5 min collapse to one


def fingerprint(alert: dict, window_seconds: int = WINDOW_SECONDS) -> str:
    ts = alert["timestamp"]
    if isinstance(ts, str):
        ts = datetime.fromisoformat(ts)
    bucket = int(ts.timestamp()) // window_seconds
    raw = f"{alert['service']}|{alert['alertname']}|{bucket}"
    return hashlib.sha1(raw.encode()).hexdigest()[:16]


def deduplicate(alerts: list[dict], window_seconds: int = WINDOW_SECONDS) -> tuple[list[dict], dict]:
    """Collapse duplicate alerts, keeping the earliest of each fingerprint group.

    Returns (unique_alerts, stats) where stats feeds the Deduplication page:
    raw count, unique count, and per-fingerprint group sizes.
    """
    groups: dict[str, list[dict]] = {}
    for alert in sorted(alerts, key=lambda a: a["timestamp"]):
        groups.setdefault(fingerprint(alert, window_seconds), []).append(alert)

    unique = []
    for fp, members in groups.items():
        kept = members[0]
        kept = {**kept, "fingerprint": fp, "duplicate_count": len(members)}
        unique.append(kept)

    unique.sort(key=lambda a: a["timestamp"])
    stats = {
        "raw_count": len(alerts),
        "unique_count": len(unique),
        "reduction_pct": round(100 * (1 - len(unique) / len(alerts)), 1) if alerts else 0.0,
        "groups": {fp: len(members) for fp, members in groups.items()},
    }
    return unique, stats
