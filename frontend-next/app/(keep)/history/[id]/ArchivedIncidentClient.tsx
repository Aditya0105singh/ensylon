"use client";

import Link from "next/link";
import clsx from "clsx";
import { motion } from "motion/react";
import {
  HiArrowLeft, HiArrowRight, HiOutlineBolt, HiOutlineCheckBadge, HiOutlineCheckCircle,
  HiOutlineArrowTrendingUp, HiOutlineArrowsPointingIn, HiOutlineXCircle, HiOutlinePencilSquare,
} from "react-icons/hi2";
import { TbTimeline } from "react-icons/tb";
import { KeepLoader } from "@/shared/ui";
import { useArchivedIncident } from "@/entities/engine/useEngine";
import { PRIORITY_COLOR, SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import type { ArchiveAuditEntry } from "@/entities/engine/types";
import { canonicalSource, cleanTitle } from "../../_overview/lib";
import { ACTION_LABEL, STATUS_META, dayLabel, duration, hhmm, timeToDecision } from "../lib";

const ACTION_ICON: Record<string, { icon: React.ElementType; color: string }> = {
  raised: { icon: HiOutlineBolt, color: "#dc2626" },
  updated: { icon: HiOutlineArrowTrendingUp, color: "#64748b" },
  approve: { icon: HiOutlineCheckBadge, color: "#15803d" },
  edit_and_approve: { icon: HiOutlinePencilSquare, color: "#15803d" },
  reject: { icon: HiOutlineXCircle, color: "#6b7280" },
  resolve: { icon: HiOutlineCheckCircle, color: "#2563eb" },
  merge: { icon: HiOutlineArrowsPointingIn, color: "#2563eb" },
};

const show = (v: unknown) => (Array.isArray(v) ? v.join(" · ") : v == null || v === "" ? "—" : String(v));

function TrailEntry({ a, first }: { a: ArchiveAuditEntry; first: string }) {
  const meta = ACTION_ICON[a.action] ?? ACTION_ICON.updated;
  const Icon = meta.icon;
  const human = a.actor.name !== "engine";
  return (
    <li className="relative pl-9">
      <span className="absolute left-0 top-0 w-7 h-7 rounded-full flex items-center justify-center ring-4 ring-white"
        style={{ background: `${meta.color}18`, color: meta.color }}>
        <Icon className="w-4 h-4" />
      </span>
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-bold text-gray-900">{ACTION_LABEL[a.action] ?? a.action}</span>
        <span className="font-mono text-[11px] text-gray-500">
          {hhmm(a.at)} UTC · {dayLabel(a.at)}
          {a.at !== first && <> · +{duration(Date.parse(a.at) - Date.parse(first))}</>}
        </span>
      </div>
      {human ? (
        <div className="text-xs text-gray-800">
          by <b>{a.actor.name}</b>
          {a.actor.email && <> · <a href={`mailto:${a.actor.email}`} className="text-green-700 hover:underline">{a.actor.email}</a></>}
        </div>
      ) : (
        <div className="text-xs text-gray-500">by the engine</div>
      )}
      {a.note && <p className="mt-0.5 text-xs text-gray-700">{a.note}</p>}
      {a.changes && Object.keys(a.changes).length > 0 && (
        <table className="mt-1.5 w-full text-[11px] border border-gray-100 rounded-lg overflow-hidden">
          <thead className="bg-gray-50 text-gray-600"><tr><th className="px-2 py-1 text-left">field</th><th className="px-2 py-1 text-left">before</th><th className="px-2 py-1 text-left">after</th></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {Object.entries(a.changes).map(([k, v]) => (
              <tr key={k} className="align-top">
                <td className="px-2 py-1 font-mono text-gray-600">{k}</td>
                <td className="px-2 py-1 text-red-800 line-through decoration-red-300">{show(v.before)}</td>
                <td className="px-2 py-1 text-green-800">{show(v.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </li>
  );
}

export function ArchivedIncidentClient({ draftId }: { draftId: string }) {
  const { data: rec, error, isLoading } = useArchivedIncident(draftId);

  if (isLoading) return <div className="p-4"><KeepLoader includeMinHeight={false} loadingText="Loading the incident record..." /></div>;
  if (error || !rec) {
    return (
      <div className="p-4 flex flex-col gap-3">
        <Link href="/history" className="text-sm font-semibold text-green-700 hover:underline inline-flex items-center gap-1"><HiArrowLeft /> Incident history</Link>
        <div className="rounded-xl border border-gray-200 bg-white p-4 text-sm text-gray-700">No archived incident {draftId}.</div>
      </div>
    );
  }

  const color = PRIORITY_COLOR[rec.priority] ?? "#9ca3af";
  const status = STATUS_META[rec.status] ?? STATUS_META.awaiting_review;
  const ttd = timeToDecision(rec);
  const d = rec.detail;
  const first = rec.audit[0]?.at ?? rec.raised_at;
  const timeline = d.timeline ?? [];

  return (
    <div className="flex flex-col gap-4 p-4">
      <Link href="/history" className="text-sm font-semibold text-green-700 hover:underline inline-flex items-center gap-1 w-fit">
        <HiArrowLeft /> Incident history
      </Link>

      <section className="relative overflow-hidden rounded-2xl border bg-white p-5" aria-label="Incident record"
        style={{ borderColor: `${color}55`, boxShadow: `0 1px 2px rgba(16,24,40,.05), 0 16px 36px -24px ${color}88` }}>
        <div className="absolute inset-x-0 top-0 h-1.5" style={{ background: `linear-gradient(90deg, ${color}, ${color}55)` }} />
        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-md px-2 py-0.5 text-xs font-extrabold text-white" style={{ background: color }}>{rec.priority}</span>
              <span className={clsx("rounded-full border px-2 py-0.5 text-[11px] font-bold", status.cls)}>
                {status.label}{rec.ticket_key ? ` · ${rec.ticket_key}` : ""}
              </span>
              <span className="text-[11px] text-gray-500">{dayLabel(rec.started_at)} · first signal {hhmm(rec.started_at)} UTC</span>
            </div>
            <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-gray-900 break-words">{cleanTitle(d.title ?? rec.title)}</h1>
            <p className="mt-1 text-sm text-gray-700">
              {rec.root_cause_service ? <>Probable origin <b>{rec.root_cause_service}</b> · </> : null}
              {rec.affected_services.join(", ")} · {rec.signal_count} signals
            </p>
            <p className="mt-1 text-xs text-gray-600">
              {rec.decided_by
                ? <>Signed off by <b>{rec.decided_by.name}</b>{rec.decided_by.email && <> ({rec.decided_by.email})</>} at {hhmm(rec.decided_at!)} UTC{ttd != null && <>, {duration(ttd)} after it was raised</>}.</>
                : <>No one has signed off yet. Raised {duration(Date.now() - Date.parse(rec.raised_at))} ago.</>}
            </p>
          </div>
          <div className="flex flex-col gap-2 shrink-0 lg:w-56">
            <Link href={`/timemachine?id=${rec.draft_id}`}
              className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-gray-900 hover:bg-black text-white text-sm font-bold px-4 py-2.5">
              <TbTimeline /> Replay how it formed
            </Link>
            {rec.status === "awaiting_review" && (
              <Link href={`/review/${rec.draft_id}`}
                className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-sm font-bold px-4 py-2.5">
                Review and sign off <HiArrowRight />
              </Link>
            )}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            { v: Math.round(rec.severity_score * 100), l: "impact · 0–100" },
            { v: rec.correlation_confidence.toFixed(2), l: "correlation confidence · 0–1" },
            { v: rec.signal_count, l: "signals" },
            { v: ttd != null ? duration(ttd) : "–", l: "time to sign-off" },
          ].map((m) => (
            <div key={m.l} className="rounded-xl bg-gray-50 border border-gray-100 px-3 py-2">
              <div className="text-xl font-extrabold text-gray-900 tabular-nums">{m.v}</div>
              <div className="text-[11px] text-gray-500">{m.l}</div>
            </div>
          ))}
        </div>
      </section>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1.15fr] gap-4 items-start">
        <section className="rounded-2xl border border-gray-100 bg-white p-4" aria-label="Sign-off trail">
          <h2 className="text-sm font-bold text-gray-900">Sign-off trail</h2>
          <p className="text-[11px] text-gray-500 mb-4">Append-only: every action on this incident, who took it, and what they changed.</p>
          <ol className="relative flex flex-col gap-4">
            <span aria-hidden className="absolute left-[13px] top-2 bottom-2 w-px bg-gray-200" />
            {rec.audit.map((a, k) => (
              <motion.div key={a.seq} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: k * 0.06 }}>
                <TrailEntry a={a} first={first} />
              </motion.div>
            ))}
          </ol>
        </section>

        <div className="flex flex-col gap-4 min-w-0">
          <section className="rounded-2xl border border-gray-100 bg-white p-4" aria-label="What was drafted">
            <h2 className="text-sm font-bold text-gray-900">What was drafted</h2>
            <p className="text-[11px] text-gray-500 mb-2">
              The ticket as it stood when it was last decided{d.drafted_by && d.drafted_by !== "template" ? `, prose by ${d.drafted_by}` : ", template prose"}.
            </p>
            <p className="text-sm text-gray-800">{d.summary}</p>
            {d.facts && d.facts.length > 0 && (
              <>
                <div className="mt-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">Observed facts</div>
                <ul className="mt-1 list-disc pl-5 text-xs text-gray-800 space-y-0.5">{d.facts.map((f, k) => <li key={k}>{f}</li>)}</ul>
              </>
            )}
            {d.suspected_root_cause && (
              <p className="mt-3 text-xs text-gray-800"><b>Suspected root cause (hypothesis):</b> {d.suspected_root_cause}</p>
            )}
            {d.investigation_steps?.length > 0 && (
              <>
                <div className="mt-3 text-[11px] font-bold uppercase tracking-wider text-gray-500">Investigation steps</div>
                <ol className="mt-1 list-decimal pl-5 text-xs text-gray-800 space-y-0.5">{d.investigation_steps.map((s, k) => <li key={k}>{s}</li>)}</ol>
              </>
            )}
          </section>

          {timeline.length > 0 && (
            <section className="rounded-2xl border border-gray-100 bg-white p-4" aria-label="How it unfolded">
              <h2 className="text-sm font-bold text-gray-900">How it unfolded</h2>
              <p className="text-[11px] text-gray-500 mb-2">Every signal, labelled with its source stream.</p>
              <ol className="flex flex-col gap-1.5 max-h-72 overflow-y-auto pr-1">
                {timeline.map((t, k) => {
                  const src = canonicalSource(t.source);
                  return (
                    <li key={k} className="flex gap-2 text-xs">
                      <span className="font-mono text-gray-500 w-16 shrink-0">{hhmm(t.at)}</span>
                      <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: SOURCE_COLOR[src] }} />
                      <span className="min-w-0">
                        <b className="text-gray-900">{t.service}</b> <span className="text-gray-500">{SOURCE_NAME[src]}</span>
                        <span className="block text-gray-700 truncate" title={t.detail}>{t.detail}{t.count > 1 ? ` (×${t.count})` : ""}</span>
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
