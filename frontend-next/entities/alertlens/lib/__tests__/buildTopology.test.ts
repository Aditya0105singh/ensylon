import { buildTopology, layoutTopology, NODE_H, NODE_W } from "../buildTopology";
import { alert, cluster, pipelineState } from "../__fixtures__/alertlens";

const gateway = alert({ id: "a1", service: "api-gateway", severity: "critical" });
const orderApi = alert({ id: "a2", service: "order-api", severity: "high" });
const idle = alert({ id: "a3", service: "cron-runner", severity: "info" });

const state = pipelineState({
  raw_alerts: [gateway, orderApi, idle],
  clusters: [cluster({ cluster_id: 1, alerts: [gateway, orderApi] })],
});

describe("buildTopology", () => {
  it("creates a node per service seen in the batch", () => {
    const { nodes } = buildTopology(state);
    expect(nodes.map((n) => n.id).sort()).toEqual([
      "api-gateway",
      "cron-runner",
      "order-api",
    ]);
  });

  it("draws edges from the root cause to the other services in its incident", () => {
    const { edges } = buildTopology(state);
    expect(edges).toHaveLength(1);
    expect(edges[0].source).toBe("api-gateway");
    expect(edges[0].target).toBe("order-api");
  });

  it("never links a service to itself", () => {
    const both = alert({ id: "a4", service: "api-gateway", severity: "info" });
    const { edges } = buildTopology(
      pipelineState({
        raw_alerts: [gateway, both],
        clusters: [cluster({ cluster_id: 1, alerts: [gateway, both] })],
      })
    );
    expect(edges).toHaveLength(0);
  });

  it("de-duplicates the same pair appearing in several incidents", () => {
    const c1 = cluster({ cluster_id: 1, alerts: [gateway, orderApi] });
    const c2 = cluster({ cluster_id: 2, alerts: [gateway, orderApi] });
    const { edges } = buildTopology(
      pipelineState({ raw_alerts: [gateway, orderApi], clusters: [c1, c2] })
    );
    expect(edges).toHaveLength(1);
  });

  it("marks the root-cause service critical and uninvolved services healthy", () => {
    const { nodes } = buildTopology(state);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["api-gateway"].isRoot).toBe(true);
    expect(byId["api-gateway"].status).toBe("critical");
    expect(byId["cron-runner"].status).toBe("healthy");
    expect(byId["cron-runner"].cluster).toBeNull();
  });

  it("attributes a service to its highest-risk incident", () => {
    const low = cluster({
      cluster_id: 1,
      alerts: [orderApi],
      risk: {
        score: 0.2,
        level: "low",
        factors: { growth_rate: 0, severity_trend: 0, service_spread: 0 },
        services_affected: 1,
      },
    });
    const high = cluster({ cluster_id: 2, alerts: [orderApi] });
    const { nodes } = buildTopology(
      pipelineState({ raw_alerts: [orderApi], clusters: [low, high] })
    );
    expect(nodes[0].cluster?.cluster_id).toBe(2);
  });

  it("computes error rate from critical and high alerts", () => {
    const { nodes } = buildTopology(state);
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(byId["api-gateway"].errorRate).toBe(100);
    expect(byId["cron-runner"].errorRate).toBe(0);
  });

  it("handles an empty batch", () => {
    const { nodes, edges } = buildTopology(pipelineState());
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });
});

describe("layoutTopology", () => {
  it("positions every node exactly once", () => {
    const { nodes, edges } = buildTopology(state);
    const positions = layoutTopology(nodes, edges);
    expect(Object.keys(positions).sort()).toEqual(nodes.map((n) => n.id).sort());
  });

  it("produces finite coordinates", () => {
    const { nodes, edges } = buildTopology(state);
    for (const p of Object.values(layoutTopology(nodes, edges))) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it("parks unaffected services below the incident graph", () => {
    const { nodes, edges } = buildTopology(state);
    const positions = layoutTopology(nodes, edges);
    const connectedMaxY = Math.max(
      ...nodes.filter((n) => n.cluster).map((n) => positions[n.id].y)
    );
    expect(positions["cron-runner"].y).toBeGreaterThan(connectedMaxY + NODE_H);
  });

  it("exposes node dimensions used for measurement", () => {
    expect(NODE_W).toBeGreaterThan(0);
    expect(NODE_H).toBeGreaterThan(0);
  });
});
