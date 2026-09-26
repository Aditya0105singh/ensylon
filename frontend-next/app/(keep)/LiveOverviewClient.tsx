"use client";

import Link from "next/link";
import clsx from "clsx";
import {
  HiOutlineSignal,
  HiOutlineShieldCheck,
  HiOutlineExclamationTriangle,
} from "react-icons/hi2";
import { KeepLoader, PageHero } from "@/shared/ui";
import {
  useEngineQueue,
  useStreamMetrics,
  useStreamSignals,
  useStreamStatus,
  useValidationRejections,
} from "@/entities/engine/useEngine";
import type { StreamReaderStatus } from "@/entities/engine/types";
import {
  ChartCard,
  Donut,
  Histogram,
  Legend,
  PRIORITY_COLOR,
  SOURCE_COLOR,
  SOURCE_NAME,
  StackedColumns,
} from "@/entities/engine/charts";

const STREAM_LABEL: Record<string, string> = {
  "aiops-logs": "Application logs",
  "aiops-cloudwatch": "CloudWatch metrics",
  "aiops-grafana": "Grafana alerts",
};

const PRIORITY_STYLE: Record<string, string> = {
  P1: "bg-red-100 text-red-800 border-red-200",
  P2: "bg-orange-100 text-orange-800 border-orange-200",
  P3: "bg-yellow-50 text-yellow-800 border-yellow-200",
  P4: "bg-gray-100 text-gray-700 border-gray-200",
};

export const clockUTC = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

