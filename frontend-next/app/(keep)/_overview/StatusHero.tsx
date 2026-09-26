"use client";

import Link from "next/link";
import clsx from "clsx";
import {
  HiArrowRight,
  HiOutlineBellAlert,
  HiOutlineExclamationTriangle,
  HiOutlineShieldCheck,
} from "react-icons/hi2";
import type { QueueSummary, StreamStatus } from "@/entities/engine/types";
import { PRIORITY_COLOR } from "@/entities/engine/charts";
import { cleanTitle, clockUTC, formatDuration, impact, plural, quietReason } from "./lib";

const STREAM_SHORT: Record<string, string> = {
  "aiops-logs": "Application logs",
  "aiops-cloudwatch": "CloudWatch",
  "aiops-grafana": "Grafana",
};

/** The first thing on the page, and it changes with the situation:
 *  - a human owes a decision  -> what, how bad, and one button to decide;
 *  - nothing to decide        -> "all clear", and why the engine raised nothing;
 *  - a stream is down         -> said plainly, whichever of the above applies. */
export function StatusHero({ status, incidents }: { status: StreamStatus; incidents: QueueSummary[] }) {
  const e = status.engine;
  const awaiting = incidents.filter((q) => q.status === "awaiting_review");
  const down = status.streams.filter((s) => !s.connected);
  const top = awaiting[0];
  const decided = incidents.filter((q) => q.status === "published" || q.status === "rejected");

  const clock = e.stream_clock ? `stream clock ${clockUTC(e.stream_clock)} UTC` : "waiting for the first event";
  const meta = (
    <div className="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] text-gray-500">
      <span>{clock}</span>
      <span>watching for {formatDuration(status.uptime_seconds)}</span>
      <span>{status.claude.enabled ? `drafts by Claude (${status.claude.model})` : "drafts by template (no Claude key)"}</span>
    </div>
  );

  const degraded = down.length > 0 && (
    <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" role="status">
      <HiOutlineExclamationTriangle className="mt-0.5 shrink-0" />
      <span>
        <b>{down.map((s) => STREAM_SHORT[s.name] ?? s.name).join(" and ")}</b> {down.length === 1 ? "is" : "are"} reconnecting.
        It resumes from its Last-Event-ID, so no signal is lost; incidents may form late until it is back.
      </span>
    </div>
  );

  if (top) {
    const color = PRIORITY_COLOR[top.priority] ?? "#dc2626";
    const downstream = top.affected_services.filter((s) => s !== top.root_cause_service);
    return (
      <section
        className="hero-card relative overflow-hidden rounded-2xl border px-5 py-5 md:px-6"
        style={{
          borderColor: `${color}55`,
          background: `linear-gradient(120deg, ${color}14 0%, #ffffff 55%, ${color}0a 100%)`,
          boxShadow: `0 1px 2px rgba(16,24,40,.05), 0 16px 36px -22px ${color}aa`,
        }}
        aria-label="Needs a decision"
      >
        <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold text-white" style={{ background: color }}>
                <HiOutlineBellAlert className="attention-bell" /> {plural(awaiting.length, "incident")} {awaiting.length === 1 ? "needs" : "need"} your decision
              </span>
              {meta}
            </div>
            <h1 className="mt-2 text-2xl md:text-[28px] font-extrabold tracking-tight text-gray-900 break-words">
              <span style={{ color }}>{top.priority}</span> · {cleanTitle(top.title)}
            </h1>
            <p className="mt-1.5 text-sm text-gray-700">
              {top.root_cause_service ? <>Probable origin <b>{top.root_cause_service}</b></> : "Origin not yet ranked"}
              {downstream.length > 0 && <> → {downstream.join(" · ")}</>}
              {" · "}first signal {clockUTC(top.started_at)} UTC
              {" · "}impact <b>{impact(top)}</b>/100, confidence <b>{top.correlation_confidence.toFixed(2)}</b>
            </p>
            <p className="mt-1 text-xs text-gray-500">Nothing is written to output/tickets/ until a named reviewer approves it.</p>
            {degraded}
          </div>
          <div className="flex flex-col items-stretch gap-1.5 shrink-0 lg:w-[220px]">
            <Link
              href={`/review/${top.draft_id}`}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl text-white text-sm font-bold px-4 py-3 shadow-sm transition-transform hover:-translate-y-0.5"
              style={{ background: color }}
            >
              Review {top.priority} now <HiArrowRight />
            </Link>
            {awaiting.length > 1 && (
              <Link href="/review" className="text-center text-xs font-semibold text-gray-700 hover:underline">
                +{awaiting.length - 1} more waiting
              </Link>
            )}
          </div>
        </div>
      </section>
    );
  }

  const last = decided[0];
  return (
    <section
      className="hero-card relative overflow-hidden rounded-2xl border border-green-100 px-5 py-5 md:px-6"
      style={{
        background: "linear-gradient(120deg,#f0fdf4 0%,#ffffff 55%,#ecfdf5 100%)",
        boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 12px 32px -18px rgba(22,163,74,.35)",
      }}
      aria-label="All clear"
    >
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-24 w-72 h-72 rounded-full bg-green-200/40 blur-3xl" />
      <div className="relative flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="min-w-0 flex gap-4">
          <span className="hidden sm:flex shrink-0 w-14 h-14 rounded-2xl bg-green-600 text-white items-center justify-center shadow-sm">
            <HiOutlineShieldCheck className="w-8 h-8" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold bg-green-100 text-green-800 border border-green-200">
                <span className="w-1.5 h-1.5 rounded-full bg-green-600 animate-pulse" /> Nothing needs a human
              </span>
              {meta}
            </div>
            <h1 className="mt-2 text-2xl md:text-[28px] font-extrabold tracking-tight text-gray-900">
              All clear · {e.signals_received.toLocaleString("en-US")} signals checked, {plural(incidents.length, "incident")} raised
            </h1>
            <p className="mt-1.5 text-sm text-gray-700 max-w-3xl">{quietReason(e)}</p>
            {degraded}
          </div>
        </div>
        {last && (
          <Link
            href={`/review/${last.draft_id}`}
            className="shrink-0 lg:w-[240px] rounded-xl border border-gray-200 bg-white/90 px-3 py-2.5 hover:border-gray-300 transition-colors"
          >
            <div className="text-[10.5px] font-bold uppercase tracking-wider text-gray-500">Last decision</div>
            <div className="text-xs font-bold text-gray-900 truncate mt-0.5">{last.priority} · {cleanTitle(last.title)}</div>
            <div className={clsx("text-[11px] font-semibold", last.status === "published" ? "text-green-700" : "text-gray-600")}>
              {last.status === "published" ? `approved${last.reviewer ? ` by ${last.reviewer}` : ""}` : `rejected${last.reviewer ? ` by ${last.reviewer}` : ""}`}
            </div>
          </Link>
        )}
      </div>
    </section>
  );
}
