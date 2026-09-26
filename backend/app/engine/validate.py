"""VALIDATE - candidate clusters must earn acceptance as incidents (C4).

Clustering proposes; validation decides. Five checks, each recorded on the
cluster with a pass/fail and a reason so the reviewer sees why an incident
exists (or why a candidate did not become one):

  1. Environment consistency. A prod signal and a staging signal describe two
     different systems even when every name matches. Mixed clusters are split
     by environment; signals with no stated environment join the majority.
  2. Weak bridge. If one signal is the only thing holding two otherwise
     separate groups together (an articulation point in the cluster's link
     graph) and its links are weak, the cluster is split there. This is the
     "chain" failure: A-B strong, B-C strong, but A and C unrelated.
  3. Coherence. Enough of the cluster's signal pairs must be directly linked
     (pass the structural gate and the merge threshold). A cluster that is
     mostly a chain of single links is not one incident.
  4. Anomaly support. At least one signal must be clearly anomalous; a cluster
     assembled only from borderline signals is not raised.
  5. Independent evidence. The signals must describe at least two distinct
     conditions (service + source + log template or metric), unless the one
     condition is itself an error or a firing alarm (a flapping alarm is still
     one real incident). Ten copies of one warning on one service are one
     observation repeated, not corroboration; on a cold start, when every
     warning is "novel", this is what keeps a routine repeat from being raised.

Correlation Confidence (0-1) is computed here too, separately from impact
severity and never blended with it:

    confidence = 0.40 * density + 0.35 * topology_support + 0.25 * evidence_agreement

  density             share of signal pairs directly linked (gate + threshold)
  topology_support    share of pairs whose services are the same or within 2 hops
  evidence_agreement  mean, over signals, of each signal's best evidence match
                      (log template / alert text similarity, or same component)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from itertools import combinations

import networkx as nx

from . import correlate as corr
from .correlate import Cluster, DependencyGraph, component_match, similarity, template_similarity
from .signal import Severity

W_DENSITY = 0.40
W_TOPOLOGY = 0.35
W_EVIDENCE = 0.25

MIN_DENSITY = 0.25          # coherence: at least a quarter of pairs directly linked
WEAK_BRIDGE = 0.50          # a bridge whose best link scores below this is weak
MIN_ANOMALY = 0.60          # anomaly support: strongest signal must reach this
_MAX_PAIRS = 2500           # large clusters: confidence from a bounded sample


@dataclass
class Check:
    name: str
    passed: bool
    detail: str

    def as_dict(self) -> dict:
        return {"name": self.name, "passed": self.passed, "detail": self.detail}


@dataclass
class Verdict:
    accepted: list[Cluster] = field(default_factory=list)
    rejected: list[tuple[Cluster, list[Check]]] = field(default_factory=list)


# --------------------------------------------------------------------------
# link graph
# --------------------------------------------------------------------------

def _links(cluster: Cluster, graph: DependencyGraph) -> nx.Graph:
    """Direct links inside the cluster: pairs passing the gate and the merge threshold."""
    g = nx.Graph()
    g.add_nodes_from(range(len(cluster.signals)))
    threshold = 1.0 - corr.EPS
    for i, j in combinations(range(len(cluster.signals)), 2):
        sim = similarity(cluster.signals[i], cluster.signals[j], graph)
        if sim is not None and sim.total >= threshold:
            g.add_edge(i, j, weight=sim.total)
    return g


def _density(links: nx.Graph) -> float:
    n = links.number_of_nodes()
    possible = n * (n - 1) / 2
    return links.number_of_edges() / possible if possible else 1.0


# --------------------------------------------------------------------------
# checks
# --------------------------------------------------------------------------

def _split_by_environment(cluster: Cluster) -> tuple[list[list], Check]:
    envs = [s.environment for s in cluster.signals if s.environment]
    distinct = sorted(set(envs))
    if len(distinct) <= 1:
        label = distinct[0] if distinct else "not stated"
        return [cluster.signals], Check("environment consistency", True, f"single environment ({label})")
    majority = max(distinct, key=envs.count)
    groups: dict[str, list] = {env: [] for env in distinct}
    for s in cluster.signals:
        groups[s.environment or majority].append(s)
    return list(groups.values()), Check(
        "environment consistency", False,
        f"mixed environments {', '.join(distinct)}; split into one candidate per environment",
    )


def _weak_bridge_split(cluster: Cluster, links: nx.Graph) -> tuple[list[list], Check]:
    if links.number_of_nodes() < 5 or not nx.is_connected(links):
        return [cluster.signals], Check("weak bridge", True, "no single-signal bridge")
    for node in nx.articulation_points(links):
        rest = links.copy()
        rest.remove_node(node)
        parts = [sorted(c) for c in nx.connected_components(rest)]
        if sum(1 for p in parts if len(p) >= 2) < 2:
            continue
        best = max((d["weight"] for _, _, d in links.edges(node, data=True)), default=0.0)
        if best >= WEAK_BRIDGE:
            continue
        # The bridge stays with the side it is most strongly linked to.
        side = max(parts, key=lambda p: max((links[node][m]["weight"] for m in p if links.has_edge(node, m)), default=0.0))
        side.append(node)
        groups = [[cluster.signals[i] for i in p] for p in parts]
        bridge = cluster.signals[node]
        return groups, Check(
            "weak bridge", False,
            f"{bridge.service} was the only link between {len(parts)} groups (best link {best:.2f} < {WEAK_BRIDGE}); split",
        )
    return [cluster.signals], Check("weak bridge", True, "no weak single-signal bridge")


def _coherence(links: nx.Graph) -> Check:
    density = _density(links)
    if links.number_of_nodes() <= 3:
        return Check("coherence", True, f"small cluster, {links.number_of_edges()} direct link(s)")
    ok = density >= MIN_DENSITY
    return Check("coherence", ok, f"{density:.0%} of signal pairs directly linked (minimum {MIN_DENSITY:.0%})")


def _anomaly_support(cluster: Cluster) -> Check:
    top = max((s.anomaly_score for s in cluster.signals), default=0.0)
    ok = top >= MIN_ANOMALY
    return Check("anomaly support", ok, f"strongest anomaly score {top:.2f} (minimum {MIN_ANOMALY})")


# A repeated error or firing alarm is evidence on its own; a repeated warning is not.
_SELF_EVIDENT = {Severity.CRITICAL, Severity.HIGH}


def _condition(s) -> tuple[str, str, str]:
    """What a signal observed: where, from which stream, and which template or metric."""
    source = str(getattr(s.source, "value", s.source))
    return (s.service, source, s.template_id or s.metric or (s.message or "")[:60])


def _independent_evidence(cluster: Cluster) -> Check:
    conditions = {_condition(s) for s in cluster.signals}
    if len(conditions) >= 2:
        return Check("independent evidence", True, f"{len(conditions)} distinct conditions")
    service = cluster.signals[0].service
    if all(s.severity in _SELF_EVIDENT for s in cluster.signals):
        return Check(
            "independent evidence", True,
            f"one condition on {service}, repeated {len(cluster.signals)}× at error/alarm severity",
        )
    return Check(
        "independent evidence", False,
        f"all {len(cluster.signals)} signals repeat one warning on {service}; a repeat is not corroboration",
    )


# --------------------------------------------------------------------------
# confidence
# --------------------------------------------------------------------------

def correlation_confidence(cluster: Cluster, graph: DependencyGraph, links: nx.Graph | None = None) -> tuple[float, list[dict]]:
    signals = cluster.signals
    links = links if links is not None else _links(cluster, graph)
    pairs = list(combinations(range(len(signals)), 2))[:_MAX_PAIRS]
    density = _density(links)

    near = 0
    for i, j in pairs:
        hop = graph.hops(signals[i].service, signals[j].service)
        near += 1 if (hop is not None and hop <= 2) else 0
    topology = near / len(pairs) if pairs else 1.0

    best: list[float] = []
    for i, a in enumerate(signals):
        scores = [max(template_similarity(a, b), component_match(a, b)) for j, b in enumerate(signals) if j != i]
        best.append(max(scores) if scores else 0.0)
    evidence = sum(best) / len(best) if best else 0.0

    value = round(min(1.0, W_DENSITY * density + W_TOPOLOGY * topology + W_EVIDENCE * evidence), 2)
    parts = [
        {"label": f"Cluster density ({density:.0%} of pairs directly linked)", "points": round(W_DENSITY * density, 2)},
        {"label": f"Topology support ({topology:.0%} of pairs within 2 hops)", "points": round(W_TOPOLOGY * topology, 2)},
        {"label": f"Evidence agreement (mean best match {evidence:.2f})", "points": round(W_EVIDENCE * evidence, 2)},
    ]
    return value, parts


# --------------------------------------------------------------------------
# entry point
# --------------------------------------------------------------------------

def _as_cluster(signals: list, template: Cluster) -> Cluster:
    part = Cluster(cluster_id=template.cluster_id, signals=sorted(signals, key=lambda s: s.timestamp))
    part.gate_reasons = dict(template.gate_reasons)
    part.mean_similarity = template.mean_similarity
    return part


def validate(clusters: list[Cluster], graph: DependencyGraph) -> Verdict:
    """Validate (and where a check says so, split) every candidate cluster."""
    verdict = Verdict()
    queue: list[tuple[Cluster, list[Check]]] = [(c, []) for c in clusters]
    while queue:
        cluster, history = queue.pop(0)
        if len(cluster.signals) < 2:
            verdict.rejected.append((cluster, history + [Check("size", False, "fewer than two signals")]))
            continue

        groups, env = _split_by_environment(cluster)
        if len(groups) > 1:
            queue.extend((_as_cluster(g, cluster), history + [env]) for g in groups)
            continue

        links = _links(cluster, graph)
        groups, bridge = _weak_bridge_split(cluster, links)
        if len(groups) > 1:
            queue.extend((_as_cluster(g, cluster), history + [bridge]) for g in groups)
            continue

        checks = history + [env, bridge, _coherence(links), _anomaly_support(cluster), _independent_evidence(cluster)]
        # A split is recorded as a failed check on the parent, but the parts are
        # re-validated on their own merits; only the checks run on *this* set of
        # signals decide acceptance.
        own = checks[len(history):]
        if all(c.passed for c in own):
            cluster.confidence, cluster.confidence_parts = correlation_confidence(cluster, graph, links)
            cluster.validation = [c.as_dict() for c in checks]
            verdict.accepted.append(cluster)
        else:
            verdict.rejected.append((cluster, checks))
    return verdict
