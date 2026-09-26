import dagre from "@dagrejs/dagre";
import type { Alert, Cluster, PipelineState } from "../model/types";

export type TopologyStatus = "critical" | "warning" | "healthy";

export interface ServiceStats {
  total: number;
  critical: number;
  high: number;
  info: number;
  alerts: Alert[];
}

export interface TopologyNode {
  id: string;
  service: string;
  cluster: Cluster | null;
  isRoot: boolean;
  errorRate: number;
  activeAlerts: number;
  stats: ServiceStats;
  status: TopologyStatus;
}

export interface TopologyEdge {
  id: string;
  source: string;
  target: string;
  cluster: Cluster;
}

const emptyStats = (): ServiceStats => ({
  total: 0,
  critical: 0,
  high: 0,
  info: 0,
  alerts: [],
});

/**
 * Derives a service graph from pipeline output.
 *
 * Edges are correlation-derived (root-cause service -> other services in the
 * same incident), not a fabricated architecture diagram — the same approach
 * the original AlertLens topology view used.
 */
export function buildTopology(state: PipelineState): {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
} {
  const clusters = state.clusters ?? [];
  const rawAlerts = state.raw_alerts ?? [];

  const serviceStats = new Map<string, ServiceStats>();
  for (const a of rawAlerts) {
    if (!a.service) continue;
    if (!serviceStats.has(a.service)) serviceStats.set(a.service, emptyStats());
    const s = serviceStats.get(a.service)!;
    s.total += 1;
    if (a.severity === "critical") s.critical += 1;
    else if (a.severity === "high") s.high += 1;
    else s.info += 1;
    s.alerts.push(a);
  }

  const rootCauseServices = new Set(clusters.map((c) => c.root_cause.service));

  // Each service is attributed to the highest-risk incident it appears in.
  const serviceCluster = new Map<string, Cluster>();
  for (const c of clusters) {
    for (const svc of new Set(c.alerts.map((a) => a.service))) {
      const existing = serviceCluster.get(svc);
      if (!existing || c.risk.score > existing.risk.score) {
        serviceCluster.set(svc, c);
      }
    }
  }

  const allServices = new Set([
    ...serviceStats.keys(),
    ...rootCauseServices,
  ]);

  const nodes: TopologyNode[] = [...allServices].map((service) => {
    const stats = serviceStats.get(service) ?? emptyStats();
    const cluster = serviceCluster.get(service) ?? null;
    const errorRate = stats.total
      ? Math.round(((stats.critical + stats.high) / stats.total) * 100)
      : 0;
    const isRoot =
      rootCauseServices.has(service) &&
      cluster?.root_cause.service === service;
    const status: TopologyStatus = cluster
      ? isRoot || cluster.risk.level === "high"
        ? "critical"
        : "warning"
      : "healthy";

    return {
      id: service,
      service,
      cluster,
      isRoot,
      errorRate,
      activeAlerts: stats.total,
      stats,
      status,
    };
  });

  const edgeMap = new Map<string, TopologyEdge>();
  for (const c of clusters) {
    const root = c.root_cause.service;
    const members = [...new Set(c.alerts.map((a) => a.service))].filter(
      (s) => s !== root
    );
    for (const svc of members) {
      const key = [root, svc].sort().join("::");
      if (!edgeMap.has(key)) {
        edgeMap.set(key, { id: key, source: root, target: svc, cluster: c });
      }
    }
  }

  return { nodes, edges: [...edgeMap.values()] };
}

export const NODE_W = 210;
export const NODE_H = 96;

/**
 * Services caught up in an incident get a dagre layout so the incident graph
 * stays readable; unaffected services are parked in a grid below so one big
 * sparse graph doesn't force a zoom-out.
 */
export function layoutTopology(
  nodes: TopologyNode[],
  edges: TopologyEdge[]
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};

  const connected = nodes.filter((n) => n.cluster);
  const idle = nodes.filter((n) => !n.cluster);

  const g = new dagre.graphlib.Graph();
  // Left-to-right: dependency chains are long and the canvas is wide, so a
  // top-to-bottom layout forced a zoom-out that shrank every node to a speck.
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90, align: "UL" });
  g.setDefaultEdgeLabel(() => ({}));

  connected.forEach((n) =>
    g.setNode(n.id, { width: NODE_W, height: NODE_H })
  );
  const connectedIds = new Set(connected.map((n) => n.id));
  edges
    .filter((e) => connectedIds.has(e.source) && connectedIds.has(e.target))
    .forEach((e) => g.setEdge(e.source, e.target));

  dagre.layout(g);

  let maxY = 0;
  connected.forEach((n) => {
    const pos = g.node(n.id);
    if (!pos) return;
    positions[n.id] = {
      x: pos.x - NODE_W / 2,
      y: pos.y - NODE_H / 2,
    };
    maxY = Math.max(maxY, positions[n.id].y);
  });

  const perRow = 4;
  const startY = maxY + NODE_H + 80;
  idle.forEach((n, i) => {
    positions[n.id] = {
      x: (i % perRow) * (NODE_W + 32),
      y: startY + Math.floor(i / perRow) * (NODE_H + 32),
    };
  });

  return positions;
}
