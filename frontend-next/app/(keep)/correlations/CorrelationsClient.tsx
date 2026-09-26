"use client";

import { useState } from "react";
import clsx from "clsx";
import { TbChartDots3 } from "react-icons/tb";
import { HiOutlineExclamationTriangle } from "react-icons/hi2";
import { PageHero } from "@/shared/ui";
import {
  useEngineAblation,
  useEngineEvidence,
  useEngineQueue,
  useEngineReliability,
  useValidationRejections,
} from "@/entities/engine/useEngine";
import { clockUTC } from "../_overview/lib";

// Mirrors backend/app/engine/correlate.py, validate.py and severity.py. If a
// constant changes there, change it here: this page is the written spec.
const DIMENSIONS = [
  { key: "T", name: "Time proximity", weight: 0.25, calc: "exp(-Δt / 4 min); 0 beyond the 15 min window" },
  { key: "S", name: "Service affinity", weight: 0.2, calc: "1.0 same service + component, 0.85 same service" },
  { key: "D", name: "Dependency closeness", weight: 0.2, calc: "hops on the reference graph: 0→1.0, 1→0.75, 2→0.45, 3→0.15" },
  { key: "E", name: "Evidence similarity", weight: 0.2, calc: "same Drain3 template = 1.0, else token Jaccard on redacted text" },
  { key: "C", name: "Component match", weight: 0.15, calc: "1.0 when both signals report the same component" },
];

const GATES = [
  "same service",
  "direct or 2-hop dependency edge on the reference graph",
  "the service is named in the other signal's evidence (e.g. \"circuit breaker OPEN for payments-service\")",
  "same component, at most 2 hops apart",
];

const CHECKS = [
  { name: "Environment consistency", rule: "a candidate spanning prod and non-prod is split by environment" },
  { name: "Weak bridge", rule: "5+ signals held together by one signal whose best link scores < 0.50 is split at that signal" },
  { name: "Coherence", rule: "at least 25% of signal pairs directly linked (clusters of 3 or fewer exempt)" },
  { name: "Anomaly support", rule: "the strongest signal must have anomaly_score ≥ 0.60" },
];

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4 min-w-0">
      <h2 className="text-sm font-bold text-gray-900 mb-2">{title}</h2>
      {children}
    </section>
  );
}

function Bar({ value, tone = "blue" }: { value: number; tone?: "blue" | "signed" }) {
  const color =
    tone === "signed"
      ? value >= 0
        ? "bg-green-500"
        : "bg-red-500"
      : value >= 0.6
      ? "bg-blue-500"
      : "bg-amber-500";
  return (
    <div className="h-1.5 w-full rounded-full bg-gray-100 overflow-hidden mt-1">
      <div className={clsx("h-full rounded-full", color)} style={{ width: `${Math.max(2, Math.min(100, Math.abs(value) * 100))}%` }} />
    </div>
  );
}

/** Real data from a live incident, next to the generic formula/checklist
 * above — so the spec on this page is grounded in what the engine is
 * actually doing right now, not just what it is documented to do. */
