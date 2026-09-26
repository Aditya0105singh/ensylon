"use client";

import clsx from "clsx";
import type { StreamMetrics, StreamReaderStatus } from "@/entities/engine/types";
import { Legend, SOURCE_COLOR, SOURCE_NAME, StackedColumns } from "@/entities/engine/charts";

const STREAM_LABEL: Record<string, string> = {
  "aiops-logs": "Application logs",
  "aiops-cloudwatch": "CloudWatch metrics",
  "aiops-grafana": "Grafana alerts",
};

/** green < 30 s, amber < 2 min, red beyond. A keepalive counts as heard. */
function heardTone(seconds: number | null): string {
  if (seconds == null) return "text-gray-500";
  if (seconds < 30) return "text-green-700";
  if (seconds < 120) return "text-amber-700";
  return "text-red-700";
}

function StreamRow({ s }: { s: StreamReaderStatus }) {
  const heard = s.last_heard_seconds_ago;
  const skipped = s.skipped ?? 0;
  return (
    <li className="py-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className={clsx("w-2 h-2 rounded-full shrink-0", s.connected && "kpi-pulse-soft")} style={{ background: s.connected ? SOURCE_COLOR[s.source] ?? "#64748b" : "#dc2626" }} />
        <span className="text-xs font-bold text-gray-900 truncate">{STREAM_LABEL[s.name] ?? s.name}</span>
        <span className={clsx("ml-auto text-[10.5px] font-bold rounded-full px-2 py-0.5 shrink-0",
          s.connected ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800")}>
          {s.connected ? "live" : "reconnecting"}
        </span>
      </div>
      <div className="mt-0.5 pl-4 text-[11px] text-gray-700">
        <b className="text-gray-900 tabular-nums">{s.events.toLocaleString("en-US")}</b> events
        {" → "}<b className="text-gray-900 tabular-nums">{s.signals.toLocaleString("en-US")}</b> signals
        {skipped > 0 && <span className="text-gray-600"> · {skipped.toLocaleString("en-US")} recoveries ignored</span>}
        {s.parse_errors > 0 && <span className="text-red-700"> · {s.parse_errors} unparsable</span>}
      </div>
      <div className="pl-4 text-[10.5px] text-gray-500 truncate" title={s.last_error ?? undefined}>
        <span className={heardTone(heard)}>heard {heard == null ? "never" : `${Math.round(heard)}s ago`}</span>
        {" · "}Last-Event-ID <span className="font-mono">{s.last_event_id ?? "–"}</span>
        {" · "}{s.reconnects} {s.reconnects === 1 ? "reconnect" : "reconnects"}
      </div>
    </li>
  );
}

export function StreamsPanel({ streams, metrics }: { streams: StreamReaderStatus[]; metrics?: StreamMetrics }) {
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const rows = (metrics?.timeline ?? []).slice(-30).map((r) => ({
    label: hhmm(r.minute),
    parts: Object.keys(SOURCE_COLOR).map((k) => ({ key: k, value: Number(r[k] ?? 0) })),
    marker: Number(r.anomalous ?? 0),
  }));
  const anySkipped = streams.some((s) => (s.skipped ?? 0) > 0);
  return (
    <div className="flex flex-col gap-3">
      <ul className="divide-y divide-gray-100">
        {streams.map((s) => <StreamRow key={s.name} s={s} />)}
      </ul>
      {anySkipped && (
        <p className="text-[11px] text-gray-600 rounded-lg bg-gray-50 border border-gray-100 px-2.5 py-1.5">
          A CloudWatch <span className="font-mono">OK</span> or Grafana <span className="font-mono">ok</span> event is a recovery, not a symptom,
          so it is counted but never correlated.
        </p>
      )}
      <div>
        <div className="text-[11px] font-semibold text-gray-700 mb-1">Signals per minute (red dots: anomalies)</div>
        {rows.length === 0 ? (
          <p className="text-xs text-gray-500 py-4 text-center">Waiting for signals…</p>
        ) : (
          <>
            <StackedColumns rows={rows} colors={SOURCE_COLOR} markerLabel="anomalous" height={96} />
            <Legend items={Object.keys(SOURCE_COLOR).map((k) => ({ label: SOURCE_NAME[k], color: SOURCE_COLOR[k] }))} />
          </>
        )}
      </div>
    </div>
  );
}
