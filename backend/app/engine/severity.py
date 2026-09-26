"""SCORE & IMPACT — severity beyond a threshold breach.

A breached threshold tells you a number crossed a line. It does not tell you
whether anyone should be woken up. Impact Severity (0-100) is built from exactly
the three factors the brief names, each visible in the ticket so a reviewer can
audit the score instead of trusting it:

    0.40  blast radius         — how much is affected, and how much more could be
    0.35  business criticality — the most critical service involved (0-100 map,
                                   unknown services a neutral 50)
    0.25  anomaly magnitude    — how far the strongest signal is from normal

Trend direction and signal diversity are still computed and shown as context,
but carry no weight: they describe the incident, they are not its impact.
Correlation Confidence is a separate score (validate.correlation_confidence)
and is never blended into this one.

Weights are explicit rather than learned. An operator can retune them for their
environment and immediately understand the effect, which is not true of an
embedding-based scorer — and under a 24-hour clock, a score we can defend when
a judge asks "why is this a P1?" beats a more accurate one we cannot.

Suppression runs *before* escalation, not after scoring. An incident inside a
declared maintenance window is still drafted and queued for review — it may be
real — but it never escalates. Paging loudly during a planned deploy is the
fastest way for a team to stop trusting the system.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta

from .causal import CausalResult, _dependents
from .correlate import Cluster, DependencyGraph
from .signal import SEVERITY_RANK, SignalSource

W_BLAST = 0.40
W_CRITICALITY = 0.35
W_MAGNITUDE = 0.25
# Context only: reported, not weighted.
W_TREND = 0.0
W_DIVERSITY = 0.0

# Priority bands on the 0-100 impact scale.
P1_THRESHOLD = 0.75
P2_THRESHOLD = 0.50
P3_THRESHOLD = 0.25

# Reference scale: an incident touching five services is treated as full blast
# radius. Chosen to match the topology's typical fan-out rather than being a
# round number - in a wider estate this is the first thing to retune.
BLAST_REFERENCE = 5.0


# --------------------------------------------------------------------------
# service registry
# --------------------------------------------------------------------------

CRITICALITY: dict[str, float] = {
    # Revenue and authentication paths. An outage here is customer-visible
    # immediately, regardless of how few alerts it produced.
    "payment-svc": 1.0,
    "checkout-bff": 1.0,
    "auth-service": 1.0,
    "postgres-primary": 0.95,
    "api-gateway": 0.9,
    "order-api": 0.85,
    "redis-cache": 0.7,
    "session-svc": 0.7,
    "web-frontend": 0.65,
    "stripe-gateway": 0.9,
    # Batch and internal tooling. Real, but nobody should be paged at 3am.
    "postgres-replica": 0.4,
    "report-worker": 0.3,
    "log-archive": 0.2,
    "ci-runner": 0.15,
}

DEFAULT_CRITICALITY = 0.5


@dataclass
class MaintenanceWindow:
    services: set[str]
    start: datetime
    end: datetime
    reason: str = "planned maintenance"

    def covers(self, service: str, when: datetime) -> bool:
        return service in self.services and self.start <= when <= self.end


@dataclass
class SeverityBreakdown:
    blast_radius: float
    business_criticality: float
    trend_direction: float
    signal_diversity: float
    score: float           # impact severity on a 0-1 scale (x100 for display)
    priority: str
    anomaly_magnitude: float = 0.0
    suppressed: bool = False
    suppression_reason: str = ""
    flap_count: int = 0
    factors: dict[str, str] = field(default_factory=dict)

    @property
    def impact(self) -> int:
        """Impact Severity on the brief's 0-100 scale."""
        return round(self.score * 100)

    def as_line(self) -> str:
        return (
            f"{self.priority} — impact {self.impact}/100 "
            f"(blast {self.blast_radius:.2f} · criticality {self.business_criticality:.2f} · "
            f"magnitude {self.anomaly_magnitude:.2f})"
        )


# --------------------------------------------------------------------------
# factors
# --------------------------------------------------------------------------


