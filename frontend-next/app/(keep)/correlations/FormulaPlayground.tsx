"use client";

import { useState } from "react";
import clsx from "clsx";
import { motion } from "motion/react";
import { HiCheckCircle, HiXCircle } from "react-icons/hi2";
import { DIM_COLOR } from "../_overview/lib";
import { DIMS, MERGE } from "./rules";

type Values = Record<(typeof DIMS)[number]["key"], number>;

const PRESETS: { label: string; gate: boolean; values: Values; says: string }[] = [
  {
    label: "Same instant, unrelated services",
    gate: false,
    values: { time_proximity: 1, service_affinity: 0, dependency_closeness: 0, template_similarity: 0.05, component_match: 0 },
    says: "Fails the gate, and would score 0.26 anyway: even perfect timing is worth only 0.25. Time alone cannot link two signals.",
  },
  {
    label: "Same service, 3 min apart",
    gate: true,
    values: { time_proximity: 0.47, service_affinity: 0.85, dependency_closeness: 1, template_similarity: 0.2, component_match: 0 },
    says: "The common case: same service, different messages a few minutes apart. Clears the line.",
  },
  {
    label: "Caller and callee, 1 min apart",
    gate: true,
    values: { time_proximity: 0.78, service_affinity: 0, dependency_closeness: 0.75, template_similarity: 0.1, component_match: 0 },
    says: "A cascade: one hop on the graph and close in time. Clears the line through topology, not timing.",
  },
  {
    label: "Neighbours, 12 min apart",
    gate: true,
    values: { time_proximity: 0.05, service_affinity: 0, dependency_closeness: 0.75, template_similarity: 0.05, component_match: 0 },
    says: "Structurally related but too far apart and saying different things: stays two separate problems.",
  },
];

/** The similarity formula as something to push on: five weighted terms that
 * must add up past the merge line, and only after the gate has been passed. */
export function FormulaPlayground() {
  const [preset, setPreset] = useState(0);
  const [values, setValues] = useState<Values>(PRESETS[0].values);
  const [gate, setGate] = useState(PRESETS[0].gate);
  const [custom, setCustom] = useState(false);

  const parts = DIMS.map((d) => ({ ...d, v: values[d.key], c: d.weight * values[d.key] }));
  const total = parts.reduce((a, p) => a + p.c, 0);
  const merges = gate && total >= MERGE;

  const pick = (i: number) => { setPreset(i); setValues(PRESETS[i].values); setGate(PRESETS[i].gate); setCustom(false); };

  return (
    <section aria-label="Similarity formula" className="rounded-2xl border border-gray-100 bg-white p-5"
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 12px 32px -20px rgba(16,24,40,.18)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-900">When do two signals belong to one incident?</h2>
        <span className="text-[11px] text-gray-500">C3 · correlate.py</span>
      </div>

      {/* the equation */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 font-mono text-sm" aria-label="sim = 0.25·T + 0.20·S + 0.20·D + 0.20·E + 0.15·C, merge at 0.34">
        <span className="font-bold text-gray-900">sim</span><span className="text-gray-400">=</span>
        {DIMS.map((d, i) => (
          <span key={d.key} className="inline-flex items-center gap-1.5">
            {i > 0 && <span className="text-gray-400">+</span>}
            <span className="group relative rounded-lg px-2 py-1 font-bold text-white cursor-help" style={{ background: DIM_COLOR[d.key] }}
              tabIndex={0} aria-describedby={`dim-${d.code}`}>
              {d.weight.toFixed(2)}·{d.code}
              <span id={`dim-${d.code}`} role="tooltip"
                className="pointer-events-none absolute left-0 top-full z-20 mt-1.5 w-64 rounded-lg bg-gray-900 px-2.5 py-2 font-sans text-[11px] font-normal text-white opacity-0 shadow-lg transition-opacity group-hover:opacity-100 group-focus:opacity-100">
                <b>{d.name}</b>: {d.how}
              </span>
            </span>
          </span>
        ))}
        <span className="text-gray-400 ml-1">≥</span><span className="rounded-lg border-2 border-gray-900 px-2 py-0.5 font-bold">{MERGE}</span>
      </div>
      <p className="mt-2 text-xs text-gray-600">
        Scored only after the pair passes the <b>structural gate</b>. DBSCAN on distance 1 − sim (eps 0.66, min_samples 2) groups
        pairs over the line. Tuned on seeds 1–20, reported on held-out seeds 21–40.
      </p>

      {/* try it */}
      <div className="mt-4 rounded-xl border border-gray-100 bg-gray-50/70 p-3">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Examples">
          <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mr-1">Try it</span>
          {PRESETS.map((p, i) => (
            <button key={p.label} onClick={() => pick(i)} aria-pressed={!custom && preset === i}
              className={clsx("rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                !custom && preset === i ? "bg-gray-900 text-white border-gray-900" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="mt-3 grid grid-cols-1 lg:grid-cols-[1fr_1.1fr] gap-4">
          <div className="flex flex-col gap-2">
            {parts.map((p) => (
              <label key={p.key} className="grid grid-cols-[120px_1fr_40px] items-center gap-2 text-xs">
                <span className="text-gray-700"><b className="font-mono" style={{ color: DIM_COLOR[p.key] }}>{p.code}</b> {p.name}</span>
                <input type="range" min={0} max={1} step={0.05} value={p.v} aria-label={p.name}
                  onChange={(e) => { setValues({ ...values, [p.key]: Number(e.target.value) }); setCustom(true); }}
                  style={{ accentColor: DIM_COLOR[p.key] }} />
                <span className="font-mono text-right text-gray-900">{p.v.toFixed(2)}</span>
              </label>
            ))}
            <label className="flex items-center gap-2 text-xs text-gray-800 mt-1">
              <input type="checkbox" checked={gate} onChange={(e) => { setGate(e.target.checked); setCustom(true); }} className="accent-green-700" />
              passes the structural gate (shares a service, a dependency edge, a named service or a component)
            </label>
          </div>

          <div className="flex flex-col justify-center gap-2">
            <div className="relative pt-5">
              <div className="flex h-7 w-full overflow-hidden rounded-lg bg-gray-200" role="img" aria-label={`similarity ${total.toFixed(2)}`}>
                {parts.map((p) => (
                  <motion.div key={p.key} className="h-full" style={{ background: DIM_COLOR[p.key] }}
                    animate={{ width: `${p.c * 100}%` }} transition={{ type: "spring", stiffness: 260, damping: 30 }} />
                ))}
              </div>
              <div className="absolute top-3 bottom-0 w-0.5 bg-gray-900" style={{ left: `${MERGE * 100}%` }} />
              <div className="absolute top-0 -translate-x-1/2 text-[10px] font-bold text-gray-800" style={{ left: `${MERGE * 100}%` }}>merge {MERGE}</div>
            </div>
            <div className={clsx("flex items-start gap-2 rounded-xl px-3 py-2 text-sm", merges ? "bg-green-50 text-green-900" : "bg-red-50 text-red-900")}
              role="status" aria-label="Verdict">
              {merges ? <HiCheckCircle className="mt-0.5 shrink-0" /> : <HiXCircle className="mt-0.5 shrink-0" />}
              <span>
                <b className="font-mono">sim {total.toFixed(2)}</b>{" "}
                {!gate ? "- but the pair fails the gate, so it is never scored or linked." : merges ? "- over the line: same incident." : "- under the line: kept apart."}
                {!custom && <span className="block text-xs mt-0.5 opacity-90">{PRESETS[preset].says}</span>}
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
