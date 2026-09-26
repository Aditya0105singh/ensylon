"use client";

import { useState } from "react";
import clsx from "clsx";
import { HiOutlineQueueList } from "react-icons/hi2";
import { KeepLoader, PageHero } from "@/shared/ui";
import { useStreamSignals } from "@/entities/engine/useEngine";
import type { CanonicalSignal } from "@/entities/engine/types";
import { clockUTC } from "../_overview/lib";

const SOURCES = [
  { key: null, label: "All streams" },
  { key: "application_logs", label: "Application logs" },
  { key: "cloudwatch_metrics", label: "CloudWatch metrics" },
  { key: "grafana_alerts", label: "Grafana alerts" },
] as const;

export function SignalFeedClient() {
  const [source, setSource] = useState<string | null>(null);
  const [open, setOpen] = useState<CanonicalSignal | null>(null);
  const { data, error, isLoading } = useStreamSignals(source, 300);

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={HiOutlineQueueList}
        title="Signal feed"
        subtitle="Every signal from the three streams, normalised to the canonical schema. PII is redacted before a record is stored, so nothing below ever held it."
      >
        <div className="flex flex-wrap gap-1">
          {SOURCES.map((s) => (
            <button key={s.label} onClick={() => setSource(s.key)}
              className={clsx("rounded-full border text-xs font-semibold px-3 py-1",
                source === s.key ? "bg-green-700 text-white border-green-700" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")}>
              {s.label}
            </button>
          ))}
        </div>
      </PageHero>

      {isLoading && <KeepLoader includeMinHeight={false} loadingText="Loading signals..." />}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">Live streams are not running on the backend.</div>}

      {data && (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-600 text-left">
              <tr>
                <th className="px-3 py-2">time (UTC)</th>
                <th className="px-3 py-2">source</th>
                <th className="px-3 py-2">service</th>
                <th className="px-3 py-2">component</th>
                <th className="px-3 py-2">signal_type</th>
                <th className="px-3 py-2 text-right">anomaly_score</th>
                <th className="px-3 py-2">evidence</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.signals.length === 0 && (
                <tr><td colSpan={7} className="px-3 py-6 text-center text-gray-500">No signals yet - the streams may be in a quiet period.</td></tr>
              )}
              {data.signals.map((s) => (
                <tr key={s.signal_id} onClick={() => setOpen(open?.signal_id === s.signal_id ? null : s)}
                  className={clsx("cursor-pointer hover:bg-green-50/50", open?.signal_id === s.signal_id && "bg-green-50")}>
                  <td className="px-3 py-1.5 font-mono whitespace-nowrap">{clockUTC(s.timestamp)}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.source}</td>
                  <td className="px-3 py-1.5 font-semibold whitespace-nowrap">{s.service}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.component ?? "-"}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{s.signal_type}</td>
                  <td className={clsx("px-3 py-1.5 text-right font-mono", s.anomaly_score >= 0.6 ? "text-red-700 font-bold" : "text-gray-600")}>
                    {s.anomaly_score.toFixed(2)}
                  </td>
                  <td className="px-3 py-1.5 max-w-[520px] truncate" title={s.evidence}>{s.evidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="rounded-2xl border border-green-200 bg-white p-4">
          <div className="text-xs font-bold uppercase tracking-wide text-gray-700 mb-2">Canonical record</div>
          <pre className="text-[11px] font-mono bg-gray-50 rounded-lg p-3 overflow-x-auto">{JSON.stringify(open, null, 2)}</pre>
        </div>
      )}
      {data && <p className="text-[11px] text-gray-500">Showing {data.signals.length} of {data.total} kept in memory. Refreshes every 3 s.</p>}
    </div>
  );
}