function LiveIncidentPanel() {
  const { data: queue } = useEngineQueue();
  const [selected, setSelected] = useState<string | null>(null);
  const items = queue ?? [];
  const draftId = selected ?? items[0]?.draft_id ?? null;

  const { data: evidence } = useEngineEvidence(draftId);
  const confidence = evidence?.correlation.confidence;

  return (
    <Panel title="Live: see it on a real incident">
      {items.length === 0 ? (
        <p className="text-xs text-gray-600">No incidents formed yet.</p>
      ) : (
        <>
          <select
            className="text-xs border border-gray-200 rounded-lg px-2 py-1.5 mb-3 w-full bg-white"
            value={draftId ?? ""}
            onChange={(e) => setSelected(e.target.value)}
          >
            {items.map((i) => (
              <option key={i.draft_id} value={i.draft_id}>
                {i.priority} · {i.title}
              </option>
            ))}
          </select>
          {!confidence ? (
            <p className="text-xs text-gray-600">Loading…</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                  Actual validation checks (C4)
                </div>
                {confidence.validation && confidence.validation.length > 0 ? (
                  <ul className="text-xs space-y-1">
                    {confidence.validation.map((c) => (
                      <li key={c.name} className="flex gap-1.5">
                        <span className={c.passed ? "text-green-700" : "text-red-700"}>{c.passed ? "✓" : "✕"}</span>
                        <span>
                          <b>{c.name}:</b> {c.detail}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-gray-500">Not recorded for this draft.</p>
                )}
              </div>
              <div>
                <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1.5">
                  Actual confidence breakdown
                </div>
                <ul className="text-xs space-y-1">
                  {confidence.parts.map((p) => (
                    <li key={p.label} className="flex justify-between gap-2">
                      <span>{p.label}</span>
                      <span className="font-mono font-semibold shrink-0">+{p.points.toFixed(2)}</span>
                    </li>
                  ))}
                </ul>
                <div className="text-xs font-bold text-gray-900 mt-1.5 pt-1.5 border-t border-gray-100">
                  = {confidence.final.toFixed(2)}
                </div>
                <div className="text-[11px] text-gray-600 mt-2">
                  Gate: {Object.entries(confidence.gate_reasons).map(([k, v]) => `${k} (×${v})`).join(", ") || "n/a"}
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </Panel>
  );
}

/** Pair F1 with one dimension's weight zeroed at a time - measured on the
 * same held-out seeds the benchmark uses, not asserted. */
function AblationPanel() {
  const { data, error } = useEngineAblation();
  const baseline = data?.find((r) => r.delta === 0 && r.variant.startsWith("baseline"));

  return (
    <Panel title="Ablation — how load-bearing each dimension actually is">
      <p className="text-xs text-gray-700 mb-3">
        Pair F1 on the same held-out seeds as the benchmark below, with one dimension&apos;s weight zeroed at a
        time. The last row removes the structural gate entirely and clusters on time proximity alone — the
        brief&apos;s core principle, measured rather than just stated.
      </p>
      {error && <p className="text-xs text-red-700">Unavailable: {String(error)}</p>}
      {!data && !error && <p className="text-xs text-gray-600">Running the ablation sweep (a few seconds, once)…</p>}
      {data && (
        <ul className="text-xs space-y-2.5">
          {data.map((row) => (
            <li key={row.variant}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium text-gray-900">{row.variant}</span>
                <span className="font-mono font-bold tabular-nums shrink-0">
                  {row.pair_f1.toFixed(3)}
                  {row.delta != null && row.delta !== 0 && baseline && (
                    <span className={row.delta < 0 ? "text-red-700" : "text-green-700"}>
                      {" "}
                      ({row.delta > 0 ? "+" : ""}
                      {row.delta.toFixed(3)})
                    </span>
                  )}
                </span>
              </div>
              <Bar value={row.pair_f1} />
              {row.note && <p className="text-[11px] text-gray-600 mt-1">{row.note}</p>}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** Calibration: does a 0.8 confidence incident actually turn out right 80%
 * of the time? Bucketed from the same held-out benchmark runs. */
function ReliabilityPanel() {
  const { data, error } = useEngineReliability();

  return (
    <Panel title="Calibration — predicted confidence vs. actual accuracy">
      <p className="text-xs text-gray-700 mb-3">
        Every incident the benchmark formed, bucketed by its own predicted correlation confidence, against how
        pure it actually was against the generator&apos;s answer key. Well-calibrated tracks the diagonal;
        a gap means the confidence score over- or under-states how much to trust the incident.
      </p>
      {error && <p className="text-xs text-red-700">Unavailable: {String(error)}</p>}
      {!data && !error && <p className="text-xs text-gray-600">Loading…</p>}
      {data && (
        <table className="w-full text-xs">
          <thead className="text-gray-500 text-left">
            <tr>
              <th className="py-1">confidence bucket</th>
              <th>predicted</th>
              <th>actual</th>
              <th>n</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {data.map((b) => (
              <tr key={b.bucket}>
                <td className="py-1.5 font-mono">{b.bucket}</td>
                <td className="font-mono">{b.predicted.toFixed(2)}</td>
                <td
                  className={clsx(
                    "font-mono font-bold",
                    Math.abs(b.actual - b.predicted) > 0.15 ? "text-amber-700" : "text-gray-900"
                  )}
                >
                  {b.actual.toFixed(2)}
                </td>
                <td className="text-gray-500">{b.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

export function CorrelationsClient() {
  const { data: rejections } = useValidationRejections();

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={TbChartDots3}
        title="Correlation & validation"
        subtitle="How signals become an incident: a structural gate, a five-dimension similarity score, DBSCAN, causal refinement, then validation. Time alone never links two signals."
      />

      <LiveIncidentPanel />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <AblationPanel />
        <ReliabilityPanel />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        <Panel title="1 · Structural gate (must pass before any score is computed)">
          <p className="text-xs text-gray-700 mb-2">A pair is only scored if at least one holds:</p>
          <ul className="list-disc list-inside text-xs text-gray-800 space-y-0.5">
            {GATES.map((g) => <li key={g}>{g}</li>)}
          </ul>
          <p className="text-xs text-gray-600 mt-2">Pairs that fail are never linked, however close in time.</p>
        </Panel>

        <Panel title="2 · Similarity score (dimensions T, S, D, E, C)">
          <div className="font-mono text-xs bg-gray-50 rounded-lg p-2 mb-2">
            sim(a,b) = 0.25·T + 0.20·S + 0.20·D + 0.20·E + 0.15·C
          </div>
          <table className="w-full text-xs">
            <thead className="text-gray-500 text-left"><tr><th className="py-1">dim</th><th>weight</th><th>computed as</th></tr></thead>
            <tbody className="divide-y divide-gray-100">
              {DIMENSIONS.map((d) => (
                <tr key={d.key}>
                  <td className="py-1 font-semibold whitespace-nowrap">{d.key} · {d.name}</td>
                  <td className="font-mono">{d.weight.toFixed(2)}</td>
                  <td className="text-gray-700">{d.calc}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-gray-700 mt-2">
            <b>Merge threshold:</b> sim ≥ 0.34 (DBSCAN on distance 1 − sim, eps 0.66, min_samples 2).{" "}
            <b>Window:</b> 15 min ceiling; pending signals with no partner after 15 min of stream time expire as noise.
            Tuned on seeds 1–20, reported on held-out seeds 21–40.
          </p>
        </Panel>

        <Panel title="3 · Causal refinement">
          <p className="text-xs text-gray-800">
            Within each cluster, counterfactual root-cause analysis over the dependency graph finds services that nothing else in the
            cluster explains. Two such roots are split into two incidents unless their evidence agrees (shared template, same component,
            or one names the other). A true cascade keeps a single root and stays whole.
          </p>
        </Panel>

        <Panel title="4 · Validation (C4) - a candidate must pass all four">
          <ul className="text-xs text-gray-800 space-y-1">
            {CHECKS.map((c) => <li key={c.name}><b>{c.name}:</b> {c.rule}</li>)}
          </ul>
          <p className="text-xs text-gray-600 mt-2">Failing candidates are not raised; their signals stay pending and expire as noise if nothing joins them.</p>
        </Panel>

        <Panel title="Impact severity (0–100)">
          <div className="font-mono text-xs bg-gray-50 rounded-lg p-2 mb-2">
            impact = 100 × (0.40·blast + 0.35·criticality + 0.25·magnitude)
          </div>
          <ul className="text-xs text-gray-800 space-y-0.5">
            <li><b>blast</b> = 0.7·min(services/5, 1) + 0.3·min(further dependents of the root/5, 1)</li>
            <li><b>criticality</b> = highest criticality among involved services (the brief&apos;s 0–100 map; unknown = 50)</li>
            <li><b>magnitude</b> = strongest anomaly_score in the incident</li>
            <li>P1 ≥ 75 · P2 ≥ 50 · P3 ≥ 25 · P4 below</li>
          </ul>
        </Panel>

        <Panel title="Correlation confidence (0–1) - never blended with severity">
          <div className="font-mono text-xs bg-gray-50 rounded-lg p-2 mb-2">
            confidence = 0.40·density + 0.35·topology + 0.25·evidence
          </div>
          <ul className="text-xs text-gray-800 space-y-0.5">
            <li><b>density</b>: share of signal pairs that pass the gate and score ≥ 0.34</li>
            <li><b>topology</b>: share of service pairs within 2 hops on the reference graph</li>
            <li><b>evidence</b>: mean over signals of the best evidence/component agreement with another member</li>
          </ul>
        </Panel>
      </div>

      <Panel title="Live: candidates rejected by validation">
        {!rejections ? (
          <p className="text-xs text-gray-600">Live streams not running.</p>
        ) : rejections.length === 0 ? (
          <p className="text-xs text-gray-600">None so far.</p>
        ) : (
          <ul className="text-xs text-gray-800 space-y-1">
            {rejections.map((r, i) => (
              <li key={i} className="flex gap-2">
                <HiOutlineExclamationTriangle className="text-amber-600 shrink-0 mt-0.5" />
                <span>
                  <span className="font-mono text-gray-500">{clockUTC(r.at)}</span> {r.signals} signals on {r.services.join(", ")} -{" "}
                  {r.failed.map((f) => `${f.name}: ${f.detail}`).join("; ")}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
