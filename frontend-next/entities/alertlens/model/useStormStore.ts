"use client";

import { create } from "zustand";
import type { Alert, PipelineState } from "./types";

/** Replay length in seconds at 1x speed. */
export const STORM_SECONDS = 25;
/** Alerts older than this many minutes are treated as pre-existing history. */
export const REPLAY_WINDOW_MIN = 50;
export const STORM_SPEEDS = [1, 2, 4] as const;

export const STORM_SCENARIOS = [
  { key: "db_connection_exhaustion", label: "Database failure" },
  { key: "auth_cascade_failure", label: "Auth outage" },
  { key: "disk_full_logging", label: "Disk full" },
  { key: "network_packet_loss", label: "Network degradation" },
  { key: "redis_memory_pressure", label: "Cache memory pressure" },
] as const;

/**
 * Maps each alert to the second of the replay at which it becomes visible.
 * Alerts older than the replay window are revealed immediately (they are the
 * pre-existing background), the rest are spread across the replay in their
 * real chronological order.
 */
export function buildSchedule(alerts: Alert[]): Map<string, number> {
  const schedule = new Map<string, number>();
  if (alerts.length === 0) return schedule;

  const sorted = [...alerts].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
  const newest = new Date(sorted[sorted.length - 1].timestamp).getTime();
  const cutoff = newest - REPLAY_WINDOW_MIN * 60 * 1000;

  const history: Alert[] = [];
  const recent: Alert[] = [];
  for (const a of sorted) {
    (new Date(a.timestamp).getTime() < cutoff ? history : recent).push(a);
  }

  const t0 = recent.length ? new Date(recent[0].timestamp).getTime() : newest;
  const span = Math.max(newest - t0, 1);

  history.forEach((a) => schedule.set(a.id, 0));

  let prev = 0;
  recent.forEach((a) => {
    let rt =
      ((new Date(a.timestamp).getTime() - t0) / span) * (STORM_SECONDS - 1) +
      0.5;
    // Keep a visible rhythm even when many alerts share a timestamp.
    rt = Math.max(rt, prev + 0.08);
    prev = rt;
    schedule.set(a.id, Math.min(rt, STORM_SECONDS));
  });

  return schedule;
}

/**
 * Projects the final pipeline state down to only the revealed alerts, so
 * clusters grow and risk climbs toward their real final values as the replay
 * runs. The engine's output is never altered — this only hides what hasn't
 * been "received" yet.
 */
export function projectStorm(
  full: PipelineState,
  revealed: Set<string>
): PipelineState {
  const clusters = [];

  for (const c of full.clusters) {
    const members = c.alerts.filter((a) => revealed.has(a.id));
    if (!members.length) continue;

    const frac = members.length / c.alerts.length;
    const score =
      Math.round(c.risk.score * Math.min(1, frac * 1.15) * 1000) / 1000;
    const level = score >= 0.66 ? "high" : score >= 0.33 ? "medium" : "low";

    clusters.push({
      ...c,
      alerts: members,
      size: members.length,
      raw_alert_count: members.reduce(
        (s, m) => s + (m.duplicate_count || 1),
        0
      ),
      risk: {
        ...c.risk,
        score,
        level,
        services_affected: new Set(members.map((m) => m.service)).size,
      },
      // The historical match only becomes meaningful once the full pattern
      // has arrived.
      dna_match: frac === 1 ? c.dna_match : null,
    });
  }

  clusters.sort((a, b) => b.risk.score - a.risk.score);

  const raw = full.raw_alerts.filter((a) => revealed.has(a.id));
  const noise = full.noise.filter((a) => revealed.has(a.id));
  const uniqueCount = noise.length + clusters.reduce((s, c) => s + c.size, 0);

  return {
    ...full,
    raw_alerts: raw,
    noise,
    clusters,
    dedup_stats: full.dedup_stats && {
      ...full.dedup_stats,
      raw_count: raw.length,
      unique_count: uniqueCount,
      reduction_pct: raw.length
        ? Math.round(1000 * (1 - uniqueCount / raw.length)) / 10
        : 0,
    },
  };
}

interface StormState {
  full: PipelineState | null;
  schedule: Map<string, number> | null;
  elapsed: number;
  speed: number;
  paused: boolean;
  scenario: string | null;
  /** Wall-clock ms at the last accepted tick. */
  lastTickAt: number | null;

  start: (full: PipelineState, scenario: string | null) => void;
  /** Advances by real elapsed time, so a slow frame rate makes the replay
   *  choppier rather than slower. */
  tick: () => void;
  setSpeed: (speed: number) => void;
  togglePause: () => void;
  stop: () => void;
}

export const useStormStore = create<StormState>((set, get) => ({
  full: null,
  schedule: null,
  elapsed: 0,
  speed: 1,
  paused: false,
  scenario: null,

  lastTickAt: null,

  start: (full, scenario) =>
    set({
      full,
      schedule: buildSchedule(full.raw_alerts),
      elapsed: 0,
      speed: 1,
      paused: false,
      scenario,
      lastTickAt: Date.now(),
    }),

  tick: () => {
    const { paused, speed, elapsed, full, lastTickAt } = get();
    if (!full) return;

    const now = Date.now();
    if (paused || lastTickAt === null) {
      set({ lastTickAt: now });
      return;
    }

    const next = elapsed + ((now - lastTickAt) / 1000) * speed;
    if (next >= STORM_SECONDS + 0.5) {
      // Replay finished — drop back to the real, complete pipeline state.
      set({
        full: null,
        schedule: null,
        elapsed: 0,
        scenario: null,
        lastTickAt: null,
      });
      return;
    }
    set({ elapsed: next, lastTickAt: now });
  },

  setSpeed: (speed) => set({ speed }),
  togglePause: () =>
    set((s) => ({ paused: !s.paused, lastTickAt: Date.now() })),
  stop: () =>
    set({
      full: null,
      schedule: null,
      elapsed: 0,
      scenario: null,
      paused: false,
      lastTickAt: null,
    }),
}));

/** Convenience selector: is a replay currently running? */
export const useIsStorming = () => useStormStore((s) => s.full !== null);
