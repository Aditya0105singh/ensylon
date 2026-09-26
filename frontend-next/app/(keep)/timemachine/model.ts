import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMotionValue, type MotionValue } from "motion/react";
import type { Evidence, EvidenceSignal } from "@/entities/engine/types";
import { canonicalSource, type CanonicalSource } from "../_overview/lib";

export const LANES: CanonicalSource[] = ["application_logs", "cloudwatch_metrics", "grafana_alerts"];

export type Step = EvidenceSignal & { t: number; lane: CanonicalSource };

/** The incident's signals in arrival order, each with its offset (ms) from the first. */
export function buildSteps(ev: Evidence): { steps: Step[]; span: number; t0: number } {
  const sorted = [...ev.signals].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const t0 = sorted.length ? Date.parse(sorted[0].at) : 0;
  const steps = sorted.map((s) => ({ ...s, t: Date.parse(s.at) - t0, lane: canonicalSource(s.source) }));
  return { steps, span: steps.length ? steps[steps.length - 1].t : 0, t0 };
}

/** Index of the last signal that has arrived by incident time t (-1: none yet). */
export function arrivedIndex(steps: Step[], t: number): number {
  let lo = 0, hi = steps.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (steps[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/** "+1m 05s" from the incident's first signal. */
export function sinceOnset(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `+${s}s` : `+${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export const SPEEDS = [1, 2, 4] as const;

/**
 * A clock over incident time. At 1x the whole incident plays in 8-24 s (about
 * a second per signal), but signals keep their real spacing: a burst still
 * arrives as a burst, a lull still reads as a lull.
 *
 * The continuous time lives in a motion value (`time`) that only the playhead
 * and the clock readout subscribe to, so they move at 60 fps without
 * re-rendering the page. React state (`t`) changes only when a new signal
 * lands, playback stops, or the user seeks.
 */
export function usePlayback(steps: Step[], span: number, key: string) {
  const [t, setTState] = useState(0);
  const tRef = useRef(0);
  const time: MotionValue<number> = useMotionValue(0);
  const setT = useCallback((v: number) => { tRef.current = v; time.set(v); setTState(v); }, [time]);
  /** Per frame: move the motion value; touch React state only on a new arrival. */
  const advance = useCallback((v: number) => {
    const before = arrivedIndex(steps, tRef.current);
    tRef.current = v;
    time.set(v);
    if (arrivedIndex(steps, v) !== before || v >= span) setTState(v);
  }, [steps, span, time]);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const duration = Math.min(24000, Math.max(8000, steps.length * 900));
  const rate = span > 0 ? span / duration : 0;          // incident ms per real ms
  const last = useRef<number | null>(null);

  // A new incident starts from its first signal and plays on its own.
  useEffect(() => {
    setT(0);
    setPlaying(steps.length > 1 && span > 0);
  }, [key, steps.length, span, setT]);

  useEffect(() => {
    if (!playing) { last.current = null; return; }
    let raf = 0;
    const tick = (now: number) => {
      const dt = last.current == null ? 0 : now - last.current;
      last.current = now;
      const next = Math.min(span, tRef.current + dt * rate * speed);
      advance(next);
      if (next >= span) { setPlaying(false); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, rate, speed, span, advance]);

  const index = arrivedIndex(steps, t);
  const done = steps.length > 0 && t >= span;

  const seek = useCallback((to: number) => { setPlaying(false); setT(Math.max(0, Math.min(span, to))); }, [span, setT]);
  const next = useCallback(() => {
    const k = arrivedIndex(steps, tRef.current);
    if (k < steps.length - 1) seek(steps[k + 1].t);
  }, [steps, seek]);
  const prev = useCallback(() => {
    const k = arrivedIndex(steps, tRef.current);
    if (k <= 0) return;
    // previous distinct moment: signals that share a timestamp arrive together
    const before = arrivedIndex(steps, steps[k].t - 1);
    if (before >= 0) seek(steps[before].t);
  }, [steps, seek]);
  const toggle = useCallback(() => {
    if (done) { setT(0); setPlaying(true); return; }
    setPlaying((p) => !p);
  }, [done, setT]);
  const restart = useCallback(() => { setT(0); setPlaying(true); }, [setT]);

  return useMemo(
    () => ({ t, time, index, done, playing, speed, setSpeed, seek, next, prev, toggle, restart }),
    [t, time, index, done, playing, speed, seek, next, prev, toggle, restart]
  );
}

export type Playback = ReturnType<typeof usePlayback>;
