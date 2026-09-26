"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { toast } from "react-toastify";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  HiArrowRight,
  HiOutlineArrowPath,
  HiOutlineCheckBadge,
  HiOutlineClock,
  HiOutlineShieldCheck,
} from "react-icons/hi2";
import { KeepLoader, EmptyStateCard } from "@/shared/ui";
import { useEngineActions, useEngineAudit, useEngineQueue } from "@/entities/engine/useEngine";
import { SignOffFields, signOffProblem, useReviewer, type Reviewer } from "@/entities/engine/reviewer";
import { PRIORITY_COLOR } from "@/entities/engine/charts";
import type { DraftStatus, QueueSummary } from "@/entities/engine/types";
import { cleanTitle } from "../_overview/lib";

const TABS: { key: DraftStatus; label: string }[] = [
  { key: "awaiting_review", label: "Awaiting sign-off" },
  { key: "published", label: "Approved" },
  { key: "rejected", label: "Rejected" },
  { key: "merged", label: "Merged" },
];

const PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][((n % 100) - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th"}`;

/** Awaiting: most urgent first - priority, then whoever has waited longest.
 * Decided: newest first. */
export function orderQueue(items: QueueSummary[], tab: DraftStatus): QueueSummary[] {
  const list = items.filter((i) => i.status === tab);
  if (tab === "awaiting_review") {
    return list.sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || a.started_at.localeCompare(b.started_at));
  }
  return list.sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/** The same failure coming back is itself a finding: which occurrence is this? */
export function occurrences(items: QueueSummary[]): Map<string, { nth: number; of: number }> {
  const key = (q: QueueSummary) => `${cleanTitle(q.title)}|${q.root_cause_service ?? ""}`;
  const groups = new Map<string, QueueSummary[]>();
  items.forEach((q) => groups.set(key(q), [...(groups.get(key(q)) ?? []), q]));
  const out = new Map<string, { nth: number; of: number }>();
  groups.forEach((g) => {
    [...g].sort((a, b) => a.started_at.localeCompare(b.started_at)).forEach((q, i) => out.set(q.draft_id, { nth: i + 1, of: g.length }));
  });
  return out;
}

function Meter({ label, value, display, color }: { label: string; value: number; display: string; color: string }) {
  return (
    <div className="w-24" title={`${label} ${display}`}>
      <div className="flex items-baseline justify-between text-[10px] text-gray-500">
        <span>{label}</span><b className="text-xs text-gray-900 tabular-nums">{display}</b>
      </div>
      <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mt-0.5">
        <div className="h-full rounded-full" style={{ width: `${Math.min(100, value * 100)}%`, background: color }} />
      </div>
    </div>
  );
}

function Row({ q, occ, reviewer }: { q: QueueSummary; occ?: { nth: number; of: number }; reviewer: Reviewer }) {
  const { approve, reject, merge } = useEngineActions();
  const [busy, setBusy] = useState(false);
  const [merging, setMerging] = useState(false);
  const [into, setInto] = useState("");
  const color = PRIORITY_COLOR[q.priority] ?? "#9ca3af";
  const pending = q.status === "awaiting_review";
  const others = q.affected_services.filter((s) => s !== q.root_cause_service);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    const problem = signOffProblem(reviewer);
    if (problem) { toast.error(`${problem} - every decision is signed with your name and email`); return; }
    setBusy(true);
    try { await fn(); toast.success(ok); setMerging(false); } catch (e: any) { toast.error(e?.message || "Action failed"); } finally { setBusy(false); }
  };

  return (
    <motion.li layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0 }}
      className="rounded-xl border border-gray-100 bg-white hover:border-gray-300 hover:shadow-sm transition-colors overflow-hidden">
      <div className="grid grid-cols-[4px_minmax(0,1fr)] md:grid-cols-[4px_76px_minmax(0,1fr)_auto] gap-x-3 items-center">
        <span className="self-stretch" style={{ background: color }} />
        <div className="hidden md:block py-3">
          <div className="font-mono text-xs text-gray-900">{hhmm(q.started_at)} <span className="text-gray-400">UTC</span></div>
          {pending && <div className="text-[10.5px] font-semibold text-amber-700"><HiOutlineClock className="inline -mt-0.5" /> {ago(Date.now() - Date.parse(q.started_at))}</div>}
        </div>
        <div className="min-w-0 py-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="rounded px-1.5 text-[10px] font-extrabold text-white shrink-0" style={{ background: color }}>{q.priority}</span>
            <Link href={`/review/${encodeURIComponent(q.draft_id)}`} className="text-sm font-bold text-gray-900 truncate hover:underline">{cleanTitle(q.title)}</Link>
            {occ && occ.of > 1 && (
              <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-1.5 text-[10px] font-bold text-violet-800"
                title={`This failure has been raised ${occ.of} times today`}>
                <HiOutlineArrowPath /> {ordinal(occ.nth)} of {occ.of} today
              </span>
            )}
            {q.suppressed && <span className="shrink-0 rounded-full bg-gray-100 px-1.5 text-[10px] font-bold text-gray-600">suppressed</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]">
            {q.root_cause_service && <span className="rounded-full border border-red-200 bg-red-50 px-1.5 font-semibold text-red-800">{q.root_cause_service} · origin</span>}
            {others.length > 0 && <HiArrowRight className="text-gray-400" aria-hidden />}
            {others.slice(0, 4).map((s) => <span key={s} className="rounded-full border border-gray-200 px-1.5 text-gray-600">{s}</span>)}
            {others.length > 4 && <span className="text-gray-500">+{others.length - 4}</span>}
            <span className="text-gray-400 md:hidden">· {hhmm(q.started_at)} UTC</span>
            <span className="text-gray-400">· {q.signal_count} signals · causal {q.causal_confidence}%</span>
          </div>
        </div>
        <div className="col-start-2 md:col-start-auto flex flex-wrap items-center gap-3 pb-3 md:py-3 pr-3">
          <Meter label="impact" value={q.severity_score} display={String(Math.round(q.severity_score * 100))} color={color} />
          <Meter label="confidence" value={q.correlation_confidence} display={q.correlation_confidence.toFixed(2)} color="#2563eb" />
          {pending ? (
            <div className="flex items-center gap-1.5">
              <Link href={`/review/${encodeURIComponent(q.draft_id)}`}
                className="inline-flex items-center gap-1 rounded-lg bg-green-700 hover:bg-green-800 text-white text-xs font-bold px-3 py-1.5">
                Review <HiArrowRight />
              </Link>
              <button disabled={busy} onClick={() => act(() => approve(q.draft_id, reviewer), `Approved - ticket written`)}
                className="rounded-lg border border-green-300 bg-white hover:bg-green-50 text-green-800 text-xs font-semibold px-2.5 py-1.5" aria-label={`Approve ${q.draft_id}`}>
                Approve
              </button>
              <button disabled={busy} onClick={() => act(() => reject(q.draft_id, reviewer, "rejected from review queue"), "Rejected - nothing written")}
                className="rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-semibold px-2.5 py-1.5" aria-label={`Reject ${q.draft_id}`}>
                Reject
              </button>
              <button onClick={() => setMerging(!merging)} aria-expanded={merging}
                className="text-[11px] font-semibold text-gray-500 hover:text-gray-800 underline px-1">Merge…</button>
            </div>
          ) : (
            <div className="text-[11px] min-w-[150px]">
              {q.status === "published" && <span className="inline-flex items-center gap-1 font-bold text-green-800"><HiOutlineCheckBadge /> {q.jira_key}</span>}
              {q.status === "rejected" && <span className="font-bold text-gray-700">Rejected</span>}
              {q.status === "merged" && <span className="font-bold text-blue-800">Merged → {q.merged_into}</span>}
              {q.reviewer && <div className="text-gray-500 truncate max-w-[220px]">by {q.reviewer}</div>}
            </div>
          )}
        </div>
      </div>
      <AnimatePresence initial={false}>
        {merging && (
          <motion.div initial={{ height: 0 }} animate={{ height: "auto" }} exit={{ height: 0 }} className="overflow-hidden">
            <div className="flex flex-wrap items-center gap-2 border-t border-gray-100 bg-gray-50 px-4 py-2">
              <span className="text-xs text-gray-700">Same incident as</span>
              <input value={into} onChange={(e) => setInto(e.target.value)} placeholder="draft id to merge into" aria-label="Merge into"
                className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs font-mono w-60" />
              <button disabled={busy || !into.trim()} onClick={() => act(() => merge(q.draft_id, into.trim(), reviewer, "merged from review queue"), `Merged into ${into.trim()}`)}
                className="rounded-lg bg-gray-800 text-white text-xs font-semibold px-2.5 py-1 disabled:opacity-50">Merge</button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

export default function ReviewPage() {
  const { data: queue, isLoading } = useEngineQueue();
  const { data: audit } = useEngineAudit();
  const [tab, setTab] = useState<DraftStatus>("awaiting_review");
  const { reviewer, setReviewer, problem } = useReviewer();

  // The bell (Topbar) links here with #review-queue; this client component
  // renders after hydration, so do the hash scroll ourselves.
  useEffect(() => {
    if (window.location.hash === "#review-queue") {
      document.getElementById("review-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const items = useMemo(() => queue ?? [], [queue]);
  const list = useMemo(() => orderQueue(items, tab), [items, tab]);
  const occ = useMemo(() => occurrences(items), [items]);
  const awaiting = items.filter((i) => i.status === "awaiting_review");
  const oldest = awaiting.length ? Math.min(...awaiting.map((i) => Date.parse(i.started_at))) : null;
  const decisions = (audit ?? []).filter((a) => ["approve", "edit_and_approve", "reject", "merge", "resolve"].includes(a.action)).slice(-8).reverse();

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-4 p-4">
        <header className="flex flex-col lg:flex-row lg:items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-extrabold tracking-tight text-gray-900">Incidents &amp; review</h1>
            <p className="text-sm text-gray-600 max-w-2xl">
              Every incident the engine raised, most urgent first. Nothing is written to output/tickets/ until a named reviewer signs off.
            </p>
          </div>
          <div className={clsx("rounded-xl border px-3 py-2", problem ? "border-amber-200 bg-amber-50" : "border-green-200 bg-green-50")}>
            <div className={clsx("text-[10.5px] font-bold uppercase tracking-wider mb-1", problem ? "text-amber-800" : "text-green-800")}>
              <HiOutlineShieldCheck className="inline -mt-0.5 mr-1" />{problem ? "Sign off as - required to decide" : "Signing off as"}
            </div>
            <SignOffFields reviewer={reviewer} onChange={setReviewer} />
          </div>
        </header>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2" aria-label="Queue summary">
          {[
            { v: awaiting.length, l: "awaiting sign-off", accent: awaiting.length ? "#b45309" : undefined },
            { v: awaiting.filter((i) => i.priority === "P1").length, l: "P1 waiting", accent: "#dc2626" },
            { v: oldest ? ago(Date.now() - oldest) : "–", l: "longest wait" },
            { v: items.filter((i) => i.status === "published").length, l: "approved" },
          ].map((s) => (
            <div key={s.l} className="rounded-xl border border-gray-100 bg-white px-4 py-3">
              <div className="text-2xl font-extrabold tabular-nums leading-tight" style={{ color: s.accent ?? "#111827" }}>{s.v}</div>
              <div className="text-[11px] text-gray-500">{s.l}</div>
            </div>
          ))}
        </div>

        <section id="review-queue" aria-label="Review queue" className="scroll-mt-20">
          <div className="flex flex-wrap gap-1 mb-3" role="group" aria-label="Status">
            {TABS.map((t) => {
              const n = items.filter((i) => i.status === t.key).length;
              const on = tab === t.key;
              return (
                <button key={t.key} onClick={() => setTab(t.key)} aria-pressed={on}
                  className={clsx("relative rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors", on ? "text-white" : "bg-white border border-gray-200 text-gray-600 hover:bg-gray-50")}>
                  {on && <motion.span layoutId="queue-tab" className="absolute inset-0 rounded-lg bg-green-700" transition={{ type: "spring", stiffness: 500, damping: 38 }} />}
                  <span className="relative">{t.label} <span className="opacity-70">({n})</span></span>
                </button>
              );
            })}
          </div>

          {isLoading ? (
            <KeepLoader includeMinHeight={false} loadingText="Loading queue..." />
          ) : list.length === 0 ? (
            <EmptyStateCard icon={HiOutlineShieldCheck} title="Nothing here"
              description={tab === "awaiting_review"
                ? "No incidents awaiting review. Drafts appear here when the live streams produce a validated correlation."
                : `No incidents are ${TABS.find((t) => t.key === tab)?.label.toLowerCase()}.`} />
          ) : (
            <ul className="flex flex-col gap-2">
              <AnimatePresence initial={false}>
                {list.map((q) => <Row key={q.draft_id} q={q} occ={occ.get(q.draft_id)} reviewer={reviewer} />)}
              </AnimatePresence>
            </ul>
          )}
        </section>

        {decisions.length > 0 && (
          <section aria-label="Recent decisions" className="rounded-2xl border border-gray-100 bg-white p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-bold text-gray-900">Recent decisions</h2>
              <Link href="/history" className="text-xs font-semibold text-green-700 hover:underline">Full incident history →</Link>
            </div>
            <ul className="mt-2 font-mono text-xs text-gray-700 space-y-0.5">
              {decisions.map((e, i) => (
                <li key={i}>
                  <span className="text-gray-400">{hhmm(e.at)}</span> <span className="text-green-700">{e.action}</span> {e.draft_id} · {e.actor}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </MotionConfig>
  );
}
