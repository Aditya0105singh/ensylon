"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  HiArrowRight,
  HiCheckCircle,
  HiOutlineExclamationTriangle,
  HiOutlineShieldCheck,
} from "react-icons/hi2";
import { KeepLoader } from "@/shared/ui";
import {
  LIVE_REFRESH_MS,
  useEngineDraft,
  useEngineEvidence,
  useEngineQueue,
  useServiceGraph,
  useStreamMetrics,
  useStreamSignals,
  useStreamStatus,
  useValidationRejections,
} from "@/entities/engine/useEngine";
import type { QueueSummary, StreamReaderStatus, StreamStatus } from "@/entities/engine/types";
import {
  ChartCard,
  Histogram,
  Legend,
  PRIORITY_COLOR,
  SOURCE_COLOR,
  SOURCE_NAME,
  StackedColumns,
} from "@/entities/engine/charts";
import { ANOMALY_THRESHOLD, cleanTitle, clockUTC, impact, rankIncidents } from "./_overview/lib";
import { CompressionFunnel, IncidentComposition } from "./_overview/CompressionFunnel";
import { IncidentStory } from "./_overview/IncidentStory";
import { IntelligenceFeed } from "./_overview/IntelligenceFeed";

const STREAM_LABEL: Record<string, string> = {
  "aiops-logs": "Application logs",
  "aiops-cloudwatch": "CloudWatch metrics",
  "aiops-grafana": "Grafana alerts",
};

