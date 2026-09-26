"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { motion } from "motion/react";
import { TbHistory } from "react-icons/tb";
import { HiMagnifyingGlass, HiOutlineCheckBadge, HiOutlineClock } from "react-icons/hi2";
import { EmptyStateCard, KeepLoader, PageHero } from "@/shared/ui";
import { useIncidentHistory } from "@/entities/engine/useEngine";
import { PRIORITY_COLOR } from "@/entities/engine/charts";
import type { ArchivedIncident } from "@/entities/engine/types";
import { cleanTitle } from "../_overview/lib";
import { STATUS_META, duration, groupByDay, hhmm, median, timeToDecision } from "./lib";

const RANGES = [
  { label: "Last 24 h", hours: 24 },
  { label: "7 days", hours: 24 * 7 },
  { label: "30 days", hours: 24 * 30 },
  { label: "All", hours: null },
] as const;

const STATUSES = [
  { label: "All", value: null },
  { label: "Awaiting sign-off", value: "awaiting_review" },
  { label: "Approved", value: "published" },
  { label: "Rejected", value: "rejected" },
  { label: "Merged", value: "merged" },
] as const;

function Stat({ value, label, hint }: { value: React.ReactNode; label: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-gray-100 bg-white px-4 py-3" title={hint}>
      <div className="text-2xl font-extrabold text-gray-900 tabular-nums leading-tight">{value}</div>
      <div className="text-[11px] text-gray-500">{label}</div>
    </div>
  );
}

function Row({ i }: { i: ArchivedIncident }) {
  const color = PRIORITY_COLOR[i.priority] ?? "#9ca3af";
  const status = STATUS_META[i.status] ?? STATUS_META.awaiting_review;
  const ttd = timeToDecision(i);
  const services = [i.root_cause_service, ...i.affected_services.filter((s) => s !== i.root_cause_service)].filter(Boolean) as string[];
  return (
    <li>
      <Link href={`/history/${i.draft_id}`}
        className="group grid grid-cols-[4px_64px_minmax(0,1fr)] md:grid-cols-[4px_64px_minmax(0,1fr)_minmax(0,300px)] gap-x-3 rounded-xl border border-gray-100 bg-white py-2.5 pr-3 hover:border-gray-300 hover:shadow-sm transition-all">
        <span className="-my-2.5 rounded-l-xl" style={{ background: color }} />
        <div className="pt-0.5">
          <div className="font-mono text-xs text-gray-900">{hhmm(i.started_at)}</div>
          <div className="text-[10px] text-gray-500">UTC</div>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="rounded px-1.5 text-[10px] font-extrabold text-white shrink-0" style={{ background: color }}>{i.priority}</span>
            <span className="text-sm font-bold text-gray-900 truncate group-hover:underline">{cleanTitle(i.title)}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
            {services.slice(0, 5).map((s, k) => (
              <span key={s} className={clsx("rounded-full border px-1.5",
                k === 0 && i.root_cause_service ? "border-red-200 bg-red-50 text-red-800 font-semibold" : "border-gray-200 text-gray-600")}>
                {s}{k === 0 && i.root_cause_service ? " · origin" : ""}
              </span>
            ))}
            {services.length > 5 && <span className="text-gray-500">+{services.length - 5}</span>}
            <span className="text-gray-400">· {i.signal_count} signals · impact {Math.round(i.severity_score * 100)} · confidence {i.correlation_confidence.toFixed(2)}</span>
          </div>
        </div>
        <div className="col-start-3 md:col-start-auto mt-2 md:mt-0 text-[11px] min-w-0">
          <span className={clsx("inline-block rounded-full border px-2 py-0.5 font-bold", status.cls)}>
            {status.label}{i.ticket_key ? ` · ${i.ticket_key}` : ""}
          </span>
          {i.decided_by ? (
            <div className="mt-1 text-gray-700 truncate">
              <HiOutlineCheckBadge className="inline -mt-0.5 mr-1 text-green-700" />
              <b className="text-gray-900">{i.decided_by.name}</b>
              {i.decided_by.email && <span className="text-gray-500"> · {i.decided_by.email}</span>}
            </div>
          ) : null}
          <div className="text-gray-500">
            {i.decided_at && ttd != null
              ? <>signed off {hhmm(i.decided_at)} UTC, {duration(ttd)} after it was raised</>
              : <><HiOutlineClock className="inline -mt-0.5 mr-1" />waiting {duration(Date.now() - Date.parse(i.raised_at))}</>}
          </div>
        </div>
      </Link>
    </li>
  );
}

