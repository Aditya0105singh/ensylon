"""Why the clusterer grouped these alerts - explainability over the real
decision, not a narration of it.

Everything here is recomputed with the same functions app/clustering.py used to
form the cluster (same TF-IDF fit over the same unique-alert corpus, same
combined distance), so the numbers shown are the ones the engine actually acted
on rather than a second opinion.

Deliberately absent: the engine has no trace IDs to share and does not run a
log-template miner, so no "shared trace" or "DRAIN3 template" claim is made.
What it does have is text similarity, time proximity, service spread and the
distances to the alerts it chose to leave out - which is what this reports.
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

import numpy as np

from .clustering import (
    EPS,
    MIN_SAMPLES,
    TIME_PENALTY,
    TIME_SCALE_MIN,
    _ts,
    embed_alerts,
)

MAX_EXCLUDED = 4
# A rejected alert is only interesting if it was in the running at all. Anything
# at or above TIME_PENALTY is simply hours away (the time term has saturated),
# which says nothing about where this incident's boundary sits.
NEAR_MISS_LIMIT = TIME_PENALTY * 0.8


def _fmt_gap(seconds: float) -> str:
    seconds = int(round(seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m {seconds % 60:02d}s"
    return f"{seconds // 3600}h {(seconds % 3600) // 60:02d}m"


def _pair_distances(
    rows: np.ndarray, cols: np.ndarray, row_ts: np.ndarray, col_ts: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """(combined, text, time_penalty) - the exact terms clustering.py sums."""
    text = 1.0 - rows @ cols.T
    dt_min = np.abs(row_ts[:, None] - col_ts[None, :]) / 60.0
    pen = TIME_PENALTY * np.minimum(dt_min / TIME_SCALE_MIN, 1.0) ** 2
    return np.clip(text + pen, 0.0, None), text, pen


def build_correlation_explanation(
    cluster: dict[str, Any], all_clusters: list[dict], noise: list[dict]
) -> dict[str, Any]:
    members: list[dict] = cluster.get("alerts") or []
    root = cluster.get("root_cause") or {}

    # Same corpus the run fit on: every unique alert the clusterer saw. TF-IDF
    # fit is order-independent, so this reproduces the run's vectors exactly.
    unique = [a for c in all_clusters for a in (c.get("alerts") or [])] + list(noise)
    if not members or len(unique) < 2:
        return {
            "confidence_pct": 0,
            "factors": [],
            "reasons": [],
            "excluded": [],
            "params": {"eps": EPS, "min_samples": MIN_SAMPLES, "time_scale_min": TIME_SCALE_MIN},
        }

    index = {id(a): i for i, a in enumerate(unique)}
    emb = embed_alerts(unique)
    times = np.array([_ts(a).timestamp() for a in unique])

    m_idx = np.array([index[id(a)] for a in members if id(a) in index])
    if m_idx.size < 2:
        return {
            "confidence_pct": 0,
            "factors": [],
            "reasons": [],
            "excluded": [],
            "params": {"eps": EPS, "min_samples": MIN_SAMPLES, "time_scale_min": TIME_SCALE_MIN},
        }

    m_emb, m_ts = emb[m_idx], times[m_idx]
    combined, text, _pen = _pair_distances(m_emb, m_emb, m_ts, m_ts)

    # Upper triangle only: every unordered pair once, no self-pairs.
    iu = np.triu_indices(len(m_idx), k=1)
    pair_combined = combined[iu]
    pair_text_sim = 1.0 - text[iu]
    pair_gap_sec = np.abs(m_ts[:, None] - m_ts[None, :])[iu]

    span_sec = float(m_ts.max() - m_ts.min())
    mean_gap_sec = float(pair_gap_sec.mean())
    mean_text_sim = float(pair_text_sim.mean())
    mean_combined = float(pair_combined.mean())

    services = [a.get("service") for a in members if a.get("service")]
    distinct_services = sorted(set(services))
    top_service_share = (
        max(services.count(s) for s in distinct_services) / len(services) if services else 0.0
    )

    # Four factors, each a real measurement normalised to 0-1.
    time_proximity = float(max(0.0, 1.0 - (mean_gap_sec / 60.0) / TIME_SCALE_MIN))
    template_similarity = float(max(0.0, min(1.0, mean_text_sim)))
    service_affinity = float(top_service_share)
    # Share of member pairs the clusterer would consider neighbours. Distinct
    # from mean text similarity above, which mean distance alone would restate.
    within_eps = float((pair_combined <= EPS).mean())

    factors = [
        {
            "key": "time_proximity",
            "label": "Time proximity",
            "score": round(time_proximity, 2),
            "detail": f"{len(members)} alerts spanning {_fmt_gap(span_sec)}; mean gap {_fmt_gap(mean_gap_sec)}",
        },
        {
            "key": "template_similarity",
            "label": "Template similarity",
            "score": round(template_similarity, 2),
            "detail": f"mean TF-IDF cosine {mean_text_sim:.2f} across {len(pair_combined)} pairs",
        },
        {
            "key": "service_affinity",
            "label": "Service affinity",
            "score": round(service_affinity, 2),
            "detail": (
                f"{len(distinct_services)} service(s); {round(top_service_share * 100)}% on "
                f"{max(distinct_services, key=services.count)}"
                if distinct_services
                else "no service labels"
            ),
        },
        {
            "key": "cohesion",
            "label": "Cluster cohesion",
            "score": round(within_eps, 2),
            "detail": f"{round(within_eps * 100)}% of pairs within eps {EPS:.2f} (mean {mean_combined:.2f})",
        },
    ]
    confidence_pct = int(round(100 * float(np.mean([f["score"] for f in factors]))))

    max_gap_min = float(pair_gap_sec.max()) / 60.0
    reasons = [
        {
            "ok": max_gap_min <= TIME_SCALE_MIN,
            "text": (
                f"All {len(members)} alerts within the {TIME_SCALE_MIN:.0f}-minute correlation window"
                if max_gap_min <= TIME_SCALE_MIN
                else f"Widest pair is {_fmt_gap(float(pair_gap_sec.max()))} apart, beyond the {TIME_SCALE_MIN:.0f}-minute window"
            ),
        },
        {
            "ok": mean_text_sim >= 0.3,
            "text": f"Shared wording across alerts (mean TF-IDF cosine {mean_text_sim:.2f})",
        },
        {
            "ok": True,
            "text": (
                f"{len(distinct_services)} affected service(s): {', '.join(distinct_services[:4])}"
                + ("…" if len(distinct_services) > 4 else "")
            ),
        },
        {
            "ok": len(members) >= MIN_SAMPLES,
            "text": f"{len(members)} alerts meets the min_samples={MIN_SAMPLES} density rule",
        },
        {
            "ok": True,
            "text": f"Earliest alert picked as root cause: {root.get('alertname', 'n/a')} on {root.get('service', 'n/a')}",
        },
    ]

    # Alerts the clusterer saw and left out. Reported with the real distance and
    # which term pushed them over the threshold.
    excluded: list[dict] = []
    n_idx = np.array([index[id(a)] for a in noise if id(a) in index])
    if n_idx.size:
        n_combined, n_text, n_pen = _pair_distances(emb[n_idx], m_emb, times[n_idx], m_ts)
        nearest = n_combined.min(axis=1)
        order = np.argsort(nearest)[:MAX_EXCLUDED]
        for oi in order:
            dist = float(nearest[oi])
            if dist > NEAR_MISS_LIMIT:
                break
            j = int(np.argmin(n_combined[oi]))
            alert = unique[int(n_idx[oi])]  # n_idx indexes `unique`
            sim = 1.0 - float(n_text[oi, j])
            gap = abs(float(times[int(n_idx[oi])] - m_ts[j]))
            why: list[str] = []
            if float(n_pen[oi, j]) > 0.05:
                why.append(f"{_fmt_gap(gap)} from the nearest alert in this incident")
            if sim < 0.5:
                why.append(f"text similarity {sim:.2f}")
            if alert.get("service") not in distinct_services:
                why.append(f"different service ({alert.get('service')})")
            if not why:
                why.append("below the density threshold for this group")
            excluded.append({
                "id": alert.get("id"),
                "alertname": alert.get("alertname"),
                "service": alert.get("service"),
                "severity": alert.get("severity"),
                "timestamp": alert.get("timestamp"),
                "distance": round(dist, 2),
                "reasons": why,
            })

    return {
        "confidence_pct": confidence_pct,
        "factors": factors,
        "reasons": reasons,
        "excluded": excluded,
        "params": {
            "eps": EPS,
            "min_samples": MIN_SAMPLES,
            "time_scale_min": TIME_SCALE_MIN,
            "time_penalty": TIME_PENALTY,
        },
    }
