"use client";

import { useEffect } from "react";
import clsx from "clsx";
import { AnimatePresence, motion, useSpring, useTransform } from "motion/react";
import { SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import { clockUTC } from "../_overview/lib";
import { LANES, sinceOnset, type Step } from "./model";

function Counter({ value }: { value: number }) {
  const spring = useSpring(value, { stiffness: 260, damping: 30 });
  const shown = useTransform(spring, (v) => Math.round(v).toLocaleString("en-US"));
  useEffect(() => { spring.set(value); }, [spring, value]);
  return <motion.span className="tabular-nums">{shown}</motion.span>;
}

/** What the engine knows at this moment of the replay - counts only. The
 * scores are computed on the whole incident, so they wait for the verdict. */
export function Vitals({ steps, index }: { steps: Step[]; index: number }) {
  const sofar = steps.slice(0, index + 1);
  const services = new Set(sofar.map((s) => s.service)).size;
  const streams = new Set(sofar.map((s) => s.lane));
  const raw = sofar.reduce((a, s) => a + Math.max(1, s.occurrences), 0);
  const items = [
    { label: "signals in", value: sofar.length },
    { label: "services", value: services },
    { label: "raw alerts absorbed", value: raw },
  ];
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      {items.map((it) => (
        <div key={it.label} className="rounded-xl border border-gray-100 bg-white px-3 py-2">
          <div className="text-2xl font-extrabold text-gray-900 leading-tight"><Counter value={it.value} /></div>
          <div className="text-[11px] text-gray-500">{it.label}</div>
        </div>
      ))}
      <div className="rounded-xl border border-gray-100 bg-white px-3 py-2">
        <div className="flex items-center gap-1.5 h-8">
          {LANES.map((lane) => (
            <motion.span key={lane} title={SOURCE_NAME[lane]} className="w-5 h-5 rounded-full"
              initial={false}
              animate={{ scale: streams.has(lane) ? 1 : 0.7, opacity: streams.has(lane) ? 1 : 0.2 }}
              transition={{ type: "spring", stiffness: 400, damping: 20 }}
              style={{ background: SOURCE_COLOR[lane] }} />
          ))}
        </div>
        <div className="text-[11px] text-gray-500">{streams.size} of 3 streams agree</div>
      </div>
    </div>
  );
}

/** Every signal so far, newest on top, sliding in as it lands. */
export function EvidenceTape({ steps, index, onSeek }: { steps: Step[]; index: number; onSeek: (t: number) => void }) {
  const sofar = steps.slice(0, index + 1).reverse();
  return (
    <ol className="flex flex-col gap-1 max-h-[340px] overflow-y-auto pr-1" aria-label="Signals so far">
      <AnimatePresence initial={false}>
        {sofar.map((s) => {
          const isCur = s === steps[index];
          return (
            <motion.li key={s.id} layout initial={{ opacity: 0, x: -16, height: 0 }} animate={{ opacity: 1, x: 0, height: "auto" }}
              exit={{ opacity: 0, height: 0 }} transition={{ type: "spring", stiffness: 380, damping: 32 }}>
              <button type="button" onClick={() => onSeek(s.t)}
                className={clsx("w-full text-left flex gap-2 rounded-lg px-2 py-1.5 transition-colors",
                  isCur ? "bg-green-50 ring-1 ring-green-200" : "hover:bg-gray-50")}>
                <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: SOURCE_COLOR[s.lane] }} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2 text-[11px]">
                    <span className="font-mono text-gray-500 w-[4.5rem] shrink-0 whitespace-nowrap">{s === steps[0] ? clockUTC(s.at).slice(0, 8) : sinceOnset(s.t)}</span>
                    <span className="font-bold text-gray-900 truncate">{s.service}</span>
                    {s.occurrences > 1 && <span className="font-mono text-gray-500">×{s.occurrences}</span>}
                    <span className="ml-auto text-gray-400 shrink-0">{s === steps[0] ? "opened" : s.join.gate ?? "no gate"}</span>
                  </span>
                  <span className="block text-[11px] text-gray-700 truncate" title={s.message}>{s.message}</span>
                </span>
              </button>
            </motion.li>
          );
        })}
      </AnimatePresence>
    </ol>
  );
}
