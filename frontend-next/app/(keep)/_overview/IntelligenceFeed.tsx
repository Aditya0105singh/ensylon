"use client";

import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import type { CanonicalSignal, QueueSummary } from "@/entities/engine/types";
import { SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import { ANOMALY_THRESHOLD, classifySignal, cleanTitle, clockUTC, type SignalClass } from "./lib";

const CLASS_STYLE: Record<SignalClass, { label: string; dot: string; chip: string }> = {
  correlated: { label: "In incident", dot: "bg-blue-600", chip: "bg-blue-50 text-blue-800 border-blue-200" },
  anomaly: { label: "Anomaly", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-800 border-amber-200" },
  normal: { label: "Baseline", dot: "bg-green-500", chip: "bg-green-50 text-green-800 border-green-200" },
};

export function IntelligenceFeed({ signals, incidents }: { signals: CanonicalSignal[]; incidents: QueueSummary[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const rows = signals.map((s) => ({ s, ...classifySignal(s, incidents) }));
  const counts = rows.reduce<Record<SignalClass, number>>(
    (a, r) => ({ ...a, [r.kind]: a[r.kind] + 1 }),
    { correlated: 0, anomaly: 0, normal: 0 }
  );

  if (rows.length === 0) {
    return <p className="text-sm text-gray-600 py-4">No signals yet. Silence raises nothing.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {(Object.keys(CLASS_STYLE) as SignalClass[]).map((k) => (
          <span key={k} className={clsx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold", CLASS_STYLE[k].chip)}>
            <span className={clsx("w-1.5 h-1.5 rounded-full", CLASS_STYLE[k].dot)} />
            {CLASS_STYLE[k].label} {counts[k]}
          </span>
        ))}
      </div>
      <ul className="divide-y divide-gray-100">
        {rows.map(({ s, kind, incident }) => {
          const st = CLASS_STYLE[kind];
          const isOpen = open === s.signal_id;
          const reason = String(s.metadata?.detection_reason ?? "");
          return (
            <li key={s.signal_id} className="feed-row">
              <button
                type="button"
                className="w-full text-left py-1.5 flex items-start gap-2 group"
                onClick={() => setOpen(isOpen ? null : s.signal_id)}
                aria-expanded={isOpen}
              >
                <span className={clsx("mt-1.5 w-2 h-2 rounded-full shrink-0", st.dot)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 text-[11px]">
                    <span className="font-mono text-gray-500">{clockUTC(s.timestamp)}</span>
                    <span className="font-semibold text-gray-900 truncate">{s.service}</span>
                    <span className="rounded px-1 text-[10px] font-semibold text-white shrink-0" style={{ background: SOURCE_COLOR[s.source] ?? "#64748b" }}>
                      {(SOURCE_NAME[s.source] ?? s.source).split(" ")[0]}
                    </span>
                    <span className={clsx("ml-auto font-mono font-bold shrink-0", s.anomaly_score >= ANOMALY_THRESHOLD ? "text-red-700" : "text-gray-400")}>
                      {s.anomaly_score.toFixed(2)}
                    </span>
                  </span>
                  <span className={clsx("block text-[11px] text-gray-700 group-hover:text-gray-900", isOpen ? "break-words" : "truncate")} title={s.evidence}>
                    {s.evidence}
                  </span>
                </span>
              </button>
              {isOpen && (
                <div className="ml-4 mb-2 rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-[11px] text-gray-700 space-y-1">
                  <div className="font-bold text-gray-900">Why this signal matters</div>
                  <div>
                    Anomaly score <b>{s.anomaly_score.toFixed(2)}</b>{" "}
                    {s.anomaly_score >= ANOMALY_THRESHOLD ? `is at or above the ${ANOMALY_THRESHOLD.toFixed(2)} threshold` : `is below the ${ANOMALY_THRESHOLD.toFixed(2)} threshold, so it cannot start an incident`}.
                  </div>
                  {reason && <div>Detector: {reason}</div>}
                  <div>
                    {s.environment ?? "?"} · {s.region ?? "?"} · component {s.component ?? "unknown"} · {s.signal_type}
                  </div>
                  {kind === "correlated" && incident && (
                    <div>
                      Part of <Link href={`/review/${incident.draft_id}`} className="font-semibold text-green-700 hover:underline">{incident.priority} {cleanTitle(incident.title)}</Link>
                    </div>
                  )}
                  {kind === "anomaly" && <div>Not in an incident yet. An anomaly with no structural partner expires as noise after 15 minutes of stream time if none arrives.</div>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
