"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { motion } from "motion/react";
import { HiArrowRight } from "react-icons/hi2";
import { TbTimeline } from "react-icons/tb";
import { useEngineEvidence, useEngineQueue } from "@/entities/engine/useEngine";
import { PRIORITY_COLOR, SOURCE_COLOR } from "@/entities/engine/charts";
import type { Evidence, EvidenceSignal } from "@/entities/engine/types";
import { DIM_COLOR, canonicalSource, cleanTitle, clockUTC, correlationBreakdown } from "../_overview/lib";
import { DIMS, GATES, MERGE, gateColor } from "./rules";

const W = 760, LANE = 44, PAD_L = 150, PAD_R = 24, PAD_T = 14;

type Placed = EvidenceSignal & { x: number; y: number; k: number };

/** Each signal is drawn to the member it joined through: the nearest earlier
 * signal on the service its join names. */
function layoutJoins(ev: Evidence) {
  const signals = [...ev.signals].sort((a, b) => a.at.localeCompare(b.at));
  const root = ev.root_cause.service;
  const services = Array.from(new Set(signals.map((s) => s.service))).sort((a, b) => (a === root ? -1 : b === root ? 1 : a.localeCompare(b)));
  const t0 = Date.parse(signals[0]?.at ?? "0");
  const t1 = Date.parse(signals[signals.length - 1]?.at ?? "0");
  const span = Math.max(t1 - t0, 1);
  const placed: Placed[] = signals.map((s, k) => ({
    ...s, k,
    x: PAD_L + ((Date.parse(s.at) - t0) / span) * (W - PAD_L - PAD_R),
    y: PAD_T + services.indexOf(s.service) * LANE + LANE / 2,
  }));
  const links = placed.slice(1).map((s) => {
    const target = s.join.linked_to ?? s.service;
    const to = [...placed.slice(0, s.k)].reverse().find((p) => p.service === target);
    return to && s.join.joined ? { from: s, to } : null;
  }).filter(Boolean) as { from: Placed; to: Placed }[];
  return { placed, links, services, height: PAD_T * 2 + services.length * LANE, span };
}

