"use client";

import Link from "next/link";
import { HiOutlineArrowRight } from "react-icons/hi2";
import { useEngineQueue, useEngineReport } from "./useEngine";

/**
 * Latest engine run, in the same eight-stage order the pipeline executes. Every
 * number is read from the run's own report, so this and the incident page can
 * never disagree. Overview shows this or the loaded dataset's KPIs, never both
 * at once — they are different runs with different totals.
 */
export function EngineRunCard() {
  const { data: report } = useEngineReport();
  const { data: queue } = useEngineQueue();
  if (!report || !report.scenario) return null;

  const pending = (queue ?? []).filter((q) => q.status === "awaiting_review");
  const target = (queue ?? [])[0];
  const stages = [
    { n: report.signals_ingested, label: "ingested" },
    { n: report.unique_signals, label: "unique after dedup" },
    { n: report.anomalies_detected, label: "anomalous" },
    { n: report.incidents_formed, label: "incidents" },
    { n: report.drafts_created, label: "ticket drafts" },
    { n: pending.length, label: "awaiting review" },
    { n: report.auto_published, label: "auto-published", good: true },
  ];
  return (
    <div
      className="kpi-card rounded-2xl border border-green-200 p-4"
      style={{ background: "linear-gradient(120deg,#ecfdf5,#ffffff)", boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(22,163,74,.25)" }}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div>
          <div className="text-sm font-bold text-gray-900">Latest engine run</div>
          <div className="text-xs text-gray-600">
            Live pipeline on injected telemetry: {report.scenario}.
          </div>
        </div>
        {target && (
          <Link
            href={`/review/${encodeURIComponent(target.draft_id)}`}
            className="inline-flex items-center gap-1 text-xs font-semibold text-white bg-green-700 hover:bg-green-800 rounded-lg px-3 py-1.5"
          >
            Investigate the incident <HiOutlineArrowRight size={13} />
          </Link>
        )}
      </div>
      <div className="flex flex-wrap items-stretch gap-1.5">
        {stages.map((s, i) => (
          <div key={s.label} className="flex items-center gap-1.5">
            <div className={"rounded-xl border px-3 py-2 min-w-[6.5rem] " + (s.good ? "bg-green-700 border-green-700 text-white" : "bg-white border-gray-200")}>
              <div className="text-xl font-extrabold tabular-nums leading-none">{s.n}</div>
              <div className={"text-[11px] mt-1 " + (s.good ? "text-green-50" : "text-gray-700")}>{s.label}</div>
            </div>
            {i < stages.length - 1 && <span className="text-gray-300">›</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
