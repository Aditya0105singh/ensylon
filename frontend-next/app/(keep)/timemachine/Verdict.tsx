"use client";

import Link from "next/link";
import clsx from "clsx";
import { motion } from "motion/react";
import { HiArrowRight, HiOutlineLockClosed, HiOutlineLightBulb } from "react-icons/hi2";
import type { Evidence } from "@/entities/engine/types";
import { PRIORITY_COLOR } from "@/entities/engine/charts";
import { clockUTC } from "../_overview/lib";
import { Gauge } from "../_overview/Gauge";
import type { Step } from "./model";

const pct = (v: number) => Math.round(v <= 1 ? v * 100 : v);

const reveal = {
  hidden: { opacity: 0, y: 10 },
  show: (i: number) => ({ opacity: 1, y: 0, transition: { delay: 0.15 + i * 0.12, duration: 0.35 } }),
};

/**
 * Locked until the last signal is in: the engine ranks root causes on the
 * complete incident, never on a partial one, so the replay does too.
 */
export function Verdict({ ev, steps, index, done, onSkip, priority }: {
  ev: Evidence; steps: Step[]; index: number; done: boolean; onSkip: () => void; priority: string;
}) {
  const color = PRIORITY_COLOR[priority] ?? "#dc2626";
  if (!done) {
    const progress = steps.length ? (index + 1) / steps.length : 0;
    return (
      <div className="flex flex-col items-center justify-center text-center gap-3 py-8">
        <div className="relative w-16 h-16">
          <svg viewBox="0 0 36 36" className="w-16 h-16 -rotate-90" aria-hidden>
            <circle cx="18" cy="18" r="15.5" fill="none" stroke="#e5e7eb" strokeWidth="3" />
            <motion.circle cx="18" cy="18" r="15.5" fill="none" stroke="#16a34a" strokeWidth="3" strokeLinecap="round"
              pathLength={1} initial={false} animate={{ pathLength: progress }} transition={{ duration: 0.3 }} />
          </svg>
          <HiOutlineLockClosed className="absolute inset-0 m-auto w-6 h-6 text-gray-500" />
        </div>
        <div>
          <div className="text-sm font-bold text-gray-900">The verdict waits for the last signal</div>
          <p className="text-xs text-gray-600 max-w-sm">Root cause is ranked on the complete incident, never a partial one. {index + 1} of {steps.length} signals are in.</p>
        </div>
        <button onClick={onSkip} className="text-xs font-semibold text-green-700 hover:underline">Skip to the verdict →</button>
      </div>
    );
  }

  const rc = ev.root_cause;
  const cands = [...rc.candidates].sort((a, b) => b.rank_score - a.rank_score).slice(0, 4);
  const maxScore = Math.max(0.01, ...cands.map((c) => c.rank_score));
  const first = steps[0];
  const firstCand = rc.candidates.find((c) => c.service === first?.service);
  const twist = rc.service && first && first.service !== rc.service;

  return (
    <motion.div initial="hidden" animate="show" className="flex flex-col gap-4">
      <motion.div custom={0} variants={reveal}>
        <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Probable origin</div>
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-extrabold" style={{ color }}>{rc.service ?? "undetermined"}</span>
          {rc.service && <span className="text-sm text-gray-700"><b>{pct(rc.confidence)}%</b> causal confidence · inferred, not proven</span>}
        </div>
      </motion.div>

      {twist && (
        <motion.div custom={1} variants={reveal} className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
          <HiOutlineLightBulb className="mt-0.5 shrink-0 w-4 h-4" />
          <span>
            <b>{first.service}</b> complained first, at {clockUTC(first.at)}, but it is not the cause.
            {firstCand?.symptom_of.length
              ? <> It depends on <b>{firstCand.symptom_of.join(", ")}</b>, and its failures are explained as a symptom of {rc.service}.</>
              : <> The ranking and the counterfactual test point to <b>{rc.service}</b>.</>}
            {" "}The first alarm is often just the loudest one.
          </span>
        </motion.div>
      )}

      <motion.div custom={2} variants={reveal}>
        <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">How the candidates ranked</div>
        <ul className="flex flex-col gap-2">
          {cands.map((c, i) => {
            const isRoot = c.service === rc.service;
            const ruledOut = rc.rejected_by_counterfactual.includes(c.service) || !c.survived_counterfactual;
            return (
              <li key={c.service}>
                <div className="flex items-center gap-2 text-xs">
                  <span className={clsx("font-bold truncate", isRoot ? "text-gray-900" : "text-gray-700")}>{c.service}</span>
                  {isRoot && <span className="rounded-full px-1.5 text-[10px] font-bold text-white" style={{ background: color }}>origin</span>}
                  {!isRoot && c.is_symptom && c.symptom_of.length > 0 && (
                    <span className="rounded-full bg-gray-100 px-1.5 text-[10px] font-semibold text-gray-700">symptom of {c.symptom_of.join(", ")}</span>
                  )}
                  {!isRoot && ruledOut && (
                    <span className="rounded-full bg-gray-100 px-1.5 text-[10px] font-semibold text-gray-600">ruled out by counterfactual</span>
                  )}
                  <span className="ml-auto font-mono font-bold text-gray-900">{c.rank_score.toFixed(2)}</span>
                </div>
                <div className="mt-1 h-2 rounded-full bg-gray-100 overflow-hidden">
                  <motion.div className="h-full rounded-full" style={{ background: isRoot ? color : "#94a3b8" }}
                    initial={{ width: 0 }} animate={{ width: `${(c.rank_score / maxScore) * 100}%` }}
                    transition={{ delay: 0.4 + i * 0.12, duration: 0.6, ease: "easeOut" }} />
                </div>
                <div className="text-[10.5px] text-gray-500 mt-0.5">
                  precedence {c.temporal_precedence.toFixed(2)} · dependency reach {c.dependency_reach.toFixed(2)} · evidence {c.evidence_strength.toFixed(2)} · {c.signal_count} signal{c.signal_count === 1 ? "" : "s"}
                </div>
              </li>
            );
          })}
        </ul>
        {rc.reasoning[1] && <p className="mt-2 text-[11px] text-gray-600">{rc.reasoning[1]}</p>}
      </motion.div>

      <motion.div custom={3} variants={reveal} className="grid grid-cols-2 gap-2 rounded-xl border border-gray-100 bg-gray-50/70 p-2">
        <Gauge fraction={ev.severity.score <= 1 ? ev.severity.score : ev.severity.score / 100} display={String(pct(ev.severity.score))}
          label="Impact · 0–100" color={color} caption={`${ev.severity.priority}`} />
        <Gauge fraction={ev.correlation.confidence.final} display={ev.correlation.confidence.final.toFixed(2)}
          label="Confidence · 0–1" color="#2563eb" caption="scored separately" />
      </motion.div>

      <motion.div custom={4} variants={reveal}>
        <Link href={`/review/${ev.draft_id}`}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-sm font-bold px-4 py-2.5 transition-colors">
          Review this incident <HiArrowRight />
        </Link>
      </motion.div>
    </motion.div>
  );
}