function Panel({ title, sub, children, right, className }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <section
      className={clsx("rounded-2xl border border-gray-100 bg-white p-4 min-w-0", className)}
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -16px rgba(16,24,40,.14)" }}
    >
      <header className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-gray-900">{title}</h2>
          {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

function Hero({ status, incidents }: { status: StreamStatus; incidents: QueueSummary[] }) {
  const e = status.engine;
  const connected = status.streams.filter((s) => s.connected).length;
  const awaiting = incidents.filter((q) => q.status === "awaiting_review");
  const firstAwaiting = rankIncidents(awaiting)[0];
  const cascades = incidents.filter((q) => q.affected_services.length > 1).length;
  const claudeOn = status.claude.enabled;
  const pipeline = [
    { label: "Ingest & redact", on: connected > 0 },
    { label: "Anomaly detection", on: true },
    { label: "Correlation", on: true },
    { label: "Validation", on: true },
    { label: claudeOn ? "AI drafting" : "AI drafting (template fallback)", on: claudeOn, soft: !claudeOn },
  ];

  return (
    <section
      className="relative overflow-hidden rounded-2xl border border-green-100 px-5 py-5 md:px-6"
      style={{
        background: "linear-gradient(120deg,#f0fdf4 0%,#ffffff 50%,#ecfdf5 100%)",
        boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 12px 32px -18px rgba(22,163,74,.35)",
      }}
    >
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 w-72 h-72 rounded-full bg-green-200/40 blur-3xl" />
      <div className="relative grid grid-cols-1 xl:grid-cols-[1fr_auto] gap-5 items-center">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap text-[11px] font-semibold">
            <span className={clsx("inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 border",
              connected === status.streams.length ? "bg-green-100 text-green-800 border-green-200" : "bg-amber-100 text-amber-800 border-amber-200")}>
              <span className={clsx("w-1.5 h-1.5 rounded-full", connected === status.streams.length ? "bg-green-600 animate-pulse" : "bg-amber-500")} />
              Intelligence engine online · {connected}/{status.streams.length} streams connected
            </span>
            {e.stream_clock && <span className="text-gray-500">stream clock {clockUTC(e.stream_clock)} UTC</span>}
          </div>
          <h1 className="mt-2 text-2xl md:text-3xl font-extrabold tracking-tight text-gray-900">Nexus AIOps Intelligence Engine</h1>
          <p className="mt-2 text-lg md:text-xl font-bold text-gray-800 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span><span className="text-gray-900 text-2xl md:text-3xl font-extrabold">{e.signals_received}</span> raw signals</span>
            <HiArrowRight className="text-green-600" />
            <span><span className="text-amber-600 text-2xl md:text-3xl font-extrabold">{e.anomalous}</span> anomalies</span>
            <HiArrowRight className="text-green-600" />
            <span><span className="text-red-600 text-2xl md:text-3xl font-extrabold">{incidents.length}</span> correlated incident{incidents.length === 1 ? "" : "s"}</span>
            {cascades > 0 && (
              <span className="text-sm font-semibold text-gray-600">({cascades} multi-service cascade{cascades === 1 ? "" : "s"})</span>
            )}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {Object.keys(SOURCE_NAME).map((k) => (
              <span key={k} className="inline-flex items-center gap-1.5 rounded-full bg-white border border-gray-200 px-2.5 py-0.5 text-[11px] text-gray-700">
                <span className="w-2 h-2 rounded-full" style={{ background: SOURCE_COLOR[k] }} />
                <b className="text-gray-900">{e.by_source?.[k] ?? 0}</b> {SOURCE_NAME[k]}
              </span>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <span className="font-semibold text-gray-500 uppercase tracking-wider">Pipeline</span>
            {pipeline.map((p) => (
              <span key={p.label} className={clsx("inline-flex items-center gap-1", p.on ? "text-green-800" : p.soft ? "text-gray-500" : "text-red-700")}>
                {p.on ? <HiCheckCircle className="text-green-600" /> : <span className="w-3 h-3 rounded-full border-2 border-gray-300 inline-block" />}
                {p.label}
              </span>
            ))}
          </div>
        </div>

        <div className="rounded-2xl bg-white/90 border border-gray-100 p-4 w-full xl:w-[300px] shadow-sm">
          {awaiting.length > 0 ? (
            <>
              <div className="text-[11px] font-bold uppercase tracking-wider text-amber-700">Human review required</div>
              <div className="mt-1 text-3xl font-extrabold text-gray-900">{awaiting.length}</div>
              <div className="text-xs text-gray-600">incident{awaiting.length === 1 ? "" : "s"} waiting. Nothing is written until a named reviewer approves.</div>
              <Link
                href={firstAwaiting ? `/review/${firstAwaiting.draft_id}` : "/review"}
                className="mt-3 w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-sm font-bold px-3 py-2 transition-colors"
              >
                Review {firstAwaiting ? firstAwaiting.priority : "queue"} now <HiArrowRight />
              </Link>
            </>
          ) : (
            <>
              <div className="text-[11px] font-bold uppercase tracking-wider text-green-700">Review queue clear</div>
              <div className="mt-1 text-sm text-gray-700">No incident is waiting for a reviewer.</div>
              <Link href="/review" className="mt-3 inline-flex items-center gap-1 text-xs font-semibold text-green-700 hover:underline">
                Past decisions <HiArrowRight />
              </Link>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function Kpi({ label, value, hint, accent }: { label: string; value: React.ReactNode; hint?: string; accent?: string }) {
  return (
    <div className="kpi-card rounded-xl border border-gray-100 bg-white p-3" style={{ boxShadow: "0 1px 2px rgba(16,24,40,.04)" }}>
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">{label}</div>
      <div className="text-2xl md:text-[28px] font-extrabold leading-tight" style={{ color: accent ?? "#111827" }}>{value}</div>
      {hint && <div className="text-[11px] text-gray-600 truncate" title={hint}>{hint}</div>}
    </div>
  );
}

function IntelligenceMetrics({ engine, incidents }: { engine: StreamStatus["engine"]; incidents: QueueSummary[] }) {
  const compression = incidents.length ? engine.signals_received / incidents.length : null;
  const meanConf = incidents.length ? incidents.reduce((a, q) => a + q.correlation_confidence, 0) / incidents.length : null;
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      <Kpi label="Signals ingested" value={engine.signals_received} hint="parsed, redacted, canonical" />
      <Kpi label="Anomalies detected" value={engine.anomalous} hint={`score ≥ ${ANOMALY_THRESHOLD.toFixed(2)}`} accent="#d97706" />
      <Kpi label="Incidents formed" value={incidents.length} hint={`${incidents.filter((q) => q.priority === "P1").length} P1 · ${incidents.filter((q) => q.priority === "P2").length} P2`} accent="#dc2626" />
      <Kpi label="Alert compression" value={compression == null ? "–" : `${compression.toFixed(1)}×`} hint="raw signals per incident raised" accent="#15803d" />
      <Kpi label="Mean confidence" value={meanConf == null ? "–" : meanConf.toFixed(2)} hint="correlation confidence, 0–1" />
      <Kpi label="Noise suppressed" value={engine.noise + engine.validation_rejections} hint={`${engine.noise} expired · ${engine.validation_rejections} failed validation`} />
    </div>
  );
}

function OtherIncident({ q, selected, onSelect }: { q: QueueSummary; selected: boolean; onSelect: () => void }) {
  const color = PRIORITY_COLOR[q.priority] ?? "#9ca3af";
  const downstream = q.affected_services.filter((s) => s !== q.root_cause_service);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={clsx("w-full text-left rounded-xl border bg-white p-3 transition-all",
          selected ? "ring-2 ring-green-500 border-transparent" : "border-gray-100 hover:border-gray-300")}
        style={{ borderLeft: `4px solid ${color}` }}
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-extrabold text-white rounded px-1.5 py-0.5" style={{ background: color }}>{q.priority}</span>
          <span className="text-[10.5px] text-gray-500">{clockUTC(q.started_at)} UTC</span>
          <span className={clsx("ml-auto text-[10.5px] font-semibold",
            q.status === "awaiting_review" ? "text-amber-700" : q.status === "published" ? "text-green-700" : "text-gray-500")}>
            {q.status === "awaiting_review" ? "needs review" : q.status === "published" ? q.jira_key ?? "approved" : q.status}
          </span>
        </div>
        <div className="mt-1 text-sm font-bold text-gray-900 truncate">{cleanTitle(q.title)}</div>
        <div className="mt-1 text-[11px] text-gray-700 truncate">
          <b>{q.root_cause_service ?? "unknown origin"}</b>
          {downstream.length > 0 && <> → {downstream.join(" · ")}</>}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2 text-[10.5px] text-gray-500">
          <span>impact <b className="text-gray-900">{impact(q)}</b></span>
          <span>confidence <b className="text-gray-900">{q.correlation_confidence.toFixed(2)}</b></span>
          <span><b className="text-gray-900">{q.signal_count}</b> signals</span>
        </div>
      </button>
    </li>
  );
}

function StreamCard({ s }: { s: StreamReaderStatus }) {
  const heard = s.last_heard_seconds_ago;
  return (
    <div className="rounded-xl border border-gray-100 bg-white p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-900">
          <span className="w-2 h-2 rounded-full" style={{ background: SOURCE_COLOR[s.source] ?? "#64748b" }} />
          {STREAM_LABEL[s.name] ?? s.name}
        </div>
        <span className={clsx("inline-flex items-center gap-1 text-[10.5px] font-bold rounded-full px-2 py-0.5",
          s.connected ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800")}>
          <span className={clsx("w-1.5 h-1.5 rounded-full", s.connected ? "bg-green-600 animate-pulse" : "bg-red-600")} />
          {s.connected ? "connected" : "reconnecting"}
        </span>
      </div>
      <div className="mt-1.5 flex items-baseline gap-3 text-[11px] text-gray-600">
        <span><b className="text-base text-gray-900">{s.signals}</b> signals</span>
        <span>{s.events} events</span>
        <span>{s.keepalives} keepalives</span>
      </div>
      <div className="text-[10.5px] text-gray-500 mt-1 truncate" title={s.last_error ?? undefined}>
        Last-Event-ID <span className="font-mono">{s.last_event_id ?? "–"}</span> · heard {heard == null ? "never" : `${Math.round(heard)}s ago`} · {s.reconnects} reconnects
        {s.parse_errors > 0 && <span className="text-red-700"> · {s.parse_errors} unparsable</span>}
      </div>
    </div>
  );
}

function Telemetry({ metrics }: { metrics: ReturnType<typeof useStreamMetrics>["data"] }) {
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  const rows = (metrics?.timeline ?? []).slice(-30).map((r) => ({
    label: hhmm(r.minute),
    parts: Object.keys(SOURCE_COLOR).map((k) => ({ key: k, value: Number(r[k] ?? 0) })),
    marker: Number(r.anomalous ?? 0),
  }));
  const bins = (metrics?.score_histogram ?? []).map((b) => ({ label: b.lo.toFixed(1), value: b.count }));
  const empty = <p className="text-xs text-gray-500 py-6 text-center">Waiting for signals…</p>;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ChartCard title="Signals per minute, by stream" sub="Event time (UTC). Red dots: anomalous signals in that minute.">
        {rows.length === 0 ? empty : (
          <>
            <StackedColumns rows={rows} colors={SOURCE_COLOR} markerLabel="anomalous" height={130} />
            <Legend items={Object.keys(SOURCE_COLOR).map((k) => ({ label: SOURCE_NAME[k], color: SOURCE_COLOR[k] }))} />
          </>
        )}
      </ChartCard>
      <ChartCard title="Anomaly score distribution" sub={`Only signals at ${ANOMALY_THRESHOLD.toFixed(2)} or above can anchor an incident.`}>
        {bins.every((b) => b.value === 0) ? empty : (
          <Histogram bins={bins} colorFor={(i) => (i >= 6 ? "#dc2626" : i >= 3 ? "#f59e0b" : "#16a34a")} />
        )}
      </ChartCard>
    </div>
  );
}

export function LiveOverviewClient() {
  const { data: status, error } = useStreamStatus();
  const { data: queue } = useEngineQueue();
  const { data: feed } = useStreamSignals(null, 14);
  const { data: rejections } = useValidationRejections();
  const { data: metrics } = useStreamMetrics();
  const { data: graph } = useServiceGraph();
  const [picked, setPicked] = useState<string | null>(null);

  const incidents = useMemo(() => rankIncidents(queue ?? []), [queue]);
  const focus = incidents.find((q) => q.draft_id === picked) ?? incidents[0] ?? null;
  const focusId = focus?.draft_id ?? null;
  const { data: evidence } = useEngineEvidence(focusId, { refreshInterval: LIVE_REFRESH_MS });
  const { data: detail } = useEngineDraft(focusId, { refreshInterval: LIVE_REFRESH_MS });

  const otherServices = useMemo(
    () => new Set(incidents.filter((q) => q.draft_id !== focusId && q.status !== "rejected").flatMap((q) => q.affected_services)),
    [incidents, focusId]
  );

  if (!status && !error) return <KeepLoader loadingText="Connecting to the signal streams..." />;

  const e = status?.engine;
  const quiet = e && e.signals_received === 0;

  return (
    <div className="flex flex-col gap-4 p-4">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          The backend is not running the live streams ({String(error.message ?? error)}). Start it without AIOPS_OFFLINE_DEMO and with NEXUS_LIVE=1.
        </div>
      )}

      {status && <Hero status={status} incidents={incidents} />}

      {e && <IntelligenceMetrics engine={e} incidents={incidents} />}

      {quiet && (
        <div className="rounded-xl border border-gray-200 bg-white/80 p-3 text-sm text-gray-700">
          The streams are connected but quiet{e?.stream_clock ? "" : " (only keepalives so far)"}. Silence raises nothing: incidents form only
          when anomalous signals share a service, a dependency edge, a component, or name each other in their evidence.
        </div>
      )}

      {e && (
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_1fr] gap-4">
          <Panel title="From alert flood to actionable incidents" sub="Every stage is computed live from the three streams">
            <CompressionFunnel engine={e} incidents={incidents} />
          </Panel>
          <Panel title="What each incident absorbed" sub="Raw signals per stream folded into one incident. Click to focus it below."
            right={<Link href="/review" className="text-xs font-semibold text-green-700 hover:underline shrink-0">All incidents →</Link>}>
            <IncidentComposition incidents={incidents} selectedId={focusId} onSelect={setPicked} />
          </Panel>
        </div>
      )}

      {focus && (
        <div id="incident-focus" className="scroll-mt-4">
          <IncidentStory q={focus} ev={evidence} detail={detail} graph={graph} otherIncidentServices={otherServices} />
        </div>
      )}

      {incidents.length > 1 && (
        <Panel title="Other incidents" sub="Select one to put it in focus above">
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {incidents.filter((q) => q.draft_id !== focusId).slice(0, 6).map((q) => (
              <OtherIncident key={q.draft_id} q={q} selected={false} onSelect={() => {
                setPicked(q.draft_id);
                document.getElementById("incident-focus")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
              }} />
            ))}
          </ul>
        </Panel>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_1fr] gap-4 items-start">
        <Panel title="Live intelligence feed" sub="Newest canonical signals, already redacted. Click one to see why it matters."
          right={<Link href="/feed" className="text-xs font-semibold text-green-700 hover:underline shrink-0">Signal feed →</Link>}>
          <IntelligenceFeed signals={feed?.signals ?? []} incidents={incidents} />
        </Panel>
        <div className="flex flex-col gap-4 min-w-0">
          {status && (
            <Panel title="Stream health" sub="SSE with Last-Event-ID resume; keepalives never raise incidents">
              <div className="flex flex-col gap-2">
                {status.streams.map((s) => <StreamCard key={s.name} s={s} />)}
              </div>
            </Panel>
          )}
          <Panel title="Rejected by validation" sub="Candidate groups the engine refused to raise"
            right={<HiOutlineShieldCheck className="text-green-700 shrink-0" />}>
            {!rejections || rejections.length === 0 ? (
              <p className="text-xs text-gray-600">None so far. Every candidate passed environment, bridge, coherence and anomaly checks.</p>
            ) : (
              <ul className="text-xs text-gray-800 space-y-1.5">
                {rejections.slice(0, 5).map((r, i) => (
                  <li key={`${r.at}-${i}`} className="flex gap-2">
                    <HiOutlineExclamationTriangle className="text-amber-600 shrink-0 mt-0.5" />
                    <span>
                      <b>{r.signals} signals</b> on {r.services.join(", ")}: {r.failed.map((f) => `${f.name} (${f.detail})`).join("; ")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>

      <div>
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-gray-500 mb-2 px-1">Stream telemetry</h2>
        <Telemetry metrics={metrics} />
      </div>
    </div>
  );
}
