"use client";

import Link from "next/link";
import { HiChevronRight } from "react-icons/hi2";
import type { QueueSummary, StreamStatus } from "@/entities/engine/types";
import { ANOMALY_THRESHOLD, plural } from "./lib";

type Stage = {
  code: string;
  title: string;
  value: number;
  unit: string;
  lines: string[];
  href: string;
  color: string;
};

/** The five components of the brief, left to right, each with its live count.
 * This is the only place the page shows the pipeline counters, so every
 * number appears once. */
export function PipelineStrip({ status, incidents }: { status: StreamStatus; incidents: QueueSummary[] }) {
  const e = status.engine;
  const recoveries = status.streams.reduce((a, s) => a + (s.skipped ?? 0), 0);
  const redacted = e.redactions ? Object.values(e.redactions).reduce((a, v) => a + v, 0) : null;
  const correlated = incidents.reduce((a, q) => a + q.signal_count, 0);
  const awaiting = incidents.filter((q) => q.status === "awaiting_review").length;
  const approved = incidents.filter((q) => q.status === "published").length;
  const rejected = incidents.filter((q) => q.status === "rejected").length;
  const within = Math.max(0, e.signals_received - e.anomalous);

  const stages: Stage[] = [
    {
      code: "C1",
      title: "Ingest · redact · normalise",
      value: e.signals_received,
      unit: "canonical signals",
      lines: [
        redacted == null ? "PII redacted before processing" : `${plural(redacted, "PII token")} redacted`,
        recoveries > 0 ? `${plural(recoveries, "recovery", "recoveries")} ignored (state OK)` : "recoveries are not symptoms",
        ...(e.deduplicated ? [`${plural(e.deduplicated, "repeat")} folded`] : []),
      ],
      href: "/feed",
      color: "#64748b",
    },
    {
      code: "C2",
      title: "Detect anomalies",
      value: e.anomalous,
      unit: e.anomalous === 1 ? "anomaly" : "anomalies",
      lines: [`${within.toLocaleString("en-US")} within baseline`, `an incident needs one ≥ ${ANOMALY_THRESHOLD.toFixed(2)}`],
      href: "/correlations",
      color: "#d97706",
    },
    {
      code: "C3",
      title: "Correlate",
      value: correlated,
      unit: "signals in incidents",
      lines: [`${e.pending} waiting for a structural partner`, `${e.noise} expired as noise`],
      href: "/correlations",
      color: "#2563eb",
    },
    {
      code: "C4",
      title: "Validate · score",
      value: incidents.length,
      unit: incidents.length === 1 ? "incident accepted" : "incidents accepted",
      lines: [`${e.validation_rejections} rejected by validation`, "impact and confidence scored apart"],
      href: "/correlations",
      color: "#dc2626",
    },
    {
      code: "C5",
      title: "Draft · human review",
      value: awaiting,
      unit: "awaiting a reviewer",
      lines: [`${approved} approved · ${rejected} rejected`, status.claude.enabled ? "drafted by Claude" : "template drafts (Claude off)"],
      href: "/review",
      color: "#15803d",
    },
  ];

  const max = Math.max(1, e.signals_received);
  // Compared with the anomalies a human would otherwise triage one by one, not
  // with every baseline INFO line: nobody reads those, so counting them would
  // inflate the claim.
  const ratio = incidents.length > 0 ? e.anomalous / incidents.length : null;

  return (
    <section
      className="rounded-2xl border border-gray-100 bg-white p-4 min-w-0"
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -16px rgba(16,24,40,.14)" }}
      aria-label="Pipeline"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">From alert flood to reviewed tickets</h2>
          <p className="text-[11px] text-gray-500 mt-0.5">The five components of the brief, live. Click a stage for the detail.</p>
        </div>
        <p className="text-xs text-gray-700">
          <b className="text-gray-900">{e.signals_received.toLocaleString("en-US")}</b> signals in →{" "}
          <b className="text-gray-900">{incidents.length}</b> {incidents.length === 1 ? "incident" : "incidents"} out
          {ratio != null && ratio >= 2 && (
            <span className="ml-1.5 rounded-full bg-green-100 text-green-800 font-bold px-2 py-0.5"
              title={`${e.anomalous} anomalies would each need a look; ${incidents.length} incidents do instead`}>
              {e.anomalous} anomalies → {incidents.length} to triage ({Math.round(ratio)}× fewer)
            </span>
          )}
        </p>
      </header>
      <ol className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
        {stages.map((s, i) => {
          // sqrt keeps a 5-of-1000 stage visible next to the 1000 one
          const width = s.value === 0 ? 0 : Math.max(6, Math.sqrt(s.value / max) * 100);
          return (
            <li key={s.code} className="relative min-w-0">
              <Link
                href={s.href}
                className="pipeline-stage group flex h-full flex-col rounded-xl border border-gray-100 bg-gray-50/60 px-3 py-2.5 hover:border-gray-300 hover:bg-white transition-colors"
                style={{ animationDelay: `${i * 70}ms` }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="rounded px-1.5 py-0.5 text-[10px] font-extrabold text-white" style={{ background: s.color }}>{s.code}</span>
                  <span className="text-[11px] font-bold text-gray-700 truncate">{s.title}</span>
                </div>
                <div className="mt-1.5 flex items-baseline gap-1.5 min-w-0">
                  <span className="text-[26px] leading-none font-extrabold tabular-nums" style={{ color: s.value > 0 ? s.color : "#9ca3af" }}>
                    {s.value.toLocaleString("en-US")}
                  </span>
                  <span className="text-[11px] text-gray-600 truncate">{s.unit}</span>
                </div>
                <div className="mt-2 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden" aria-hidden>
                  <div className="funnel-bar h-full rounded-full" style={{ width: `${width}%`, background: s.color, animationDelay: `${i * 90}ms` }} />
                </div>
                <ul className="mt-2 space-y-0.5">
                  {s.lines.map((l) => (
                    <li key={l} className="text-[11px] text-gray-600 leading-snug">{l}</li>
                  ))}
                </ul>
              </Link>
              {i < stages.length - 1 && (
                <HiChevronRight aria-hidden className="hidden lg:block absolute -right-[13px] top-1/2 -translate-y-1/2 z-10 w-4 h-4 text-gray-400 bg-white rounded-full" />
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
