"use client";

import { useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { HiOutlineShieldExclamation } from "react-icons/hi2";
import type { CanonicalSignal, QueueSummary, ValidationRejection } from "@/entities/engine/types";
import { SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import { ANOMALY_THRESHOLD, PENDING_WINDOW_MIN, anomalyFate, cleanTitle, clockUTC, type AnomalyFate } from "./lib";

function FateBadge({ fate }: { fate: AnomalyFate }) {
  if (fate.kind === "incident") {
    return (
      <span className="rounded-full border border-blue-200 bg-blue-50 text-blue-800 px-2 py-0.5 text-[10.5px] font-bold whitespace-nowrap">
        in {fate.incident.priority} incident
      </span>
    );
  }
  if (fate.kind === "waiting") {
    return (
      <span className="rounded-full border border-amber-200 bg-amber-50 text-amber-800 px-2 py-0.5 text-[10.5px] font-bold whitespace-nowrap">
        waiting · {fate.minutesLeft} min left
      </span>
    );
  }
  return (
    <span className="rounded-full border border-gray-200 bg-gray-50 text-gray-600 px-2 py-0.5 text-[10.5px] font-bold whitespace-nowrap">
      expired as noise
    </span>
  );
}

function explain(fate: AnomalyFate): React.ReactNode {
  if (fate.kind === "incident") {
    return (
      <>
        Joined <Link href={`/review/${fate.incident.draft_id}`} className="font-semibold text-green-700 hover:underline">
          {fate.incident.priority} {cleanTitle(fate.incident.title)}
        </Link> on structural evidence.
      </>
    );
  }
  if (fate.kind === "waiting") {
    return `No partner with a shared service, dependency edge, component or template yet. It waits ${PENDING_WINDOW_MIN} minutes of stream time, then expires as noise.`;
  }
  return `Nothing structurally related arrived within ${PENDING_WINDOW_MIN} minutes, so it was dropped. Arriving at the same time as other signals is not enough.`;
}

/** Every anomaly the detector flagged, and what the engine did with it. This is
 * the page's proof that time proximity alone never raises an incident. */
export function AnomalyLedger({
  anomalies,
  total,
  incidents,
  rejections,
  streamClock,
}: {
  anomalies: CanonicalSignal[];
  total: number;
  incidents: QueueSummary[];
  rejections: ValidationRejection[];
  streamClock: string | null;
}) {
  const [open, setOpen] = useState<string | null>(null);
  // The backend filters to flagged signals; filter again so an older backend
  // that ignores the parameter cannot put baseline signals in this list.
  const rows = anomalies
    .filter((s) => s.metadata?.is_anomaly === true || s.anomaly_score >= ANOMALY_THRESHOLD)
    .map((s) => ({ s, fate: anomalyFate(s, incidents, streamClock) }));

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="text-sm text-gray-600 py-3">No anomalies yet. Every signal so far is within its baseline.</p>
      ) : (
        <ul className="divide-y divide-gray-100" aria-label="Anomalies">
          {rows.map(({ s, fate }) => {
            const isOpen = open === s.signal_id;
            const reason = String(s.metadata?.detection_reason ?? "");
            return (
              <li key={s.signal_id} className="feed-row">
                <button
                  type="button"
                  className="w-full text-left py-2 flex items-start gap-2.5 group"
                  onClick={() => setOpen(isOpen ? null : s.signal_id)}
                  aria-expanded={isOpen}
                >
                  <span
                    className={clsx("font-mono text-[11px] font-bold tabular-nums w-9 shrink-0 mt-0.5",
                      s.anomaly_score >= ANOMALY_THRESHOLD ? "text-red-700" : "text-amber-700")}
                    title={s.anomaly_score >= ANOMALY_THRESHOLD ? "can anchor an incident" : "can join an incident, cannot anchor one"}
                  >
                    {s.anomaly_score.toFixed(2)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[11px] min-w-0">
                      <span className="font-mono text-gray-500 shrink-0">{clockUTC(s.timestamp)}</span>
                      <span className="font-semibold text-gray-900 truncate">{s.service}</span>
                      <span className="rounded px-1 text-[10px] font-semibold text-white shrink-0" style={{ background: SOURCE_COLOR[s.source] ?? "#64748b" }}>
                        {(SOURCE_NAME[s.source] ?? s.source).split(" ")[0]}
                      </span>
                      <span className="ml-auto shrink-0"><FateBadge fate={fate} /></span>
                    </span>
                    <span className={clsx("block text-[11px] text-gray-700 group-hover:text-gray-900 mt-0.5", isOpen ? "break-words" : "truncate")} title={s.evidence}>
                      {s.evidence}
                    </span>
                  </span>
                </button>
                {isOpen && (
                  <div className="ml-11 mb-2 rounded-lg border border-gray-100 bg-gray-50 p-2.5 text-[11px] text-gray-700 space-y-1">
                    {reason && <div><b className="text-gray-900">Why it is anomalous:</b> {reason}</div>}
                    <div><b className="text-gray-900">What happened:</b> {explain(fate)}</div>
                    <div className="text-gray-500">
                      {s.environment ?? "?"} · {s.region ?? "?"} · component {s.component ?? "unknown"} · {s.signal_type}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {total > rows.length && (
        <Link href="/feed" className="text-[11px] font-semibold text-green-700 hover:underline">
          {total - rows.length} older anomalies in the signal feed →
        </Link>
      )}

      <div className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
        <h3 className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-gray-600">
          <HiOutlineShieldExclamation className="text-amber-600" /> Refused by validation (C4)
        </h3>
        {rejections.length === 0 ? (
          <p className="mt-1 text-[11px] text-gray-600">None so far. Every candidate passed all five checks: environment, weak bridge, coherence, anomaly support and independent evidence.</p>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {rejections.slice(0, 4).map((r, i) => (
              <li key={`${r.at}-${i}`} className="text-[11px] text-gray-700">
                <b className="text-gray-900">{r.services.join(" + ")}</b> ({r.signals} {r.signals === 1 ? "signal" : "signals"}):{" "}
                {r.failed.map((f) => `${f.name}: ${f.detail}`).join("; ")}
              </li>
            ))}
            {rejections.length > 4 && <li className="text-[11px] text-gray-500">+{rejections.length - 4} more</li>}
          </ul>
        )}
      </div>
    </div>
  );
}
