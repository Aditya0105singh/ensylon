"use client";

import clsx from "clsx";
import { motion } from "motion/react";
import { isComputing, useEngineAblation, useEngineReliability } from "@/entities/engine/useEngine";
import type { AblationRow, ReliabilityBucket } from "@/entities/engine/types";

function Panel({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section aria-label={title} className="rounded-2xl border border-gray-100 bg-white p-4 min-w-0"
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -16px rgba(16,24,40,.14)" }}>
      <h2 className="text-sm font-bold text-gray-900">{title}</h2>
      <p className="text-[11px] text-gray-500 mt-0.5 mb-3">{sub}</p>
      {children}
    </section>
  );
}

/** Findings read off the numbers, so the page stays honest when weights change. */
export function ablationFindings(rows: AblationRow[]) {
  const base = rows.find((r) => r.variant.startsWith("baseline"));
  const dims = rows.filter((r) => r.variant.startsWith("without"));
  const timeOnly = rows.find((r) => r.variant.startsWith("time proximity only"));
  const code = (v: string) => /\(([A-Z])\)/.exec(v)?.[1] ?? v;
  const mostNeeded = [...dims].sort((a, b) => (a.delta ?? 0) - (b.delta ?? 0))[0];
  return {
    base,
    timeOnly,
    gateGain: base && timeOnly ? base.pair_f1 - timeOnly.pair_f1 : null,
    mostNeeded: mostNeeded ? { code: code(mostNeeded.variant), delta: mostNeeded.delta ?? 0 } : null,
    hurting: dims.filter((r) => (r.delta ?? 0) > 0.005).map((r) => ({ code: code(r.variant), delta: r.delta ?? 0 })),
    idle: dims.filter((r) => Math.abs(r.delta ?? 0) <= 0.005).map((r) => code(r.variant)),
  };
}

