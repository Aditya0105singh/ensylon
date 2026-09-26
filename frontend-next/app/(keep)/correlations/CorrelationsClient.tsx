"use client";

import { useState } from "react";
import clsx from "clsx";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { TbChartDots3 } from "react-icons/tb";
import { HiChevronDown, HiOutlineShieldExclamation } from "react-icons/hi2";
import { PageHero } from "@/shared/ui";
import { useValidationRejections } from "@/entities/engine/useEngine";
import { DIM_COLOR, clockUTC } from "../_overview/lib";
import { FormulaPlayground } from "./FormulaPlayground";
import { IncidentExplorer } from "./IncidentExplorer";
import { AblationPanel, CalibrationPanel } from "./ProofPanels";
import { CHECKS, DIMS, GATES, STREAMING } from "./rules";

function Rule({ n, title, children, open, onToggle }: { n: string; title: string; children: React.ReactNode; open: boolean; onToggle: () => void }) {
  return (
    <li className="rounded-xl border border-gray-100 bg-white">
      <button onClick={onToggle} aria-expanded={open} className="w-full flex items-center gap-3 px-4 py-3 text-left">
        <span className="w-6 h-6 rounded-full bg-gray-900 text-white text-[11px] font-bold flex items-center justify-center shrink-0">{n}</span>
        <span className="text-sm font-bold text-gray-900">{title}</span>
        <HiChevronDown className={clsx("ml-auto text-gray-400 transition-transform", open && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="px-4 pb-4 pl-[3.25rem] text-xs text-gray-800">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

/** The rules, in the order the engine applies them. */
function Rules() {
  const [open, setOpen] = useState<Set<string>>(new Set(["gate"]));
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  return (
    <section aria-label="The rules">
      <div className="flex items-baseline justify-between mb-2">
        <h2 className="text-sm font-bold text-gray-900">The rules, in the order the engine applies them</h2>
        <button onClick={() => setOpen(open.size ? new Set() : new Set(["gate", "sim", "causal", "valid", "stream", "scores"]))}
          className="text-xs font-semibold text-green-700 hover:underline">{open.size ? "Collapse all" : "Expand all"}</button>
      </div>
      <ol className="flex flex-col gap-2">
        <Rule n="1" title="Structural gate: must pass before any score is computed" open={open.has("gate")} onToggle={() => toggle("gate")}>
          <p className="mb-2">A pair is scored only if one of these holds. Pairs that fail are never linked, however close in time.</p>
          <ul className="space-y-1">
            {GATES.map((g) => (
              <li key={g.name} className="flex gap-2">
                <span className="mt-1.5 w-4 h-0.5 rounded shrink-0" style={{ background: g.color }} />
                <span><b>{g.name}</b>: {g.rule}{!g.fromStreams && <span className="text-gray-500"> (needs trace data; the three streams carry none)</span>}</span>
              </li>
            ))}
          </ul>
        </Rule>
        <Rule n="2" title="Similarity: five weighted dimensions, merge at 0.45" open={open.has("sim")} onToggle={() => toggle("sim")}>
          <table className="w-full">
            <thead className="text-gray-500 text-left"><tr><th className="py-1">dimension</th><th>weight</th><th>computed as</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {DIMS.map((d) => (
                <tr key={d.key}>
                  <td className="py-1 font-semibold whitespace-nowrap"><span className="font-mono" style={{ color: DIM_COLOR[d.key] }}>{d.code}</span> {d.name}</td>
                  <td className="font-mono">{d.weight.toFixed(2)}</td>
                  <td className="text-gray-700">{d.how}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2">DBSCAN on distance 1 − sim (eps 0.55, min_samples 2). Window: 15 minutes. Time can contribute at most 0.36, below the 0.45 line.</p>
        </Rule>
        <Rule n="3" title="Causal refinement" open={open.has("causal")} onToggle={() => toggle("causal")}>
          Within each cluster, counterfactual root-cause analysis over the dependency graph finds the services nothing else in the cluster explains.
          Two such roots are split into two incidents unless their evidence agrees (shared template, same component, or one names the other).
          A true cascade keeps a single root and stays whole.
        </Rule>
        <Rule n="4" title={`Validation (C4): a candidate must pass all ${CHECKS.length}`} open={open.has("valid")} onToggle={() => toggle("valid")}>
          <ul className="space-y-1">{CHECKS.map((c) => <li key={c.name}><b>{c.name}</b>: {c.rule}</li>)}</ul>
          <p className="mt-2 text-gray-600">A failing candidate is not raised; its signals stay pending and expire as noise if nothing joins them.</p>
        </Rule>
        <Rule n="5" title="While the streams keep arriving" open={open.has("stream")} onToggle={() => toggle("stream")}>
          <ul className="space-y-1">{STREAMING.map((s) => <li key={s.name}><b>{s.name}</b>: {s.rule}</li>)}</ul>
        </Rule>
        <Rule n="6" title="The two scores: impact and confidence, never blended" open={open.has("scores")} onToggle={() => toggle("scores")}>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div>
              <div className="font-mono bg-gray-50 rounded-lg p-2 mb-1.5">impact = 100 × (0.40·blast + 0.35·criticality + 0.25·magnitude)</div>
              <ul className="space-y-0.5">
                <li><b>blast</b> = 0.7·min(services/5, 1) + 0.3·min(further dependents of the root/5, 1)</li>
                <li><b>criticality</b> = highest among the involved services (the brief&apos;s map; unknown = 50)</li>
                <li><b>magnitude</b> = strongest anomaly_score in the incident</li>
                <li>P1 ≥ 75 · P2 ≥ 50 · P3 ≥ 25 · P4 below</li>
              </ul>
            </div>
            <div>
              <div className="font-mono bg-gray-50 rounded-lg p-2 mb-1.5">confidence = 0.40·density + 0.35·topology + 0.25·evidence</div>
              <ul className="space-y-0.5">
                <li><b>density</b>: share of signal pairs that pass the gate and score ≥ 0.45</li>
                <li><b>topology</b>: share of service pairs within 2 hops on the reference graph</li>
                <li><b>evidence</b>: mean over signals of the best evidence or component agreement with another member</li>
              </ul>
            </div>
          </div>
        </Rule>
      </ol>
    </section>
  );
}

function Rejections() {
  const { data } = useValidationRejections();
  const rows = [...(data ?? [])].reverse().slice(0, 8);
  return (
    <section aria-label="Refused by validation" className="rounded-2xl border border-gray-100 bg-white p-4">
      <h2 className="flex items-center gap-1.5 text-sm font-bold text-gray-900">
        <HiOutlineShieldExclamation className="text-amber-600" /> Refused by validation, live
      </h2>
      <p className="text-[11px] text-gray-500 mb-2">Candidates the engine would not raise, newest first, with the check that stopped them.</p>
      {!data ? <p className="text-xs text-gray-600">Live streams not running.</p>
        : rows.length === 0 ? <p className="text-xs text-gray-600">None so far.</p>
        : (
          <ul className="flex flex-col gap-1.5 text-xs text-gray-800">
            {rows.map((r, i) => (
              <li key={`${r.at}-${i}`} className="flex gap-2">
                <span className="font-mono text-gray-500 shrink-0">{clockUTC(r.at)}</span>
                <span><b>{r.services.join(" + ")}</b> ({r.signals} signal{r.signals === 1 ? "" : "s"}): {r.failed.map((f) => `${f.name}: ${f.detail}`).join("; ")}</span>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

export function CorrelationsClient() {
  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-4 p-4">
        <PageHero
          icon={TbChartDots3}
          title="Correlation & validation"
          subtitle="How separate alerts become one incident, shown on the live streams and measured on the benchmark. Time alone never links two signals."
        />
        <FormulaPlayground />
        <IncidentExplorer />
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 items-start">
          <AblationPanel />
          <CalibrationPanel />
        </div>
        <Rules />
        <Rejections />
      </div>
    </MotionConfig>
  );
}
