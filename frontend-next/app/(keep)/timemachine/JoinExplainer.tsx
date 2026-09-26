"use client";

import { AnimatePresence, motion } from "motion/react";
import { HiOutlineLink, HiOutlineSparkles, HiOutlineXCircle } from "react-icons/hi2";
import type { Evidence } from "@/entities/engine/types";
import { SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import { DIM_COLOR, DIMENSIONS, MERGE_THRESHOLD, clockUTC } from "../_overview/lib";
import { sinceOnset, type Step } from "./model";

const FALLBACK_W: Record<string, number> = {
  time_proximity: 0.25, service_affinity: 0.2, dependency_closeness: 0.2, template_similarity: 0.2, component_match: 0.15,
};

/** One signal: what it said, why it was flagged, and - the core question -
 * which structural evidence let it into the incident, and by how much it
 * cleared the merge threshold. */
export function JoinExplainer({ step, first, ev }: { step: Step | null; first: boolean; ev: Evidence }) {
  if (!step) return null;
  const j = step.join;
  const weights = ev.correlation.weights ?? {};
  const parts = DIMENSIONS.map((d) => {
    const w = Number(weights[d.key] ?? FALLBACK_W[d.key] ?? 0);
    const v = Number((j.components as Record<string, number> | null)?.[d.key] ?? 0);
    return { ...d, w, v, c: w * v };
  });
  const total = j.components?.total ?? parts.reduce((a, p) => a + p.c, 0);

  return (
    <AnimatePresence mode="wait">
      <motion.div key={step.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.22 }} className="flex flex-col gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap text-[11px]">
            <span className="rounded px-1.5 py-0.5 font-semibold text-white" style={{ background: SOURCE_COLOR[step.lane] }}>
              {SOURCE_NAME[step.lane]}
            </span>
            <span className="font-mono text-gray-500">{clockUTC(step.at)} UTC · {sinceOnset(step.t)}</span>
            {step.occurrences > 1 && <span className="rounded-full bg-gray-100 px-1.5 font-mono font-bold text-gray-700">×{step.occurrences}</span>}
          </div>
          <div className="mt-1 text-base font-extrabold text-gray-900">{step.service}</div>
          <p className="text-sm text-gray-800 break-words">{step.message}</p>
          {step.detection_reason && (
            <p className="mt-1 text-[11px] text-gray-600"><b className="text-gray-800">Flagged because</b> {step.detection_reason}</p>
          )}
        </div>

        {first ? (
          <div className="flex gap-2 rounded-xl border border-green-200 bg-green-50 p-3 text-xs text-green-900">
            <HiOutlineSparkles className="mt-0.5 shrink-0" />
            <span><b>Opens the candidate incident.</b> Nothing to join yet: every later signal must link to this group through a structural gate and clear the merge threshold.</span>
          </div>
        ) : j.joined ? (
          <div className="rounded-xl border border-gray-100 bg-gray-50/70 p-3">
            <div className="flex items-center gap-1.5 text-xs text-gray-800">
              <HiOutlineLink className="text-green-700 shrink-0" />
              <span>
                Passed the gate: <b className="text-green-800">{j.gate}</b>
                {j.linked_to && <> with <b>{j.linked_to}</b></>}
              </span>
            </div>

            {/* the weighted dimensions, stacked against the merge threshold */}
            <div className="mt-6 relative">
              <div className="flex h-5 w-full overflow-hidden rounded-md bg-gray-200" aria-label={`similarity ${total.toFixed(2)}`}>
                {parts.map((p, i) => (
                  <motion.div key={p.key} className="h-full" style={{ background: DIM_COLOR[p.key] }}
                    initial={{ width: 0 }} animate={{ width: `${p.c * 100}%` }}
                    transition={{ duration: 0.45, delay: i * 0.07, ease: "easeOut" }}
                    title={`${p.label}: ${p.v.toFixed(2)} × ${p.w} = ${p.c.toFixed(2)}`} />
                ))}
              </div>
              <div className="absolute -top-1 -bottom-1 w-0.5 bg-gray-900" style={{ left: `${MERGE_THRESHOLD * 100}%` }} aria-hidden />
              <div className="absolute -top-5 -translate-x-1/2 text-[10px] font-bold text-gray-700 whitespace-nowrap"
                style={{ left: `${MERGE_THRESHOLD * 100}%` }}>merge ≥ {MERGE_THRESHOLD}</div>
            </div>
            <div className="mt-1.5 flex items-baseline justify-between text-xs">
              <span className="text-gray-600">similarity</span>
              <span className="font-mono">
                <b className="text-base text-gray-900">{total.toFixed(2)}</b>{" "}
                <span className="text-green-700 font-bold">{total >= MERGE_THRESHOLD ? `cleared by +${(total - MERGE_THRESHOLD).toFixed(2)}` : "below the threshold"}</span>
              </span>
            </div>
            <ul className="mt-2 flex flex-col gap-0.5 text-[11px]">
              {parts.map((p) => (
                <li key={p.key} className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: DIM_COLOR[p.key] }} />
                  <span className="text-gray-700 truncate"><b className="font-mono text-gray-500">{p.code}</b> {p.label}</span>
                  <span className="ml-auto font-mono text-gray-500">{p.v.toFixed(2)}×{p.w}</span>
                  <span className="font-mono font-bold text-gray-900 w-9 text-right">{p.c.toFixed(2)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900">
            <HiOutlineXCircle className="mt-0.5 shrink-0" />
            <span><b>No structural link.</b> It arrived close in time but passed no gate, and time alone never links two signals.</span>
          </div>
        )}
      </motion.div>
    </AnimatePresence>
  );
}
