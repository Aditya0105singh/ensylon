"use client";

import { useEffect, useRef } from "react";
import clsx from "clsx";
import { AnimatePresence, motion, useTransform } from "motion/react";
import { HiBackward, HiForward, HiPause, HiPlay, HiArrowPath } from "react-icons/hi2";
import { SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import { clockUTC } from "../_overview/lib";
import { LANES, SPEEDS, sinceOnset, type Playback, type Step } from "./model";

/** Space plays/pauses, arrows step, Home restarts - unless focus is in a form field. */
function useKeys(pb: Playback) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(el.tagName))) return;
      if (e.key === " ") { e.preventDefault(); pb.toggle(); }
      else if (e.key === "ArrowRight") { e.preventDefault(); pb.next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); pb.prev(); }
      else if (e.key === "Home") { e.preventDefault(); pb.restart(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pb]);
}

export function Swimlanes({ steps, span, t0, pb }: { steps: Step[]; span: number; t0: number; pb: Playback }) {
  useKeys(pb);
  const track = useRef<HTMLDivElement>(null);
  const x = (t: number) => (span > 0 ? (t / span) * 100 : 50);
  // 60 fps without re-rendering: these follow the playback motion value directly.
  const headLeft = useTransform(pb.time, (v) => `${x(v)}%`);
  const readout = useTransform(pb.time, (v) => `${clockUTC(new Date(t0 + v).toISOString())} UTC · ${sinceOnset(v)} since the first signal`);
  const cur = pb.index >= 0 ? steps[pb.index] : null;
  const counts = LANES.map((lane) => steps.filter((s, k) => s.lane === lane && k <= pb.index).length);

  const scrub = (clientX: number) => {
    const r = track.current?.getBoundingClientRect();
    if (!r || span <= 0) return;
    pb.seek(((clientX - r.left) / r.width) * span);
  };

  return (
    <section className="rounded-2xl border border-gray-100 bg-white p-4" aria-label="Replay timeline"
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -16px rgba(16,24,40,.14)" }}>
      {/* transport */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button onClick={pb.toggle} aria-label={pb.playing ? "Pause" : pb.done ? "Replay" : "Play"}
          className="inline-flex items-center gap-1.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-sm font-bold pl-3 pr-4 py-2 shadow-sm transition-colors">
          {pb.playing ? <HiPause /> : pb.done ? <HiArrowPath /> : <HiPlay />}
          {pb.playing ? "Pause" : pb.done ? "Replay" : "Play"}
        </button>
        <button onClick={pb.prev} disabled={pb.index <= 0} aria-label="Previous signal"
          className="rounded-xl border border-gray-200 bg-white p-2 text-gray-700 hover:bg-gray-50 disabled:opacity-40"><HiBackward /></button>
        <button onClick={pb.next} disabled={pb.index >= steps.length - 1} aria-label="Next signal"
          className="rounded-xl border border-gray-200 bg-white p-2 text-gray-700 hover:bg-gray-50 disabled:opacity-40"><HiForward /></button>
        <div className="flex rounded-xl border border-gray-200 p-0.5 text-xs font-bold" role="group" aria-label="Speed">
          {SPEEDS.map((s) => (
            <button key={s} onClick={() => pb.setSpeed(s)} aria-pressed={pb.speed === s}
              className={clsx("rounded-lg px-2.5 py-1 transition-colors", pb.speed === s ? "bg-gray-900 text-white" : "text-gray-600 hover:bg-gray-50")}>
              {s}×
            </button>
          ))}
        </div>
        <div className="ml-auto text-right">
          <div className="text-sm font-bold text-gray-900 tabular-nums">
            {pb.index + 1} <span className="text-gray-400 font-semibold">/ {steps.length} signals</span>
          </div>
          <motion.div className="text-[11px] text-gray-500 tabular-nums">{readout}</motion.div>
        </div>
      </div>

      {/* lanes */}
      <div className="grid grid-cols-[132px_1fr] gap-x-3">
        <div className="flex flex-col">
          {LANES.map((lane, i) => (
            <div key={lane} className="h-11 flex items-center gap-2 text-xs font-semibold text-gray-700">
              <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: SOURCE_COLOR[lane] }} />
              <span className="truncate">{SOURCE_NAME[lane]}</span>
              <span className="ml-auto tabular-nums text-gray-400">{counts[i]}</span>
            </div>
          ))}
        </div>
        <div
          ref={track}
          className="relative cursor-pointer select-none touch-none"
          onPointerDown={(e) => { (e.target as Element).setPointerCapture?.(e.pointerId); scrub(e.clientX); }}
          onPointerMove={(e) => { if (e.buttons === 1) scrub(e.clientX); }}
          role="slider" aria-label="Incident time" aria-valuemin={0} aria-valuemax={Math.round(span / 1000)}
          aria-valuenow={Math.round(pb.t / 1000)} aria-valuetext={sinceOnset(pb.t)} tabIndex={-1}
        >
          {LANES.map((lane) => (
            <div key={lane} className="h-11 relative">
              <div className="absolute inset-x-0 top-1/2 h-px bg-gray-200" />
            </div>
          ))}
          {/* elapsed shade */}
          <motion.div className="absolute inset-y-0 left-0 bg-green-50/70 rounded-l-md pointer-events-none" style={{ width: headLeft }} />
          {steps.map((s, k) => {
            const arrived = k <= pb.index;
            const isCur = k === pb.index;
            const lane = LANES.indexOf(s.lane);
            const size = Math.min(22, 12 + Math.log2(Math.max(1, s.occurrences)) * 3);
            return (
              <motion.button
                key={s.id}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => pb.seek(s.t)}
                title={`${clockUTC(s.at)} · ${s.service}${s.occurrences > 1 ? ` · ×${s.occurrences}` : ""}`}
                aria-label={`Signal ${k + 1}: ${s.service}`}
                className="absolute rounded-full"
                style={{ left: `${x(s.t)}%`, top: `${lane * 44 + 22}px`, width: size, height: size, x: "-50%", y: "-50%", background: SOURCE_COLOR[s.lane] }}
                initial={false}
                animate={{
                  scale: isCur ? 1.35 : arrived ? 1 : 0.55,
                  opacity: arrived ? 1 : 0.22,
                  boxShadow: isCur ? `0 0 0 4px #ffffff, 0 0 0 6px ${SOURCE_COLOR[s.lane]}` : "0 0 0 2px #ffffff",
                }}
                transition={{ type: "spring", stiffness: 420, damping: 22 }}
              >
                <AnimatePresence>
                  {isCur && (
                    <motion.span
                      key="ripple"
                      className="absolute inset-0 rounded-full pointer-events-none"
                      style={{ border: `2px solid ${SOURCE_COLOR[s.lane]}` }}
                      initial={{ scale: 1, opacity: 0.7 }}
                      animate={{ scale: 3, opacity: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.9, ease: "easeOut" }}
                    />
                  )}
                </AnimatePresence>
              </motion.button>
            );
          })}
          {/* playhead */}
          <motion.div className="absolute inset-y-0 pointer-events-none" style={{ left: headLeft }}>
            <div className="absolute -top-1 bottom-0 w-0.5 -translate-x-1/2 bg-gray-900/80 rounded-full" />
            <div className="absolute -top-2 w-2.5 h-2.5 -translate-x-1/2 rotate-45 bg-gray-900 rounded-[2px]" />
          </motion.div>
        </div>
      </div>
      <div className="grid grid-cols-[132px_1fr] gap-x-3 mt-1">
        <div />
        <div className="flex justify-between text-[10.5px] text-gray-500 tabular-nums">
          <span>{clockUTC(steps[0]?.at ?? new Date(t0).toISOString())}</span>
          <span className="text-gray-400">drag to scrub · space to play · ← → to step</span>
          <span>{sinceOnset(span)}</span>
        </div>
      </div>
      {cur && <span className="sr-only" aria-live={pb.playing ? "off" : "polite"}>Signal {pb.index + 1}: {cur.service}, {SOURCE_NAME[cur.lane]}</span>}
    </section>
  );
}
