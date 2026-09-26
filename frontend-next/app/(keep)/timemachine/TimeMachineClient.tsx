"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { TbTimeline } from "react-icons/tb";
import { EmptyStateCard, KeepLoader, PageHero } from "@/shared/ui";
import { useEngineEvidence, useEngineQueue } from "@/entities/engine/useEngine";
import { SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import type { Evidence, EvidenceSignal } from "@/entities/engine/types";

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

const CANON: Record<string, string> = {
  cloudwatch_metric: "cloudwatch_metrics",
  app_log: "application_logs",
  cloudwatch_log: "application_logs",
  grafana_alert: "grafana_alerts",
};
const canon = (s: string) => CANON[s] ?? s;

const DIMS: { key: keyof NonNullable<EvidenceSignal["join"]["components"]>; label: string; weight: number }[] = [
  { key: "time_proximity", label: "T time", weight: 0.25 },
  { key: "service_affinity", label: "S service", weight: 0.2 },
  { key: "dependency_closeness", label: "D dependency", weight: 0.2 },
  { key: "template_similarity", label: "E evidence", weight: 0.2 },
  { key: "component_match", label: "C component", weight: 0.15 },
];

function Replay({ ev }: { ev: Evidence }) {
  const steps = useMemo(() => [...ev.signals].sort((a, b) => (a.at < b.at ? -1 : 1)), [ev]);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => setI(0), [ev.draft_id]);
  useEffect(() => {
    if (!playing) return;
    if (i >= steps.length - 1) { setPlaying(false); return; }
    const t = setTimeout(() => setI((x) => x + 1), 1400);
    return () => clearTimeout(t);
  }, [playing, i, steps.length]);

  if (steps.length === 0) return null;
  const cur = steps[Math.min(i, steps.length - 1)];
  const sofar = steps.slice(0, i + 1);
  const services = Array.from(new Set(sofar.map((s) => s.service)));
  const t0 = new Date(steps[0].at).getTime();
  const t1 = new Date(steps[steps.length - 1].at).getTime();
  const span = Math.max(t1 - t0, 1);
  const pos = (s: EvidenceSignal) => (steps.length === 1 ? 50 : ((new Date(s.at).getTime() - t0) / span) * 100);
  const first = i === 0;
  const done = i === steps.length - 1;
  const j = cur.join;

  return (
    <div className="flex flex-col gap-4">
      {/* transport */}
      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <button onClick={() => { if (done) setI(0); setPlaying(!playing); }}
            className="rounded-lg bg-green-700 hover:bg-green-800 text-white text-xs font-semibold px-3 py-1.5">
            {playing ? "Pause" : done ? "Replay" : "Play"}
          </button>
          <button disabled={i === 0} onClick={() => { setPlaying(false); setI(i - 1); }}
            className="rounded-lg border border-gray-300 bg-white disabled:opacity-40 text-xs font-semibold px-3 py-1.5">◀ Back</button>
          <button disabled={done} onClick={() => { setPlaying(false); setI(i + 1); }}
            className="rounded-lg border border-gray-300 bg-white disabled:opacity-40 text-xs font-semibold px-3 py-1.5">Next ▶</button>
          <span className="text-xs text-gray-700 ml-auto">signal {i + 1} of {steps.length} · {clock(cur.at)} UTC</span>
        </div>

        {/* time axis */}
        <div className="relative h-10 mx-2">
          <div className="absolute left-0 right-0 top-1/2 h-px bg-gray-300" />
          {steps.map((s, k) => (
            <button key={s.id} onClick={() => { setPlaying(false); setI(k); }} title={`${clock(s.at)} · ${s.service}`}
              className={clsx("absolute top-1/2 -translate-y-1/2 -translate-x-1/2 rounded-full border-2 transition-all",
                k === i ? "w-4 h-4 border-gray-900 z-10" : k < i ? "w-3 h-3 border-white" : "w-3 h-3 border-white opacity-30")}
              style={{ left: `${pos(s)}%`, background: SOURCE_COLOR[canon(s.source)] ?? "#9ca3af" }} />
          ))}
        </div>
        <div className="flex justify-between text-[10px] text-gray-500 mx-2"><span>{clock(steps[0].at)}</span><span>{clock(steps[steps.length - 1].at)}</span></div>
        <div className="flex flex-wrap gap-x-3 mt-2 text-[11px] text-gray-700">
          {Object.keys(SOURCE_COLOR).map((k) => (
            <span key={k} className="inline-flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-full" style={{ background: SOURCE_COLOR[k] }} />{SOURCE_NAME[k]}</span>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
        {/* this step */}
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">This signal</div>
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: SOURCE_COLOR[canon(cur.source)] }} />
            <span className="text-sm font-bold text-gray-900">{cur.service}</span>
            <span className="text-xs text-gray-600">{SOURCE_NAME[canon(cur.source)] ?? cur.source}</span>
            {cur.occurrences > 1 && <span className="text-[11px] font-mono text-gray-700">×{cur.occurrences}</span>}
          </div>
          <p className="text-sm text-gray-900 mt-1 break-words">{cur.message}</p>
          {cur.detection_reason && <p className="text-[11px] text-gray-600 mt-1">Detected because: {cur.detection_reason}</p>}

          <div className="mt-3 rounded-xl bg-gray-50 border border-gray-200 p-3 text-xs">
            {first ? (
              <p><b>First signal.</b> Nothing to join yet: it starts the candidate incident and sets its onset time.</p>
            ) : j.joined ? (
              <>
                <p>
                  <b>Joined</b> through the structural gate: <span className="font-semibold text-green-800">{j.gate}</span>
                  {j.linked_to && <> · linked to <span className="font-semibold">{j.linked_to}</span></>}.
                </p>
                {j.components && (
                  <div className="mt-2 space-y-1">
                    {DIMS.map((d) => {
                      const v = Number(j.components?.[d.key] ?? 0);
                      return (
                        <div key={d.key} className="flex items-center gap-2">
                          <span className="w-24 text-gray-600">{d.label}</span>
                          <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden"><div className="h-full bg-green-600" style={{ width: `${v * 100}%` }} /></div>
                          <span className="w-20 text-right font-mono text-gray-700">{v.toFixed(2)} × {d.weight}</span>
                        </div>
                      );
                    })}
                    <div className="text-right font-mono font-bold text-gray-900">similarity {j.components.total.toFixed(2)} (merge at ≥ 0.34)</div>
                  </div>
                )}
              </>
            ) : (
              <p className="text-red-800"><b>Not joined.</b> This signal passed no structural gate against the others, so time alone did not link it.</p>
            )}
          </div>
        </div>

        {/* the incident so far */}
        <div className="rounded-2xl border border-gray-200 bg-white p-4">
          <div className="text-[11px] font-bold uppercase tracking-wide text-gray-500 mb-1">The incident so far</div>
          <div className="text-sm text-gray-900"><b>{sofar.length}</b> signal{sofar.length === 1 ? "" : "s"} across <b>{services.length}</b> service{services.length === 1 ? "" : "s"}</div>
          <div className="flex flex-wrap gap-1.5 mt-2">
            {services.map((sv) => (
              <span key={sv} className={clsx("rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                done && sv === ev.root_cause.service ? "bg-red-50 border-red-300 text-red-800" : "bg-green-50 border-green-200 text-green-900")}>
                {sv}{done && sv === ev.root_cause.service ? " · suspected root" : ""}
              </span>
            ))}
          </div>
          <ol className="mt-3 space-y-1 text-[11px] text-gray-700 max-h-56 overflow-auto">
            {sofar.map((s, k) => (
              <li key={s.id} className={clsx(k === i && "font-semibold text-gray-900")}>
                <span className="font-mono text-gray-500">{clock(s.at)}</span> {s.service}
                <span className="text-gray-500"> - {s.message.slice(0, 70)}</span>
              </li>
            ))}
          </ol>
          {done ? (
            <div className="mt-3 rounded-xl border border-red-200 bg-red-50/60 p-3 text-xs text-gray-900">
              <b>Root cause: {ev.root_cause.service ?? "undetermined"}</b>
              {ev.root_cause.service && <> ({Math.round(ev.root_cause.confidence)}% causal confidence)</>}
              {ev.root_cause.reasoning.slice(0, 3).map((r, k) => <div key={k} className="text-gray-700 mt-0.5">• {r}</div>)}
            </div>
          ) : (
            <p className="mt-3 text-[11px] text-gray-500">The root cause is only decided once every signal is in; step to the end to see it.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function TimeMachineClient() {
  const { data: queue, isLoading } = useEngineQueue();
  const [id, setId] = useState<string | null>(null);
  const items = useMemo(() => [...(queue ?? [])].sort((a, b) => (a.started_at < b.started_at ? 1 : -1)), [queue]);
  const active = id ?? items[0]?.draft_id ?? null;
  const { data: ev } = useEngineEvidence(active);

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={TbTimeline}
        title="Time machine"
        subtitle="Replay how an incident formed, one signal at a time: which gate let each signal in, how similar it was to the others, and when the root cause became clear."
      >
        {items.length > 0 && (
          <select value={active ?? ""} onChange={(e) => setId(e.target.value)} aria-label="Incident"
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm max-w-xs">
            {items.map((q) => <option key={q.draft_id} value={q.draft_id}>{q.priority} · {q.title.replace("[DRAFT] ", "").slice(0, 60)}</option>)}
          </select>
        )}
      </PageHero>

      {isLoading ? (
        <KeepLoader includeMinHeight={false} loadingText="Loading incidents..." />
      ) : items.length === 0 ? (
        <EmptyStateCard icon={TbTimeline} title="Nothing to replay yet"
          description="An incident appears here as soon as the streams produce a validated correlation.">
          <Link href="/" className="text-sm font-semibold text-green-700 hover:underline">Back to Overview →</Link>
        </EmptyStateCard>
      ) : ev ? (
        <Replay ev={ev} />
      ) : (
        <KeepLoader includeMinHeight={false} loadingText="Loading evidence..." />
      )}
    </div>
  );
}
