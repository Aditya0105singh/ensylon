"""Escalation Risk Score — differentiator #1.

Predicts which incident cluster is trending toward a bigger failure. This is a
deliberately explainable heuristic, not a trained model: every input can be
defended under judge questioning, and each factor maps to something an on-call
engineer already watches instinctively.

    risk = 0.4 * growth_rate + 0.35 * severity_trend + 0.25 * service_spread

Factors (each normalized to 0..1):
- growth_rate:    alerts/minute joining the cluster, capped at CAP_ALERTS_PER_MIN.
                  A cluster gaining 6 alerts/min is a fire, not a blip.
- severity_trend: mean severity of the cluster, plus a bonus when newer alerts
                  are MORE severe than earlier ones (and a penalty when it is
                  cooling off). A cascade that starts critical stays hot.
- service_spread: distinct services in the cluster / CAP_SERVICES. One service
                  = contained; five services = it's jumping the fence.
"""

from __future__ import annotations

from datetime import datetime

SEVERITY_WEIGHT = {"info": 0.2, "low": 0.3, "medium": 0.45, "high": 0.6, "critical": 1.0}
CAP_ALERTS_PER_MIN = 5.0
CAP_SERVICES = 5

WEIGHTS = {"growth_rate": 0.40, "severity_trend": 0.35, "service_spread": 0.25}

LEVELS = [(0.66, "high"), (0.33, "medium"), (0.0, "low")]


def _ts(alert: dict) -> datetime:
    ts = alert["timestamp"]
    return datetime.fromisoformat(ts) if isinstance(ts, str) else ts


def _growth_rate(alerts: list[dict]) -> float:
    if len(alerts) < 2:
        return 0.0
    span_min = max((_ts(alerts[-1]) - _ts(alerts[0])).total_seconds() / 60, 0.5)
    return min((len(alerts) / span_min) / CAP_ALERTS_PER_MIN, 1.0)


def _severity_trend(alerts: list[dict]) -> float:
    mean = lambda chunk: sum(SEVERITY_WEIGHT.get(a["severity"], 0.2) for a in chunk) / len(chunk)
    if len(alerts) < 3:
        return mean(alerts) if alerts else 0.0
    third = max(len(alerts) // 3, 1)
    # base = how severe the cluster is overall; bonus/penalty = direction
    trend = mean(alerts[-third:]) - mean(alerts[:third])
    return max(min(mean(alerts) + 0.4 * trend, 1.0), 0.0)


def _service_spread(alerts: list[dict]) -> float:
    return min(len({a["service"] for a in alerts}) / CAP_SERVICES, 1.0)


def escalation_risk(alerts: list[dict]) -> dict:
    """Score one cluster's alerts (chronologically sorted internally).

    Returns the score, level, and per-factor breakdown — the breakdown is what
    makes the score explainable in the UI ("escalating: 3 new services in 2 min").
    """
    alerts = sorted(alerts, key=lambda a: a["timestamp"])
    factors = {
        "growth_rate": _growth_rate(alerts),
        "severity_trend": _severity_trend(alerts),
        "service_spread": _service_spread(alerts),
    }
    score = sum(WEIGHTS[k] * v for k, v in factors.items())
    level = next(name for threshold, name in LEVELS if score >= threshold)
    return {
        "score": round(score, 3),
        "level": level,
        "factors": {k: round(v, 3) for k, v in factors.items()},
        "services_affected": len({a["service"] for a in alerts}),
    }