export function AblationPanel() {
  const { data, error: rawError, isLoading: loading } = useEngineAblation();
  const isLoading = !data && (loading || isComputing(rawError));
  const error = isComputing(rawError) ? undefined : rawError;
  const f = data ? ablationFindings(data) : null;
  const max = Math.max(0.01, ...(data ?? []).map((r) => r.pair_f1));
  return (
    <Panel title="Ablation: does every part earn its place?"
      sub="Pair F1 on the held-out benchmark seeds with one dimension switched off at a time, plus time alone with the gate removed.">
      {error && <p className="text-xs text-red-700">Could not run the ablation on the backend.</p>}
      {isLoading && (
        <div className="flex items-center gap-2 text-xs text-gray-600" role="status">
          <motion.span className="w-3 h-3 rounded-full border-2 border-green-600 border-t-transparent" animate={{ rotate: 360 }}
            transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }} />
          The benchmark runs once per variant in the background after a restart (about 30 s), then it is instant…
        </div>
      )}
      {data && f?.base && (
        <>
          <ul className="flex flex-col gap-1.5" aria-label="Ablation results">
            {data.map((r, i) => {
              const isBase = r === f.base;
              const worse = (r.delta ?? 0) < -0.005, better = (r.delta ?? 0) > 0.005;
              return (
                <li key={r.variant} className="grid grid-cols-[minmax(0,210px)_1fr_92px] items-center gap-2 text-xs">
                  <span className={clsx("truncate", isBase ? "font-bold text-gray-900" : "text-gray-700")} title={r.note ?? r.variant}>{r.variant}</span>
                  <div className="relative h-4 rounded bg-gray-100">
                    <motion.div className={clsx("h-full rounded", isBase ? "bg-gray-900" : worse ? "bg-red-400" : better ? "bg-amber-400" : "bg-gray-400")}
                      initial={{ width: 0 }} animate={{ width: `${(r.pair_f1 / max) * 100}%` }} transition={{ delay: i * 0.06, duration: 0.5 }} />
                    <div className="absolute inset-y-[-2px] w-px bg-gray-900" style={{ left: `${(f.base!.pair_f1 / max) * 100}%` }} aria-hidden />
                  </div>
                  <span className="font-mono text-right">
                    <b>{r.pair_f1.toFixed(3)}</b>
                    {r.delta != null && r.delta !== 0 && <span className={worse ? "text-red-700" : "text-amber-700"}> {r.delta > 0 ? "+" : ""}{r.delta.toFixed(3)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
          <ul className="mt-3 space-y-1 text-xs text-gray-800">
            {f.gateGain != null && (
              <li>✓ <b>The gate and the other dimensions add +{f.gateGain.toFixed(3)} F1</b> over time alone ({f.timeOnly!.pair_f1.toFixed(3)} → {f.base.pair_f1.toFixed(3)}): the brief&apos;s principle, measured.</li>
            )}
            {f.mostNeeded && <li>✓ <b>{f.mostNeeded.code}</b> carries the most weight: without it F1 falls by {Math.abs(f.mostNeeded.delta).toFixed(3)}.</li>}
            {f.hurting.map((h) => (
              <li key={h.code} className="text-amber-900">▲ Switching off <b>{h.code}</b> <i>raises</i> F1 by {h.delta.toFixed(3)} on this benchmark: its weight is worth revisiting.</li>
            ))}
            {f.idle.length > 0 && <li className="text-gray-600">– {f.idle.join(", ")} change{f.idle.length === 1 ? "s" : ""} nothing here: the benchmark rarely exercises {f.idle.length === 1 ? "it" : "them"}.</li>}
          </ul>
        </>
      )}
    </Panel>
  );
}

/** Reliability diagram: a confidence of 0.8 should be right about 80% of the time. */
export function CalibrationPanel() {
  const { data, error: rawError, isLoading: loading } = useEngineReliability();
  const isLoading = !data && (loading || isComputing(rawError));
  const error = isComputing(rawError) ? undefined : rawError;
  const S = 220, P = 28;
  const x = (v: number) => P + v * (S - P * 2), y = (v: number) => S - P - v * (S - P * 2);
  const rows: ReliabilityBucket[] = data ?? [];
  const nMax = Math.max(1, ...rows.map((r) => r.n));
  const under = rows.filter((r) => r.actual >= r.predicted).length;
  const weighted = rows.reduce((a, r) => a + r.n * (r.actual - r.predicted), 0) / Math.max(1, rows.reduce((a, r) => a + r.n, 0));
  return (
    <Panel title="Calibration: can you trust the confidence score?"
      sub="Every benchmark incident, bucketed by its predicted correlation confidence, against how pure it really was.">
      {error && <p className="text-xs text-red-700">Could not load the calibration from the backend.</p>}
      {isLoading && <p className="text-xs text-gray-600" role="status">Computing from the benchmark runs…</p>}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-[220px_1fr] gap-4 items-center">
          <svg viewBox={`0 0 ${S} ${S}`} className="w-full max-w-[240px]" role="img" aria-label="Predicted confidence against actual accuracy">
            {[0, 0.25, 0.5, 0.75, 1].map((g) => (
              <g key={g}>
                <line x1={x(g)} x2={x(g)} y1={y(0)} y2={y(1)} stroke="#f1f5f9" />
                <line x1={x(0)} x2={x(1)} y1={y(g)} y2={y(g)} stroke="#f1f5f9" />
                <text x={x(g)} y={S - 10} fontSize={8} textAnchor="middle" fill="#94a3b8">{g}</text>
                <text x={12} y={y(g) + 3} fontSize={8} textAnchor="middle" fill="#94a3b8">{g}</text>
              </g>
            ))}
            <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="#94a3b8" strokeDasharray="4 3" />
            <text x={x(0.62)} y={y(0.56)} fontSize={8} fill="#94a3b8" transform={`rotate(-45 ${x(0.62)} ${y(0.56)})`}>perfectly calibrated</text>
            <motion.polyline fill="none" stroke="#2563eb" strokeWidth={1.5} points={rows.map((r) => `${x(r.predicted)},${y(r.actual)}`).join(" ")}
              initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.8 }} />
            {rows.map((r, i) => (
              <motion.circle key={r.bucket} cx={x(r.predicted)} cy={y(r.actual)} r={3 + (r.n / nMax) * 7} fill="#2563eb" fillOpacity={0.75} stroke="#fff"
                initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 0.3 + i * 0.07 }} style={{ transformOrigin: `${x(r.predicted)}px ${y(r.actual)}px` }}>
                <title>{`${r.bucket}: predicted ${r.predicted.toFixed(2)}, actual ${r.actual.toFixed(2)}, n=${r.n}`}</title>
              </motion.circle>
            ))}
            <text x={S / 2} y={S - 1} fontSize={8.5} textAnchor="middle" fill="#64748b">predicted confidence</text>
          </svg>
          <div className="text-xs text-gray-800 space-y-2">
            <p>
              <b>{weighted >= 0 ? "Conservative" : "Over-confident"}.</b> In {under} of {rows.length} buckets the incidents were more accurate than
              the engine claimed; weighted by incidents, actual accuracy is <b>{weighted >= 0 ? "+" : ""}{(weighted * 100).toFixed(0)} points</b> above
              the predicted confidence.
            </p>
            <p className="text-gray-600">
              For a reviewer this is the safe direction to be wrong: a 0.75 incident is usually better than 0.75.
              Low-confidence incidents are rare: {rows.filter((r) => r.predicted < 0.6).reduce((a, r) => a + r.n, 0)} of {rows.reduce((a, r) => a + r.n, 0)} score below 0.6.
            </p>
            <table className="w-full text-[11px]">
              <thead className="text-gray-500 text-left"><tr><th className="py-0.5">bucket</th><th>predicted</th><th>actual</th><th>n</th></tr></thead>
              <tbody className="divide-y divide-gray-100 font-mono">
                {rows.map((r) => (
                  <tr key={r.bucket}><td className="py-0.5">{r.bucket}</td><td>{r.predicted.toFixed(2)}</td>
                    <td className={clsx(r.actual < r.predicted - 0.05 && "text-red-700 font-bold")}>{r.actual.toFixed(2)}</td><td className="text-gray-500">{r.n}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Panel>
  );
}
