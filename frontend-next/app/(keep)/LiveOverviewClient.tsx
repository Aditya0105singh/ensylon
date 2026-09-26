"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
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
import type { QueueSummary } from "@/entities/engine/types";
import { PRIORITY_COLOR } from "@/entities/engine/charts";
import { ANOMALY_THRESHOLD, cleanTitle, clockUTC, impact, rankIncidents } from "./_overview/lib";
import { StatusHero } from "./_overview/StatusHero";
import { PipelineStrip } from "./_overview/PipelineStrip";
import { IncidentStory } from "./_overview/IncidentStory";
import { AnomalyLedger } from "./_overview/AnomalyLedger";
import { StreamsPanel } from "./_overview/StreamsPanel";

function Panel({ title, sub, children, right, className }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <section
      className={clsx("rounded-2xl border border-gray-100 bg-white p-4 min-w-0", className)}
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -16px rgba(16,24,40,.14)" }}
      aria-label={title}
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

function OtherIncident({ q, onSelect }: { q: QueueSummary; onSelect: () => void }) {
  const color = PRIORITY_COLOR[q.priority] ?? "#9ca3af";
  const downstream = q.affected_services.filter((s) => s !== q.root_cause_service);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="w-full text-left rounded-xl border border-gray-100 bg-white p-3 transition-all hover:border-gray-300"
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

/** Overview: the ten-second answer. Does a human owe a decision, what did the
 * engine make of the streams (C1-C5), and what did it refuse to raise. */
export function LiveOverviewClient() {
  const { data: status, error } = useStreamStatus();
  const { data: queue } = useEngineQueue();
  const { data: anomalies } = useStreamSignals(null, 12, {}, ANOMALY_THRESHOLD);
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

  const others = incidents.filter((q) => q.draft_id !== focusId);

  return (
    <div className="flex flex-col gap-4 p-4">
      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          The backend is not running the live streams ({String(error.message ?? error)}). Start it without AIOPS_OFFLINE_DEMO and with NEXUS_LIVE=1.
        </div>
      )}

      {status && <StatusHero status={status} incidents={incidents} />}
      {status && <PipelineStrip status={status} incidents={incidents} />}

      {focus && (
        <div id="incident-focus" className="scroll-mt-4">
          <IncidentStory q={focus} ev={evidence} detail={detail} graph={graph} otherIncidentServices={otherServices} />
        </div>
      )}

      {others.length > 0 && (
        <Panel title="Other incidents" sub="Select one to put it in focus above"
          right={<Link href="/review" className="text-xs font-semibold text-green-700 hover:underline shrink-0">Review queue →</Link>}>
          <ul className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {others.slice(0, 6).map((q) => (
              <OtherIncident key={q.draft_id} q={q} onSelect={() => {
                setPicked(q.draft_id);
                document.getElementById("incident-focus")?.scrollIntoView?.({ behavior: "smooth", block: "start" });
              }} />
            ))}
          </ul>
        </Panel>
      )}

      {status && (
        <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-4 items-start">
          <Panel
            title="Every anomaly, and what happened to it"
            sub="Only structural evidence links signals. Time alone never does."
            right={<Link href="/correlations" className="text-xs font-semibold text-green-700 hover:underline shrink-0">How correlation works →</Link>}
          >
            <AnomalyLedger
              anomalies={anomalies?.signals ?? []}
              total={anomalies?.total ?? 0}
              incidents={incidents}
              rejections={rejections ?? []}
              streamClock={status.engine.stream_clock}
            />
          </Panel>
          <Panel title="Live streams" sub="SSE with Last-Event-ID resume · keepalive every 15 s never raises anything"
            right={<Link href="/feed" className="text-xs font-semibold text-green-700 hover:underline shrink-0">Signal feed →</Link>}>
            <StreamsPanel streams={status.streams} metrics={metrics} />
          </Panel>
        </div>
      )}
    </div>
  );
}
