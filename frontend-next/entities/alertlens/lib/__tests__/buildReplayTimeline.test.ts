import { buildReplayTimeline } from "../buildReplayTimeline";
import { patchAlertInState } from "../patchAlert";
import { alert, cluster, pipelineState } from "../__fixtures__/alertlens";

describe("buildReplayTimeline", () => {
  const root = alert({
    id: "a1",
    service: "api-gateway",
    alertname: "UpstreamTimeout",
    timestamp: "2026-07-16T10:00:00",
  });
  const second = alert({
    id: "a2",
    service: "order-api",
    alertname: "DBQueryTimeout",
    timestamp: "2026-07-16T10:01:00",
    duplicate_count: 3,
  });

  const c = cluster({
    cluster_id: 7,
    alerts: [root, second],
    root_cause: root,
    dna_match: {
      similarity_pct: 42,
      incident_id: "INC-9",
      title: "Past incident",
      date: "2026-06-01",
      symptom_pattern: "s",
      root_cause: "r",
      resolution: "Rolled back",
      resolution_minutes: 18,
    },
  });

  it("returns nothing without a cluster", () => {
    expect(buildReplayTimeline(null)).toEqual([]);
    expect(buildReplayTimeline(cluster({ alerts: [] }))).toEqual([]);
  });

  it("emits events in chronological order", () => {
    const events = buildReplayTimeline(c);
    const stamps = events.map((e) => e.rawTimestamp);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it("covers the pipeline's decisions", () => {
    const categories = new Set(buildReplayTimeline(c).map((e) => e.category));
    expect(categories).toContain("alert");
    expect(categories).toContain("root");
    expect(categories).toContain("cluster");
    expect(categories).toContain("spread");
    expect(categories).toContain("dedup");
    expect(categories).toContain("dna");
    expect(categories).toContain("final");
  });

  it("identifies the root cause exactly once", () => {
    const roots = buildReplayTimeline(c).filter((e) => e.category === "root");
    expect(roots).toHaveLength(1);
    expect(roots[0].service).toBe("api-gateway");
  });

  it("forms the cluster exactly once", () => {
    expect(
      buildReplayTimeline(c).filter((e) => e.category === "cluster")
    ).toHaveLength(1);
  });

  it("only reports dedup where duplicates exist", () => {
    const dedup = buildReplayTimeline(c).filter((e) => e.category === "dedup");
    expect(dedup).toHaveLength(1);
    expect(dedup[0].title).toContain("2 duplicate alerts");
  });

  it("omits the DNA event when there is no match", () => {
    const noMatch = buildReplayTimeline(cluster({ ...c, dna_match: null }));
    expect(noMatch.some((e) => e.category === "dna")).toBe(false);
    // The incident is still promoted.
    expect(noMatch[noMatch.length - 1].category).toBe("final");
  });

  it("ends with promotion", () => {
    const events = buildReplayTimeline(c);
    expect(events[events.length - 1].category).toBe("final");
  });

  it("does not flag a spread for the first alert", () => {
    const single = buildReplayTimeline(cluster({ alerts: [root] }));
    expect(single.some((e) => e.category === "spread")).toBe(false);
  });

  it("explains every event", () => {
    for (const e of buildReplayTimeline(c)) {
      expect(e.whatHappened.length).toBeGreaterThan(0);
      expect(e.whyItHappened.length).toBeGreaterThan(0);
      expect(e.algorithm.length).toBeGreaterThan(0);
      expect(e.time).toMatch(/^\d{2}:\d{2}:\d{2}$/);
    }
  });
});

describe("patchAlertInState", () => {
  const a1 = alert({ id: "a1" });
  const a2 = alert({ id: "a2" });
  const state = pipelineState({
    raw_alerts: [a1, a2],
    noise: [a2],
    clusters: [cluster({ cluster_id: 1, alerts: [a1], root_cause: a1 })],
  });

  it("patches the alert everywhere it appears", () => {
    const out = patchAlertInState(state, "a1", { acked: true })!;
    expect(out.raw_alerts.find((a) => a.id === "a1")?.acked).toBe(true);
    expect(out.clusters[0].alerts[0].acked).toBe(true);
    expect(out.clusters[0].root_cause.acked).toBe(true);
  });

  it("leaves other alerts alone", () => {
    const out = patchAlertInState(state, "a1", { acked: true })!;
    expect(out.raw_alerts.find((a) => a.id === "a2")?.acked).toBeUndefined();
    expect(out.noise[0].acked).toBeUndefined();
  });

  it("does not mutate the original state", () => {
    const before = JSON.stringify(state);
    patchAlertInState(state, "a1", { acked: true });
    expect(JSON.stringify(state)).toBe(before);
  });

  it("passes undefined through", () => {
    expect(patchAlertInState(undefined, "a1", { acked: true })).toBeUndefined();
  });

  it("is a no-op for an unknown id", () => {
    const out = patchAlertInState(state, "nope", { acked: true })!;
    expect(out.raw_alerts.every((a) => a.acked === undefined)).toBe(true);
  });
});