def blast_radius(
    cluster: Cluster, causal: CausalResult, graph: DependencyGraph
) -> tuple[float, str]:
    """Damage done, plus damage still available to be done.

    The second half matters as much as the first: a database with twelve
    dependents that has so far only broken two of them is a far more urgent
    incident than one that has already broken everything it can reach.
    """
    affected = set(cluster.services)
    size = min(len(affected) / BLAST_REFERENCE, 1.0)

    potential: set[str] = set()
    if causal.root_cause_service:
        potential = _dependents(graph, causal.root_cause_service) - affected
    reach = min(len(potential) / BLAST_REFERENCE, 1.0)

    score = 0.7 * size + 0.3 * reach
    detail = f"{len(affected)} service(s) affected"
    if potential:
        detail += f", {len(potential)} more downstream of the root cause"
    return round(score, 3), detail


def business_criticality(
    cluster: Cluster, registry: dict[str, float] | None = None
) -> tuple[float, str]:
    """Highest-criticality service involved, not the average.

    Averaging would let a critical payment service be diluted by four noisy
    batch workers in the same incident — precisely inverting the priority.

    `registry` lets a deployment supply its own service catalogue; the module
    default only describes one estate and would score every other one as
    uniformly average.
    """
    table = registry or CRITICALITY
    ranked = sorted(
        ((table.get(s, DEFAULT_CRITICALITY), s) for s in cluster.services),
        reverse=True,
    )
    if not ranked:
        return DEFAULT_CRITICALITY, "no services identified"
    top_score, top_service = ranked[0]
    return round(top_score, 3), f"{top_service} (criticality {top_score:.2f})"


def trend_direction(cluster: Cluster) -> tuple[float, str]:
    """Is the signal arrival rate still climbing?

    Split the incident window in half and compare arrival counts. A rising
    incident is more urgent than an equally severe one already recovering, and
    this is the cheapest honest way to tell them apart.
    """
    signals = sorted(cluster.signals, key=lambda s: s.timestamp)
    if len(signals) < 4:
        return 0.5, "too few signals to establish a trend"

    start, end = signals[0].timestamp, signals[-1].timestamp
    span = (end - start).total_seconds()
    if span <= 0:
        return 0.8, "all signals arrived simultaneously"

    midpoint = start + timedelta(seconds=span / 2)
    first = sum(1 for s in signals if s.timestamp <= midpoint)
    second = len(signals) - first

    if first == 0:
        return 1.0, "all activity in the later half — sharply rising"
    ratio = second / first
    score = min(ratio / 2.0, 1.0)
    if ratio >= 1.2:
        detail = f"rising ({second} signals in 2nd half vs {first} in 1st)"
    elif ratio <= 0.6:
        detail = f"decaying ({second} vs {first}) — may be self-healing"
    else:
        detail = f"steady ({second} vs {first})"
    return round(score, 3), detail


def anomaly_magnitude(cluster: Cluster) -> tuple[float, str]:
    """How far the incident's strongest evidence is from normal.

    The strongest signal, not the average: one alarm far past its threshold is
    what makes an incident severe, and averaging it with minor log lines would
    hide it. Scores come from DETECT (z-scores, breach ratios, burst rates).
    """
    if not cluster.signals:
        return 0.0, "no signals"
    top = max(cluster.signals, key=lambda s: s.anomaly_score)
    detail = f"{top.service}: {top.anomaly_score:.2f}"
    if top.metric and top.value is not None and top.threshold:
        detail += f" ({top.metric} {top.value:g} vs threshold {top.threshold:g})"
    return round(min(max(top.anomaly_score, 0.0), 1.0), 3), detail


