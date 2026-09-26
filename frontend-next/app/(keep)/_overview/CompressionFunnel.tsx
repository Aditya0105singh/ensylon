"use client";

import clsx from "clsx";
import { HiArrowRight } from "react-icons/hi2";
import type { QueueSummary, StreamStatus } from "@/entities/engine/types";
import { useEngineEvidence } from "@/entities/engine/useEngine";
import { PRIORITY_COLOR, SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import { cleanTitle, sourceMix, type CanonicalSource } from "./lib";

const SHORT: Record<CanonicalSource, string> = { application_logs: "logs", cloudwatch_metrics: "CloudWatch", grafana_alerts: "Grafana" };

type Stage = { label: string; value: number; note: string; tone: string };

export function CompressionFunnel({ engine, incidents }: { engine: StreamStatus["engine"]; incidents: QueueSummary[] }) {
  const correlated = incidents.reduce((a, q) => a + q.signal_count, 0);
  const awaiting = incidents.filter((q) => q.status === "awaiting_review").length;
  const decided = incidents.filter((q) => q.status === "published" || q.status === "rejected").length;
  const stages: Stage[] = [
    { label: "Raw signals", value: engine.signals_received, note: "parsed + PII-redacted", tone: "#94a3b8" },
    { label: "Anomalies", value: engine.anomalous, note: `${Math.max(0, engine.signals_received - engine.anomalous)} within baseline`, tone: "#f59e0b" },
    { label: "Correlated", value: correlated, note: "distinct signals inside incidents", tone: "#2563eb" },
    { label: "Incidents", value: incidents.length, note: `${awaiting} awaiting review · ${decided} decided`, tone: "#dc2626" },
  ];
  const max = Math.max(1, ...stages.map((s) => s.value));

  return (
    <div className="flex flex-col gap-2">
      {stages.map((s, i) => {
        const pct = s.value === 0 ? 2 : Math.max(8, Math.sqrt(s.value / max) * 100);
        return (
          <div key={s.label} className="grid grid-cols-[92px_1fr] items-center gap-3">
            <div className="text-right">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{s.label}</div>
            </div>
            <div className="flex items-center gap-3 min-w-0">
              <div
                className="funnel-bar h-9 rounded-lg flex items-center px-3 text-white font-extrabold text-lg shrink-0"
                style={{ width: `${pct}%`, background: s.tone, animationDelay: `${i * 120}ms` }}
              >
                {s.value}
              </div>
              <span className="text-[11px] text-gray-600 truncate">{s.note}</span>
            </div>
          </div>
        );
      })}
      <div className="grid grid-cols-[92px_1fr] gap-3 mt-1">
        <div />
        <div className="flex flex-wrap gap-1.5 text-[11px]">
          <SideChip label="waiting for a structural partner" value={engine.pending} />
          <SideChip label="expired as noise" value={engine.noise} />
          <SideChip label="rejected by validation" value={engine.validation_rejections} />
        </div>
      </div>
    </div>
  );
}

function SideChip({ label, value }: { label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-2 py-0.5 text-gray-700">
      <b className="text-gray-900">{value}</b> {label}
    </span>
  );
}

/** One row per incident: the raw signals from each stream that fed it. */
export function IncidentComposition({ incidents, onSelect, selectedId }: { incidents: QueueSummary[]; onSelect: (id: string) => void; selectedId: string | null }) {
  if (incidents.length === 0) {
    return <p className="text-xs text-gray-500 py-6 text-center">Incidents appear here as signals are correlated.</p>;
  }
  return (
    <ul className="flex flex-col gap-2">
      {incidents.slice(0, 5).map((q) => (
        <CompositionRow key={q.draft_id} q={q} selected={q.draft_id === selectedId} onSelect={() => onSelect(q.draft_id)} />
      ))}
    </ul>
  );
}

function CompositionRow({ q, selected, onSelect }: { q: QueueSummary; selected: boolean; onSelect: () => void }) {
  const { data: ev } = useEngineEvidence(q.draft_id);
  const mix = ev ? sourceMix(ev.signals) : null;
  const total = mix ? Object.values(mix).reduce((a, v) => a + v, 0) : q.signal_count;
  const color = PRIORITY_COLOR[q.priority] ?? "#9ca3af";
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={clsx(
          "w-full grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,0.9fr)_auto_minmax(0,1.3fr)] items-center gap-2 rounded-xl border px-2.5 py-2 text-left transition-colors",
          selected ? "border-green-300 bg-green-50/60" : "border-gray-100 hover:border-gray-200 hover:bg-gray-50"
        )}
      >
        <div className="min-w-0">
          <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100">
            {mix &&
              (Object.keys(mix) as CanonicalSource[]).map((k) =>
                mix[k] > 0 ? <span key={k} style={{ width: `${(mix[k] / total) * 100}%`, background: SOURCE_COLOR[k] }} title={`${mix[k]} ${SOURCE_NAME[k]}`} /> : null
              )}
          </div>
          <div className="mt-1 text-[11px] text-gray-600 truncate">
            {mix
              ? (Object.keys(mix) as CanonicalSource[]).filter((k) => mix[k] > 0).map((k) => `${mix[k]} ${SHORT[k]}`).join(" · ")
              : `${q.signal_count} signals`}
          </div>
        </div>
        <span className="flex items-center gap-1 text-gray-400">
          <b className="text-sm text-gray-900">{total}</b>
          <HiArrowRight />
          <b className="text-sm text-gray-900">1</b>
        </span>
        <div className="min-w-0 flex items-center gap-2 col-span-2 sm:col-span-1">
          <span className="text-[10px] font-bold text-white rounded px-1.5 py-0.5 shrink-0" style={{ background: color }}>{q.priority}</span>
          <span className="text-xs font-semibold text-gray-900 truncate">{cleanTitle(q.title)}</span>
        </div>
      </button>
    </li>
  );
}