function Breakdown({ s, weights }: { s: EvidenceSignal; weights: Record<string, number> }) {
  const c = s.join.components as Record<string, number> | null;
  if (!c) return <p className="text-xs text-gray-500">No join breakdown for this signal.</p>;
  const parts = DIMS.map((d) => ({ ...d, v: Number(c[d.key] ?? 0), w: Number(weights[d.key] ?? d.weight) }));
  return (
    <div>
      <div className="relative pt-4">
        <div className="flex h-4 overflow-hidden rounded bg-gray-200">
          {parts.map((p) => <motion.div key={p.key} className="h-full" style={{ background: DIM_COLOR[p.key] }}
            initial={{ width: 0 }} animate={{ width: `${p.w * p.v * 100}%` }} transition={{ duration: 0.4 }} />)}
        </div>
        <div className="absolute top-2.5 bottom-0 w-0.5 bg-gray-900" style={{ left: `${MERGE * 100}%` }} />
      </div>
      <div className="mt-1 text-xs"><b className="font-mono">{Number(c.total).toFixed(2)}</b> <span className="text-gray-500">≥ {MERGE} · via</span>{" "}
        <b style={{ color: gateColor(s.join.gate) }}>{s.join.gate}</b>{s.join.linked_to && s.join.linked_to !== s.service && <> with <b>{s.join.linked_to}</b></>}</div>
      <ul className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-sm" style={{ background: DIM_COLOR[p.key] }} />
            <b className="font-mono text-gray-500">{p.code}</b><span className="ml-auto font-mono">{(p.w * p.v).toFixed(2)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A real incident from the live streams, drawn as the joins that built it. */
export function IncidentExplorer() {
  const { data: queue } = useEngineQueue();
  const items = useMemo(() => [...(queue ?? [])].filter((q) => q.status !== "merged")
    .sort((a, b) => b.signal_count - a.signal_count || b.started_at.localeCompare(a.started_at)).slice(0, 10), [queue]);
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked ?? items[0]?.draft_id ?? null;
  const { data: ev } = useEngineEvidence(id, { refreshInterval: 0, revalidateOnFocus: false });
  const [focus, setFocus] = useState<string | null>(null);
  const summary = items.find((q) => q.draft_id === id);

  const map = useMemo(() => (ev && ev.draft_id === id ? layoutJoins(ev) : null), [ev, id]);
  const focused = map?.placed.find((p) => p.id === focus) ?? map?.placed[map.placed.length - 1] ?? null;
  const dims = ev ? correlationBreakdown(ev) : null;
  const validation = ev?.correlation.confidence.validation ?? [];
  const usedGates = new Set(map?.links.map((l) => l.from.join.gate?.split(",")[0]) ?? []);

  return (
    <section aria-label="Live incident explorer" className="rounded-2xl border border-gray-100 bg-white p-5"
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 12px 32px -20px rgba(16,24,40,.18)" }}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-gray-900">On a real incident: the joins that built it</h2>
        {summary && (
          <Link href={`/timemachine?id=${summary.draft_id}`} className="inline-flex items-center gap-1 text-xs font-semibold text-green-700 hover:underline">
            <TbTimeline /> Replay it in the Time Machine
          </Link>
        )}
      </div>

      {items.length === 0 ? (
        <p className="mt-2 text-sm text-gray-600">No incidents yet. They appear here as soon as the streams produce one.</p>
      ) : (
        <>
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1" role="listbox" aria-label="Incident">
            {items.map((q) => (
              <button key={q.draft_id} role="option" aria-selected={q.draft_id === id} onClick={() => { setPicked(q.draft_id); setFocus(null); }}
                className={clsx("shrink-0 w-52 rounded-xl border px-3 py-2 text-left transition-colors",
                  q.draft_id === id ? "border-green-600 ring-1 ring-green-600 bg-green-50/40" : "border-gray-100 hover:border-gray-300")}>
                <span className="flex items-center gap-1.5 text-[10.5px]">
                  <span className="rounded px-1.5 font-extrabold text-white" style={{ background: PRIORITY_COLOR[q.priority] }}>{q.priority}</span>
                  <span className="font-mono text-gray-500">{clockUTC(q.started_at).slice(0, 5)}</span>
                  <span className="ml-auto text-gray-500">{q.signal_count} signals</span>
                </span>
                <span className="mt-0.5 block truncate text-xs font-bold text-gray-900">{cleanTitle(q.title)}</span>
              </button>
            ))}
          </div>

          {!map ? (
            <p className="mt-4 text-xs text-gray-500">Loading the incident&apos;s evidence…</p>
          ) : (
            <div className="mt-3 grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-4">
              <div className="min-w-0">
                <svg viewBox={`0 0 ${W} ${map.height}`} className="w-full h-auto" role="img"
                  aria-label={`${map.placed.length} signals on ${map.services.length} services, with ${map.links.length} joins`}>
                  {map.services.map((svc, i) => (
                    <g key={svc}>
                      <line x1={PAD_L - 8} x2={W - PAD_R} y1={PAD_T + i * LANE + LANE / 2} y2={PAD_T + i * LANE + LANE / 2} stroke="#eef2f7" />
                      <text x={PAD_L - 14} y={PAD_T + i * LANE + LANE / 2 + 4} textAnchor="end" fontSize={11.5}
                        fontWeight={svc === ev!.root_cause.service ? 800 : 500} fill={svc === ev!.root_cause.service ? "#b91c1c" : "#374151"}>
                        {svc.length > 20 ? `${svc.slice(0, 19)}…` : svc}{svc === ev!.root_cause.service ? " ◆" : ""}
                      </text>
                    </g>
                  ))}
                  {map.links.map(({ from, to }) => {
                    const mx = (from.x + to.x) / 2;
                    const bow = from.y === to.y ? -Math.min(26, Math.max(10, Math.abs(from.x - to.x) / 5)) : 0;
                    const d = `M${to.x},${to.y} Q${mx},${(from.y + to.y) / 2 + bow} ${from.x},${from.y}`;
                    const on = focused?.id === from.id;
                    return (
                      <motion.path key={from.id} d={d} fill="none" stroke={gateColor(from.join.gate)}
                        strokeWidth={on ? 2.6 : 1.4} strokeOpacity={on ? 1 : 0.55} strokeLinecap="round"
                        initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.6, delay: from.k * 0.03 }} />
                    );
                  })}
                  {map.placed.map((s) => {
                    const on = focused?.id === s.id;
                    const r = Math.min(9, 4.5 + Math.log2(Math.max(1, s.occurrences)) * 1.5);
                    return (
                      <g key={s.id} role="button" tabIndex={0} aria-label={`${s.service} at ${clockUTC(s.at)}`}
                        onClick={() => setFocus(s.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setFocus(s.id)}
                        className="cursor-pointer outline-none">
                        {on && <circle cx={s.x} cy={s.y} r={r + 5} fill="none" stroke="#111827" strokeWidth={1.5} />}
                        <motion.circle cx={s.x} cy={s.y} r={r} fill={SOURCE_COLOR[canonicalSource(s.source)] ?? "#64748b"} stroke="#fff" strokeWidth={1.5}
                          initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: s.k * 0.03, type: "spring", stiffness: 400, damping: 20 }}
                          style={{ transformOrigin: `${s.x}px ${s.y}px` }} />
                        <title>{`${clockUTC(s.at)} · ${s.service}: ${s.message}`}</title>
                      </g>
                    );
                  })}
                </svg>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-gray-600">
                  {GATES.filter((g) => usedGates.has(g.name)).map((g) => (
                    <span key={g.name} className="inline-flex items-center gap-1.5"><span className="w-4 h-0.5 rounded" style={{ background: g.color }} />{g.name}</span>
                  ))}
                  <span className="text-gray-400">◆ probable origin · dot colour = source stream · click a signal</span>
                </div>
              </div>

              <div className="flex flex-col gap-3 min-w-0">
                {focused && (
                  <div className="rounded-xl border border-gray-100 bg-gray-50/70 p-3">
                    <div className="text-[11px] text-gray-500 font-mono">{clockUTC(focused.at)} UTC</div>
                    <div className="text-sm font-bold text-gray-900">{focused.service}</div>
                    <p className="text-xs text-gray-700 line-clamp-2" title={focused.message}>{focused.message}</p>
                    <div className="mt-2"><Breakdown s={focused} weights={ev!.correlation.weights} /></div>
                  </div>
                )}
                {dims && (
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">What held this incident together</div>
                    <p className="text-[11px] text-gray-500">Mean weighted contribution over its {dims.joins} joins</p>
                    <div className="mt-1.5 flex h-3 overflow-hidden rounded bg-gray-200">
                      {dims.dims.map((d) => <div key={d.key} style={{ width: `${d.contribution * 100}%`, background: DIM_COLOR[d.key] }} title={`${d.code} ${d.contribution.toFixed(2)}`} />)}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-gray-700">
                      {dims.dims.map((d) => <span key={d.key}><b style={{ color: DIM_COLOR[d.key] }}>{d.code}</b> {d.contribution.toFixed(2)}</span>)}
                      <span className="ml-auto font-bold">= {dims.total.toFixed(2)}</span>
                    </div>
                  </div>
                )}
                {validation.length > 0 && (
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Validation: {validation.filter((v) => v.passed).length}/{validation.length} passed</div>
                    <ul className="mt-1 space-y-0.5 text-[11px] text-gray-800">
                      {validation.map((v) => <li key={v.name}><span className={v.passed ? "text-green-700" : "text-red-700"}>{v.passed ? "✓" : "✕"}</span> <b>{v.name}</b> · {v.detail}</li>)}
                    </ul>
                  </div>
                )}
                {ev && (
                  <div className="text-[11px] text-gray-700">
                    <b>Confidence {ev.correlation.confidence.final.toFixed(2)}</b> = {ev.correlation.confidence.parts.map((p) => `${p.points.toFixed(2)}`).join(" + ")}
                    <span className="text-gray-500"> (density · topology · evidence)</span>
                    <Link href={`/review/${ev.draft_id}`} className="ml-2 inline-flex items-center gap-0.5 font-semibold text-green-700 hover:underline">open incident <HiArrowRight /></Link>
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
