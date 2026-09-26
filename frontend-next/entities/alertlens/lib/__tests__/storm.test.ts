import {
  buildSchedule,
  projectStorm,
  STORM_SECONDS,
} from "../../model/useStormStore";
import { alert, cluster, pipelineState } from "../__fixtures__/alertlens";

describe("buildSchedule", () => {
  it("returns nothing for an empty batch", () => {
    expect(buildSchedule([]).size).toBe(0);
  });

  it("reveals pre-window history immediately", () => {
    // 3 hours older than the newest alert, well outside the replay window.
    const old = alert({ id: "old", timestamp: "2026-07-16T07:00:00" });
    const recent = alert({ id: "recent", timestamp: "2026-07-16T10:00:00" });
    const schedule = buildSchedule([old, recent]);
    expect(schedule.get("old")).toBe(0);
    expect(schedule.get("recent")).toBeGreaterThan(0);
  });

  it("keeps every alert inside the replay length", () => {
    const alerts = Array.from({ length: 20 }, (_, i) =>
      alert({
        id: `a${i}`,
        timestamp: `2026-07-16T10:${String(i).padStart(2, "0")}:00`,
      })
    );
    for (const at of buildSchedule(alerts).values()) {
      expect(at).toBeGreaterThanOrEqual(0);
      expect(at).toBeLessThanOrEqual(STORM_SECONDS);
    }
  });

  it("preserves chronological order", () => {
    const alerts = Array.from({ length: 6 }, (_, i) =>
      alert({
        id: `a${i}`,
        timestamp: `2026-07-16T10:${String(i * 5).padStart(2, "0")}:00`,
      })
    );
    const schedule = buildSchedule(alerts);
    const times = alerts.map((a) => schedule.get(a.id)!);
    const sorted = [...times].sort((x, y) => x - y);
    expect(times).toEqual(sorted);
  });

  it("separates alerts that share a timestamp", () => {
    const alerts = Array.from({ length: 5 }, (_, i) =>
      alert({ id: `a${i}`, timestamp: "2026-07-16T10:00:00" })
    );
    const times = [...buildSchedule(alerts).values()];
    expect(new Set(times).size).toBe(times.length);
  });
});

describe("projectStorm", () => {
  const a1 = alert({ id: "a1", service: "api-gateway" });
  const a2 = alert({ id: "a2", service: "order-api" });
  const a3 = alert({ id: "a3", service: "order-api" });

  const state = pipelineState({
    raw_alerts: [a1, a2, a3],
    noise: [a3],
    clusters: [
      cluster({
        cluster_id: 1,
        alerts: [a1, a2],
        dna_match: {
          similarity_pct: 40,
          incident_id: "INC-1",
          title: "t",
          date: "2026-01-01",
          symptom_pattern: "s",
          root_cause: "r",
        },
      }),
    ],
  });

  it("hides everything before anything is revealed", () => {
    const out = projectStorm(state, new Set());
    expect(out.clusters).toHaveLength(0);
    expect(out.raw_alerts).toHaveLength(0);
    expect(out.dedup_stats?.raw_count).toBe(0);
  });

  it("shows only revealed members of a cluster", () => {
    const out = projectStorm(state, new Set(["a1"]));
    expect(out.clusters).toHaveLength(1);
    expect(out.clusters[0].size).toBe(1);
    expect(out.clusters[0].alerts.map((a) => a.id)).toEqual(["a1"]);
  });

  it("scales risk toward the real score as members arrive", () => {
    const partial = projectStorm(state, new Set(["a1"]));
    const complete = projectStorm(state, new Set(["a1", "a2"]));
    expect(partial.clusters[0].risk.score).toBeLessThan(
      complete.clusters[0].risk.score
    );
    // Once fully revealed it must match the engine's own score exactly.
    expect(complete.clusters[0].risk.score).toBeCloseTo(0.8, 5);
  });

  it("never exceeds the real risk score", () => {
    for (const revealed of [["a1"], ["a1", "a2"]]) {
      const out = projectStorm(state, new Set(revealed));
      expect(out.clusters[0].risk.score).toBeLessThanOrEqual(0.8);
    }
  });

  it("withholds the historical match until the pattern is complete", () => {
    expect(projectStorm(state, new Set(["a1"])).clusters[0].dna_match).toBeNull();
    expect(
      projectStorm(state, new Set(["a1", "a2"])).clusters[0].dna_match
    ).not.toBeNull();
  });

  it("recomputes dedup stats from what is visible", () => {
    const out = projectStorm(state, new Set(["a1", "a2", "a3"]));
    expect(out.dedup_stats?.raw_count).toBe(3);
    // 2 clustered + 1 noise
    expect(out.dedup_stats?.unique_count).toBe(3);
  });

  it("counts services from revealed members only", () => {
    const out = projectStorm(state, new Set(["a1"]));
    expect(out.clusters[0].risk.services_affected).toBe(1);
    const both = projectStorm(state, new Set(["a1", "a2"]));
    expect(both.clusters[0].risk.services_affected).toBe(2);
  });

  it("leaves the source state untouched", () => {
    const before = JSON.stringify(state);
    projectStorm(state, new Set(["a1"]));
    expect(JSON.stringify(state)).toBe(before);
  });
});