/** Every incident the engine raised, across restarts and days: what broke, how
 * it was scored, and who signed off - for the review the day after. */
export function HistoryClient() {
  const [range, setRange] = useState<number | null>(24 * 7);
  const [status, setStatus] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const { data, isLoading, error } = useIncidentHistory({ hours: range, status, q });

  const items = useMemo(() => data ?? [], [data]);
  const groups = useMemo(() => groupByDay(items), [items]);
  const decided = items.filter((i) => i.decided_at);
  const med = median(decided.map((i) => timeToDecision(i)!).filter((v) => v != null));

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={TbHistory}
        title="Incident history"
        subtitle="Every incident the streams raised, how it was scored, and who signed off with their name and email. Kept across restarts and days, for the review the morning after."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-xl border border-gray-200 bg-white p-0.5 text-xs font-bold" role="group" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r.label} onClick={() => setRange(r.hours)} aria-pressed={range === r.hours}
              className={clsx("relative rounded-lg px-3 py-1.5 transition-colors", range === r.hours ? "text-white" : "text-gray-600 hover:bg-gray-50")}>
              {range === r.hours && <motion.span layoutId="history-range" className="absolute inset-0 rounded-lg bg-gray-900" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
              <span className="relative">{r.label}</span>
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Status">
          {STATUSES.map((s) => (
            <button key={s.label} onClick={() => setStatus(s.value)} aria-pressed={status === s.value}
              className={clsx("rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors",
                status === s.value ? "bg-green-700 text-white border-green-700" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50")}>
              {s.label}
            </button>
          ))}
        </div>
        <label className="ml-auto relative">
          <HiMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, service, reviewer name or email"
            aria-label="Search incident history"
            className="rounded-xl border border-gray-300 bg-white pl-8 pr-3 py-1.5 text-sm w-72 focus:outline-none focus:border-green-500" />
        </label>
      </div>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2" aria-label="Summary">
          <Stat value={items.length} label="incidents" />
          <Stat value={items.filter((i) => i.priority === "P1").length} label="P1" />
          <Stat value={<>{decided.length}<span className="text-base text-gray-400">/{items.length}</span></>} label="signed off by a named reviewer" />
          <Stat value={med == null ? "–" : duration(med)} label="median time to sign-off" hint="From the engine raising an incident to a human deciding it" />
        </div>
      )}

      {isLoading ? (
        <KeepLoader includeMinHeight={false} loadingText="Loading incident history..." />
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          Could not load the incident history from the backend.
        </div>
      ) : items.length === 0 ? (
        <EmptyStateCard icon={TbHistory} title="No incidents in this range"
          description="Incidents are archived as soon as the live streams raise them, and every sign-off is added to their trail." />
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map((g) => (
            <section key={g.day} aria-label={g.day}>
              <h2 className="sticky top-12 z-10 mb-2 inline-flex items-center gap-2 rounded-full bg-gray-50/95 px-2 py-0.5 text-xs font-bold uppercase tracking-wider text-gray-600">
                {g.day}
                <span className="rounded-full bg-gray-200 px-1.5 text-[10px] text-gray-700">{g.items.length}</span>
              </h2>
              <ul className="flex flex-col gap-2">
                {g.items.map((i) => <Row key={i.draft_id} i={i} />)}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