function Panel({ title, children, right, className }: { title: string; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <section
      className={clsx("rounded-2xl border border-white/80 p-4 min-w-0", className)}
      style={{ background: "linear-gradient(160deg,#fff 60%,#f0fdf4)", boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)" }}
    >
      <header className="flex items-center justify-between gap-2 mb-3">
        <h2 className="text-sm font-bold text-gray-900">{title}</h2>
        {right}
      </header>
      {children}
    </section>
  );
}

function StreamCard({ s }: { s: StreamReaderStatus }) {
  const heard = s.last_heard_seconds_ago;
  return (
    <div className="rounded-xl border border-gray-200 bg-white/90 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold text-gray-900">{STREAM_LABEL[s.name] ?? s.name}</div>
        <span className={clsx("inline-flex items-center gap-1 text-[11px] font-bold rounded-full px-2 py-0.5",
          s.connected ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800")}>
          <span className={clsx("w-1.5 h-1.5 rounded-full", s.connected ? "bg-green-600 animate-pulse" : "bg-red-600")} />
          {s.connected ? "connected" : "reconnecting"}
        </span>
      </div>
      <div className="font-mono text-[11px] text-gray-500 mt-0.5">/sim/stream/{s.name}</div>
      <dl className="grid grid-cols-3 gap-2 mt-2 text-center">
        <div><dt className="text-[10px] uppercase text-gray-500">events</dt><dd className="text-lg font-bold text-gray-900">{s.events}</dd></div>
        <div><dt className="text-[10px] uppercase text-gray-500">signals</dt><dd className="text-lg font-bold text-gray-900">{s.signals}</dd></div>
        <div><dt className="text-[10px] uppercase text-gray-500">keepalives</dt><dd className="text-lg font-bold text-gray-900">{s.keepalives}</dd></div>
      </dl>
      <div className="text-[11px] text-gray-600 mt-2 space-y-0.5">
        <div>Last-Event-ID: <span className="font-mono">{s.last_event_id ?? "none yet"}</span></div>
        <div>Last heard: {heard == null ? "never" : `${heard}s ago`} · reconnects {s.reconnects}
          {s.skipped > 0 && <> · {s.skipped} non-symptom (e.g. state ok)</>}
          {s.parse_errors > 0 && <span className="text-red-700"> · {s.parse_errors} unparsable</span>}
        </div>
        {s.last_error && !s.connected && <div className="text-red-700 truncate" title={s.last_error}>{s.last_error}</div>}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white/90 p-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">{label}</div>
      <div className="text-2xl font-extrabold text-gray-900">{value}</div>
      {hint && <div className="text-[11px] text-gray-600">{hint}</div>}
    </div>
  );
}

function Charts({ metrics, queue }: { metrics: ReturnType<typeof useStreamMetrics>["data"]; queue: { started_at: string; priority: string }[] }) {
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const rows = (metrics?.timeline ?? []).slice(-30).map((r) => ({
    label: hhmm(r.minute),
    parts: Object.keys(SOURCE_COLOR).map((k) => ({ key: k, value: Number(r[k] ?? 0) })),
    marker: Number(r.anomalous ?? 0),
  }));
  const bins = (metrics?.score_histogram ?? []).map((b) => ({ label: b.lo.toFixed(1), value: b.count }));
  const prio = Object.keys(PRIORITY_COLOR).map((k) => ({
    key: k, color: PRIORITY_COLOR[k], value: queue.filter((q) => q.priority === k).length,
  }));

  // Incidents over time: one column per minute an incident started.
  const byMinute: Record<string, number> = {};
  queue.forEach((q) => {
    const m = new Date(q.started_at); m.setSeconds(0, 0);
    const k = m.toISOString();
    byMinute[k] = (byMinute[k] ?? 0) + 1;
  });
  const incRows = Object.keys(byMinute).sort().slice(-20).map((k) => ({ label: hhmm(k), parts: [{ key: "incidents", value: byMinute[k] }] }));

  const empty = <p className="text-xs text-gray-500 py-6 text-center">Waiting for signals…</p>;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChartCard title="Signals per minute, by stream" sub="Event time (UTC). Red dots: anomalous signals in that minute.">
        {rows.length === 0 ? empty : (
          <>
            <StackedColumns rows={rows} colors={SOURCE_COLOR} markerLabel="anomalous" />
            <Legend items={Object.keys(SOURCE_COLOR).map((k) => ({ label: SOURCE_NAME[k], color: SOURCE_COLOR[k] }))} />
          </>
        )}
      </ChartCard>
      <ChartCard title="Anomaly score distribution" sub="Every signal, scored 0-1. Incidents need at least one signal at 0.60 or above.">
        {bins.every((b) => b.value === 0) ? empty : (
          <Histogram bins={bins} colorFor={(i) => (i >= 6 ? "#dc2626" : i >= 3 ? "#f59e0b" : "#16a34a")} />
        )}
      </ChartCard>
      <ChartCard title="Incidents by priority" sub="P1 ≥ 75 impact, P2 ≥ 50, P3 ≥ 25, P4 below.">
        <div className="flex items-center gap-4">
          <Donut parts={prio} />
          <Legend items={prio.map((p) => ({ label: `${p.key}: ${p.value}`, color: p.color }))} />
        </div>
      </ChartCard>
      <ChartCard title="Incidents over time" sub="Incidents by the minute their first signal arrived.">
        {incRows.length === 0 ? empty : <StackedColumns rows={incRows} colors={{ incidents: "#15803d" }} height={130} />}
      </ChartCard>
    </div>
  );
}

export function LiveOverviewClient() {
  const { data: status, error } = useStreamStatus();
  const { data: queue } = useEngineQueue();
  const { data: feed } = useStreamSignals(null, 12);
  const { data: rejections } = useValidationRejections();
  const { data: metrics } = useStreamMetrics();

  if (!status && !error) return <KeepLoader loadingText="Connecting to the signal streams..." />;

  const e = status?.engine;
  const open = (queue ?? []).filter((q) => q.status === "awaiting_review");
  const incidents = [...(queue ?? [])].sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  const quiet = e && e.signals_received === 0;

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={HiOutlineSignal}
        title="Nexus live operations"
        subtitle="Three SSE signal streams, redacted on arrival, correlated on structural evidence, validated, and drafted into tickets that wait for a human."
      >
        {status && (
          <span className="rounded-full bg-white border border-green-200 text-green-800 text-xs font-semibold px-3 py-1">
            graph: {status.graph_origin} · Claude: {status.claude.enabled ? status.claude.model : "off (template drafts)"}
          </span>
        )}
      </PageHero>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          The backend is not running the live streams ({String(error.message ?? error)}). Start it without AIOPS_OFFLINE_DEMO and with NEXUS_LIVE=1.
        </div>
      )}

      {status && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {status.streams.map((s) => <StreamCard key={s.name} s={s} />)}
        </div>
      )}

      {e && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <Stat label="Signals received" value={e.signals_received} hint="after parsing + redaction" />
          <Stat label="Anomalous" value={e.anomalous} hint="anomaly_score over threshold" />
          <Stat label="Pending" value={e.pending} hint="waiting for a structural partner" />
          <Stat label="Incidents" value={e.incidents} hint={`${open.length} awaiting review`} />
          <Stat label="Noise" value={e.noise} hint="expired without a partner" />
          <Stat label="Rejected by validation" value={e.validation_rejections} hint="never raised" />
        </div>
      )}

      {quiet && (
        <div className="rounded-xl border border-gray-200 bg-white/80 p-3 text-sm text-gray-700">
          The streams are connected but quiet{e?.stream_clock ? "" : " (only keepalives so far)"}. Silence raises nothing: incidents form only
          when anomalous signals share a service, a dependency edge, a component, or name each other in their evidence.
        </div>
      )}

      <Charts metrics={metrics} queue={queue ?? []} />

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-4 items-start">
        <Panel title="Incidents" right={<Link href="/review" className="text-xs font-semibold text-green-700 hover:underline">Review queue →</Link>}>
          {incidents.length === 0 ? (
            <p className="text-sm text-gray-600">No incidents yet.</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {incidents.slice(0, 8).map((q) => (
                <li key={q.draft_id} className="py-2">
                  <Link href={`/review/${q.draft_id}`} className="flex items-start gap-2 group">
                    <span className={clsx("text-[11px] font-bold border rounded-full px-2 py-0.5 shrink-0", PRIORITY_STYLE[q.priority] ?? PRIORITY_STYLE.P4)}>{q.priority}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-gray-900 group-hover:text-green-800 truncate">{q.title}</span>
                      <span className="block text-[11px] text-gray-600">
                        impact {Math.round(q.severity_score * 100)}/100 · confidence {q.correlation_confidence.toFixed(2)} · {q.signal_count} signals ·{" "}
                        {q.affected_services.join(", ")} · since {clockUTC(q.started_at)} UTC
                      </span>
                    </span>
                    <span className={clsx("text-[11px] font-semibold shrink-0",
                      q.status === "awaiting_review" ? "text-amber-700" : q.status === "published" ? "text-green-700" : "text-gray-500")}>
                      {q.status === "awaiting_review" ? "needs review" : q.status === "published" ? q.jira_key : q.status}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Latest canonical signals" right={<Link href="/feed" className="text-xs font-semibold text-green-700 hover:underline">Signal feed →</Link>}>
          {!feed || feed.signals.length === 0 ? (
            <p className="text-sm text-gray-600">No signals yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {feed.signals.map((s) => (
                <li key={s.signal_id} className="text-[11px] leading-snug">
                  <span className="font-mono text-gray-500">{clockUTC(s.timestamp)}</span>{" "}
                  <span className="font-semibold text-gray-800">{s.service}</span>{" "}
                  <span className="text-gray-500">[{s.source}]</span>{" "}
                  <span className={clsx("font-mono", s.anomaly_score >= 0.6 ? "text-red-700" : "text-gray-500")}>{s.anomaly_score.toFixed(2)}</span>
                  <span className="block text-gray-700 truncate" title={s.evidence}>{s.evidence}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      {rejections && rejections.length > 0 && (
        <Panel title="Candidates rejected by validation (not raised)" right={<HiOutlineShieldCheck className="text-green-700" />}>
          <ul className="text-xs text-gray-800 space-y-1">
            {rejections.slice(0, 6).map((r, i) => (
              <li key={i} className="flex gap-2">
                <HiOutlineExclamationTriangle className="text-amber-600 shrink-0 mt-0.5" />
                <span>
                  {r.signals} signals on {r.services.join(", ")}: {r.failed.map((f) => `${f.name} - ${f.detail}`).join("; ")}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
