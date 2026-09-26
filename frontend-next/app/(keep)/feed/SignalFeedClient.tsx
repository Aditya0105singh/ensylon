"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { HiOutlineQueueList } from "react-icons/hi2";
import { KeepLoader, PageHero } from "@/shared/ui";
import { useStreamSignals, useStreamStatus } from "@/entities/engine/useEngine";
import type { CanonicalSignal } from "@/entities/engine/types";
import { SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import { ANOMALY_THRESHOLD, clockUTC } from "../_overview/lib";

const SOURCES = [
  { key: null, label: "All streams" },
  { key: "application_logs", label: "Application logs" },
  { key: "cloudwatch_metrics", label: "CloudWatch metrics" },
  { key: "grafana_alerts", label: "Grafana alerts" },
] as const;

/** The source's own level, so an INFO line never reads as an error just
 * because the canonical signal_type for every log line is "error_log_burst". */
const LEVEL: Record<string, { label: string; cls: string }> = {
  critical: { label: "ALARM", cls: "bg-red-600 text-white" },
  high: { label: "ERROR", cls: "bg-red-100 text-red-800" },
  warning: { label: "WARN", cls: "bg-amber-100 text-amber-800" },
  info: { label: "INFO", cls: "bg-gray-100 text-gray-600" },
};

const isAnomaly = (s: CanonicalSignal) => s.metadata?.is_anomaly === true;

export function SignalFeedClient() {
  const [source, setSource] = useState<string | null>(null);
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, isLoading } = useStreamSignals(source, 300, {}, anomaliesOnly);
  const { data: status } = useStreamStatus();

  // Rows that arrived since the previous refresh get a brief highlight.
  const seen = useRef<Set<string> | null>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!data) return;
    const ids = data.signals.map((s) => s.signal_id);
    if (seen.current) {
      setFresh(new Set(ids.filter((id) => !seen.current!.has(id))));
    }
    seen.current = new Set(ids);
  }, [data]);
  useEffect(() => {
    seen.current = null;          // a new filter is a new list, not new arrivals
  }, [source, anomaliesOnly]);

  const replaying = !!status?.replay?.active;
  const lastSignal = status?.engine.last_signal_seconds_ago;
  const up = status?.streams.filter((s) => s.connected).length ?? 0;
  const anomalyCount = data?.signals.filter(isAnomaly).length ?? 0;

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={HiOutlineQueueList}
        title="Signal feed"
        subtitle="Every signal from the three streams, normalised to the canonical schema. PII is redacted before a record is stored, so nothing below ever held it."
      >
        <div className="flex flex-col items-end gap-2">
          <div className="flex flex-wrap gap-1 justify-end">
            {SOURCES.map((s) => (
              <button key={s.label} onClick={() => setSource(s.key)}
                className={clsx("rounded-full border text-xs font-semibold px-3 py-1",
                  source === s.key ? "bg-green-700 text-white border-green-700" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")}>
                {s.label}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-2 text-xs font-semibold text-gray-700 cursor-pointer select-none">
            <input type="checkbox" className="accent-green-700" checked={anomaliesOnly} onChange={(e) => setAnomaliesOnly(e.target.checked)} />
            Anomalies only
          </label>
        </div>
      </PageHero>

      {status && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-600 px-1" role="status" aria-label="Feed status">
          <span className={clsx("inline-flex items-center gap-1.5 font-bold", replaying ? "text-amber-700" : up === status.streams.length ? "text-green-700" : "text-amber-700")}>
            <span className={clsx("w-2 h-2 rounded-full", replaying ? "bg-amber-500" : "bg-green-600 kpi-pulse-soft")} />
            {replaying ? "Replay · not live" : `Live · ${up}/${status.streams.length} streams`}
          </span>
          <span>
            newest signal {lastSignal == null ? "not yet" : lastSignal < 60 ? `${Math.round(lastSignal)}s ago` : `${Math.round(lastSignal / 60)} min ago`}
          </span>
          <span><b className="text-gray-900 tabular-nums">{status.engine.signals_received.toLocaleString("en-US")}</b> received so far</span>
          {data && !anomaliesOnly && (
            <span>
              {anomalyCount === 0
                ? `none of the newest ${data.signals.length} is anomalous: the streams are in a calm stretch`
                : `${anomalyCount} of the newest ${data.signals.length} anomalous`}
            </span>
          )}
          <span className="ml-auto text-gray-500">refreshes every 3 s · click a row for its canonical record</span>
        </div>
      )}

      {isLoading && <KeepLoader includeMinHeight={false} loadingText="Loading signals..." />}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">Live streams are not running on the backend.</div>}

      {data && (
        <div className="rounded-2xl border border-gray-200 bg-white overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-600 text-left">
              <tr>
                <th className="px-3 py-2">time (UTC)</th>
                <th className="px-3 py-2">level</th>
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
                <tr><td colSpan={8} className="px-3 py-6 text-center text-gray-500">
                  {anomaliesOnly ? "No anomalies among the signals kept in memory." : "No signals yet - the streams may be in a quiet period."}
                </td></tr>
              )}
              {data.signals.map((s) => {
                const level = LEVEL[String(s.metadata?.severity ?? "")] ?? LEVEL.info;
                const anomalous = isAnomaly(s);
                const isOpen = open === s.signal_id;
                return (
                  <Fragment key={s.signal_id}>
                    <tr
                      onClick={() => setOpen(isOpen ? null : s.signal_id)}
                      aria-expanded={isOpen}
                      className={clsx("cursor-pointer hover:bg-green-50/50 transition-colors",
                        isOpen && "bg-green-50", fresh.has(s.signal_id) && "feed-fresh",
                        !anomalous && "text-gray-600")}
                      style={anomalous ? { boxShadow: `inset 3px 0 0 ${s.anomaly_score >= ANOMALY_THRESHOLD ? "#dc2626" : "#f59e0b"}` } : undefined}
                    >
                      <td className="px-3 py-1.5 font-mono whitespace-nowrap">{clockUTC(s.timestamp)}</td>
                      <td className="px-3 py-1.5"><span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-bold", level.cls)}>{level.label}</span></td>
                      <td className="px-3 py-1.5 whitespace-nowrap">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full" style={{ background: SOURCE_COLOR[s.source] ?? "#64748b" }} />
                          {SOURCE_NAME[s.source] ?? s.source}
                        </span>
                      </td>
                      <td className={clsx("px-3 py-1.5 whitespace-nowrap", anomalous ? "font-bold text-gray-900" : "font-semibold")}>{s.service}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap">{s.component ?? "-"}</td>
                      <td className="px-3 py-1.5 whitespace-nowrap font-mono text-[11px]">{s.signal_type}</td>
                      <td className={clsx("px-3 py-1.5 text-right font-mono",
                        !anomalous ? "text-gray-400" : s.anomaly_score >= ANOMALY_THRESHOLD ? "text-red-700 font-bold" : "text-amber-700 font-bold")}>
                        {s.anomaly_score.toFixed(2)}
                      </td>
                      <td className="px-3 py-1.5 max-w-[520px] truncate" title={s.evidence}>{s.evidence}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-green-50/60">
                        <td colSpan={8} className="px-3 pb-3 pt-1">
                          {anomalous && !!s.metadata?.detection_reason && (
                            <p className="text-xs text-gray-800 mb-2"><b>Why it is anomalous:</b> {String(s.metadata.detection_reason)}</p>
                          )}
                          {!anomalous && (
                            <p className="text-xs text-gray-700 mb-2">Within its baseline: counted and kept, never correlated.</p>
                          )}
                          <div className="text-[10.5px] font-bold uppercase tracking-wide text-gray-600 mb-1">Canonical record</div>
                          <pre className="text-[11px] font-mono bg-white border border-gray-200 rounded-lg p-3 overflow-x-auto">{JSON.stringify(s, null, 2)}</pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && <p className="text-[11px] text-gray-500">Showing {data.signals.length} of {data.total.toLocaleString("en-US")} kept in memory.</p>}
    </div>
  );
}