def signal_diversity(cluster: Cluster) -> tuple[float, str]:
    """Independent corroboration across metric, log and trace families.

    One misconfigured exporter can produce a large anomaly on its own. Three
    different observability systems independently reporting trouble is very
    hard to fake, so agreement is strong evidence against a false positive.
    """
    families = {
        SignalSource.CLOUDWATCH_METRIC: "metric",
        SignalSource.GRAFANA_ALERT: "metric",
        SignalSource.CLOUDWATCH_LOG: "log",
        SignalSource.APP_LOG: "log",
        SignalSource.TRACE_SPAN: "trace",
    }
    present = sorted({families.get(s.source, "other") for s in cluster.signals})
    score = min(len(present) / 3.0, 1.0)
    return round(score, 3), f"{len(present)} source families: {', '.join(present)}"


# --------------------------------------------------------------------------
# suppression
# --------------------------------------------------------------------------


def _maintenance_suppression(
    cluster: Cluster, windows: list[MaintenanceWindow]
) -> str | None:
    """Suppress only when *every* affected service is covered.

    Partial coverage must not suppress: an incident that has spread beyond the
    deploy is exactly the incident someone needs to see.
    """
    if not windows:
        return None
    affected = set(cluster.services)
    when = cluster.start
    for window in windows:
        if affected <= window.services and window.start <= when <= window.end:
            return f"all affected services inside maintenance window ({window.reason})"
    return None


def flap_count(cluster: Cluster) -> int:
    """How many times this looks like the same condition re-firing.

    Counts repeats of the dominant (service, template) pair. A service
    oscillating across a threshold should become one incident with a flap
    count, not twenty tickets.
    """
    counts: dict[str, int] = {}
    for signal in cluster.signals:
        key = f"{signal.service}|{signal.template_id or signal.metric or ''}"
        counts[key] = counts.get(key, 0) + 1
    return max(counts.values()) if counts else 1


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------


def score_incident(
    cluster: Cluster,
    causal: CausalResult,
    graph: DependencyGraph,
    maintenance: list[MaintenanceWindow] | None = None,
    criticality: dict[str, float] | None = None,
) -> SeverityBreakdown:
    blast, blast_detail = blast_radius(cluster, causal, graph)
    crit, crit_detail = business_criticality(cluster, criticality)
    magnitude, magnitude_detail = anomaly_magnitude(cluster)
    trend, trend_detail = trend_direction(cluster)
    diversity, diversity_detail = signal_diversity(cluster)

    score = W_BLAST * blast + W_CRITICALITY * crit + W_MAGNITUDE * magnitude
    score = round(min(max(score, 0.0), 1.0), 3)

    priority = ("P1" if score >= P1_THRESHOLD else "P2" if score >= P2_THRESHOLD
                else "P3" if score >= P3_THRESHOLD else "P4")

    breakdown = SeverityBreakdown(
        blast_radius=blast,
        business_criticality=crit,
        trend_direction=trend,
        signal_diversity=diversity,
        score=score,
        priority=priority,
        anomaly_magnitude=magnitude,
        flap_count=flap_count(cluster),
        factors={
            "blast radius": blast_detail,
            "business criticality": crit_detail,
            "anomaly magnitude": magnitude_detail,
            "trend": trend_detail,
            "signal diversity": diversity_detail,
        },
    )

    reason = _maintenance_suppression(cluster, maintenance or [])
    if reason:
        breakdown.suppressed = True
        breakdown.suppression_reason = reason
        breakdown.factors["suppression"] = reason

    return breakdown


# --------------------------------------------------------------------------
# calibration guard
# --------------------------------------------------------------------------


def p1_rate_warning(breakdowns: list[SeverityBreakdown], ceiling: float = 0.4) -> str | None:
    """Flag over-alerting as a detectable system fault.

    If most incidents in a window score P1, the scale has lost its meaning —
    the honest response is to say the calibration is off, not to page on all
    of them and let the team work out later that P1 stopped meaning anything.
    """
    if len(breakdowns) < 3:
        return None
    live = [b for b in breakdowns if not b.suppressed]
    if not live:
        return None
    p1_share = sum(1 for b in live if b.priority == "P1") / len(live)
    if p1_share > ceiling:
        return (
            f"calibration warning: {p1_share:.0%} of incidents scored P1 "
            f"(ceiling {ceiling:.0%}) — severity weights likely need retuning"
        )
    return None
