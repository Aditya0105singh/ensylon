"use client";

import { useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "react-toastify";
import clsx from "clsx";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import {
  HiArrowLeft,
  HiArrowRight,
  HiOutlineCheckBadge,
  HiOutlineExclamationTriangle,
  HiOutlineLightBulb,
  HiOutlineLockClosed,
  HiOutlineNoSymbol,
  HiOutlinePaperAirplane,
  HiOutlinePencilSquare,
  HiOutlineXCircle,
} from "react-icons/hi2";
import { TbTimeline } from "react-icons/tb";
import { KeepLoader, EmptyStateCard } from "@/shared/ui";
import {
  useArchivedIncident,
  useEngineActions,
  useEngineAudit,
  useEngineDraft,
  useEngineEvidence,
  useEngineFeedback,
} from "@/entities/engine/useEngine";
import { SignOffFields, useReviewer } from "@/entities/engine/reviewer";
import { PRIORITY_COLOR, SOURCE_COLOR } from "@/entities/engine/charts";
import type { DraftDetail, Evidence, EvidenceSignal } from "@/entities/engine/types";
import { Gauge } from "../../_overview/Gauge";
import { DIMENSIONS, canonicalSource, cleanTitle, propagationPath } from "../../_overview/lib";

const SOURCE_LABEL: Record<string, string> = {
  cloudwatch_metrics: "CloudWatch metric",
  application_logs: "App log",
  grafana_alerts: "Grafana alert",
  cloudwatch_metric: "CloudWatch metric",
  cloudwatch_log: "CloudWatch logs",
  grafana_alert: "Grafana alert",
  trace_span: "OTel trace",
  app_log: "App log",
  otel_log: "OTel log",
};

const clock = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  awaiting_review: { text: "Awaiting human review", cls: "bg-amber-100 text-amber-900 border-amber-200" },
  published: { text: "Approved · ticket written", cls: "bg-green-100 text-green-800 border-green-200" },
  rejected: { text: "Rejected", cls: "bg-gray-100 text-gray-700 border-gray-200" },
  merged: { text: "Merged", cls: "bg-blue-50 text-blue-800 border-blue-200" },
};

function Section({ title, sub, right, children, className, id }: {
  title: string; sub?: string; right?: React.ReactNode; children: React.ReactNode; className?: string; id?: string;
}) {
  return (
    <section id={id} aria-label={title} className={clsx("rounded-2xl border border-gray-100 bg-white p-4 min-w-0 scroll-mt-44", className)}
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -16px rgba(16,24,40,.14)" }}>
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

const Tag = ({ kind }: { kind: "computed" | "ai" }) => (
  <span className={clsx("text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full",
    kind === "computed" ? "bg-green-100 text-green-800" : "bg-violet-100 text-violet-800")}>
    {kind === "computed" ? "Computed" : "AI-generated"}
  </span>
);

// --------------------------------------------------------------------------
// 1. decision bar: what it is, how bad, and the decision - always in reach
// --------------------------------------------------------------------------

type EditState = { title: string; priority: string; summary: string; suspected_root_cause: string; investigation_steps: string };

function useDecision(draftId: string, draft: DraftDetail | undefined) {
  const { approve, reject, resolve } = useEngineActions();
  const { reviewer, setReviewer, problem } = useReviewer();
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState("");

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (problem) {
      toast.error(`${problem} - every decision is signed with your name and email`);
      return;
    }
    setBusy(true);
    try {
      await fn();
      toast.success(ok);
      setEdit(null);
      setRejecting(false);
    } catch (e: any) {
      toast.error(e?.message || "Action failed");
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => draft && setEdit({
    title: draft.title, priority: draft.priority, summary: draft.summary,
    suspected_root_cause: draft.suspected_root_cause ?? "", investigation_steps: draft.investigation_steps.join("\n"),
  });

  const changedFields = (e: EditState) => {
    if (!draft) return {};
    const steps = e.investigation_steps.split("\n").map((s) => s.trim()).filter(Boolean);
    const out: Record<string, unknown> = {};
    if (e.title.trim() !== draft.title) out.title = e.title.trim();
    if (e.priority !== draft.priority) out.priority = e.priority;
    if (e.summary.trim() !== draft.summary) out.summary = e.summary.trim();
    if (e.suspected_root_cause.trim() !== (draft.suspected_root_cause ?? "")) out.suspected_root_cause = e.suspected_root_cause.trim();
    if (steps.join("\n") !== draft.investigation_steps.join("\n")) out.investigation_steps = steps;
    return out;
  };

  return {
    reviewer, setReviewer, busy, edit, setEdit, rejecting, setRejecting, note, setNote, startEdit,
    approve: () => act(() => approve(draftId, reviewer), "Approved - ticket written"),
    approveEdited: () => {
      if (!edit) return;
      const edits = changedFields(edit);
      const any = Object.keys(edits).length > 0;
      return act(() => approve(draftId, reviewer, any ? edits : undefined), any ? "Edited and approved - ticket written" : "Approved - ticket written");
    },
    reject: () => act(() => reject(draftId, reviewer, note.trim() || "rejected by reviewer"), "Rejected - nothing written"),
    resolve: () => act(() => resolve(draftId, reviewer), "Marked resolved"),
  };
}

type Decision = ReturnType<typeof useDecision>;

function DecisionBar({ draft, ev, d, raisedAt, onEdit }: {
  draft: DraftDetail; ev: Evidence; d: Decision; raisedAt: string | null; onEdit: () => void;
}) {
  const color = PRIORITY_COLOR[draft.priority] ?? "#9ca3af";
  const status = STATUS_LABEL[draft.status] ?? STATUS_LABEL.awaiting_review;
  const pending = draft.status === "awaiting_review";
  const published = draft.status === "published";
  const streams = new Set(ev.signals.map((s) => canonicalSource(s.source))).size;
  const firstAt = ev.signals.length ? [...ev.signals].sort((a, b) => a.at.localeCompare(b.at))[0].at : draft.started_at;

  return (
    <section aria-label="Decision" className="sticky top-14 z-20 rounded-2xl border bg-white/95 backdrop-blur px-4 py-3"
      style={{ borderColor: `${color}55`, boxShadow: `0 1px 2px rgba(16,24,40,.06), 0 14px 32px -22px ${color}aa` }}>
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <Link href="/review" className="inline-flex items-center gap-1 font-semibold text-gray-500 hover:text-green-700">
              <HiArrowLeft /> Review queue
            </Link>
            <span className="rounded-md px-2 py-0.5 text-xs font-extrabold text-white" style={{ background: color }}>{draft.priority}</span>
            <span className={clsx("rounded-full border px-2 py-0.5 font-bold", status.cls)}>{status.text}</span>
            {draft.lifecycle === "resolved" && <span className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 font-bold text-blue-800">Resolved</span>}
          </div>
          <h1 className="mt-1 text-xl md:text-2xl font-extrabold tracking-tight text-gray-900 break-words">{cleanTitle(draft.title)}</h1>
          <p className="text-xs text-gray-600">
            first signal {clock(firstAt)} UTC
            {raisedAt && <> · raised {ago(Date.parse(raisedAt) - Date.parse(firstAt)) === "under a minute" ? "within a minute" : `${ago(Date.parse(raisedAt) - Date.parse(firstAt))} later`}</>}
            {pending && raisedAt && <> · <b className="text-amber-800">waiting {ago(Date.now() - Date.parse(raisedAt))}</b></>}
            {" · "}{ev.unique_signals} signals from {streams} stream{streams === 1 ? "" : "s"}
            {draft.updates > 0 && <> · {draft.updates} late</>}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <div className="w-24"><Gauge fraction={draft.severity_score} display={String(Math.round(draft.severity_score * 100))} label="Impact" color={color} /></div>
          <div className="w-24"><Gauge fraction={draft.correlation_confidence} display={draft.correlation_confidence.toFixed(2)} label="Confidence" color="#2563eb" /></div>
        </div>
      </div>

      <div className="mt-2 border-t border-gray-100 pt-2">
        {pending ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <SignOffFields reviewer={d.reviewer} onChange={d.setReviewer} />
              <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                {!d.edit ? (
                  <>
                    <button disabled={d.busy} onClick={d.approve}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-green-700 hover:bg-green-800 disabled:opacity-60 text-white text-sm font-bold px-4 py-2 shadow-sm">
                      <HiOutlinePaperAirplane size={15} /> Approve
                    </button>
                    <button disabled={d.busy} onClick={onEdit}
                      className="inline-flex items-center gap-1.5 rounded-xl border border-blue-300 bg-white hover:bg-blue-50 text-blue-900 text-sm font-semibold px-3 py-2">
                      <HiOutlinePencilSquare size={15} /> Edit &amp; approve
                    </button>
                  </>
                ) : (
                  <>
                    <button disabled={d.busy} onClick={d.approveEdited}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-green-700 hover:bg-green-800 disabled:opacity-60 text-white text-sm font-bold px-4 py-2 shadow-sm">
                      <HiOutlinePaperAirplane size={15} /> Approve edited ticket
                    </button>
                    <button onClick={() => d.setEdit(null)} className="text-sm font-semibold text-gray-700 underline px-2">Cancel edit</button>
                  </>
                )}
                <button disabled={d.busy} onClick={() => d.setRejecting(!d.rejecting)} aria-expanded={d.rejecting}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 text-gray-800 text-sm font-semibold px-3 py-2">
                  <HiOutlineXCircle size={15} /> Reject
                </button>
              </div>
            </div>
            <AnimatePresence initial={false}>
              {d.rejecting && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                  className="overflow-hidden">
                  <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-gray-50 p-2">
                    <input value={d.note} onChange={(e) => d.setNote(e.target.value)} placeholder="Why is this not an incident? (kept in the history)"
                      aria-label="Reject reason" className="flex-1 min-w-[240px] rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm focus:outline-none focus:border-green-500" />
                    <button disabled={d.busy} onClick={d.reject}
                      className="rounded-lg bg-gray-800 hover:bg-gray-900 text-white text-sm font-semibold px-3 py-1.5">Confirm reject</button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <p className="flex items-center gap-1.5 text-[11px] text-amber-900">
              <HiOutlineLockClosed /> <b>AWAITING HUMAN REVIEW</b> · Nothing is written to output/tickets/ until a named reviewer approves.
            </p>
          </div>
        ) : published ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1.5 text-sm font-extrabold text-green-900">
              <HiOutlineCheckBadge size={18} /> WRITTEN as {draft.jira_key}
            </span>
            <span className="font-mono text-[11px] text-green-900">output/tickets/{draft.jira_key}.json + .md</span>
            <span className="text-xs text-gray-700">Human approval recorded{draft.reviewer ? ` (${draft.reviewer})` : ""}</span>
            {draft.lifecycle !== "resolved" && (
              <button disabled={d.busy} onClick={d.resolve}
                className="ml-auto rounded-xl bg-gray-800 hover:bg-gray-900 text-white text-xs font-semibold px-3 py-1.5">
                Mark resolved
              </button>
            )}
          </div>
        ) : (
          <p className="text-sm font-bold text-gray-800">
            {draft.status === "rejected" ? "REJECTED - nothing written; fed back to correlation" : `MERGED into ${draft.merged_into}`}
            {draft.reviewer && <span className="font-normal text-gray-600"> · by {draft.reviewer}</span>}
          </p>
        )}
      </div>
    </section>
  );
}

// --------------------------------------------------------------------------
// 2. the brief: what is going on, in three lines
// --------------------------------------------------------------------------

function Brief({ draft, ev }: { draft: DraftDetail; ev: Evidence }) {
  const rc = ev.root_cause;
  const path = useMemo(() => propagationPath(ev), [ev]);
  const color = PRIORITY_COLOR[draft.priority] ?? "#dc2626";
  const first = [...ev.signals].sort((a, b) => a.at.localeCompare(b.at))[0];
  const firstCand = rc.candidates.find((c) => c.service === first?.service);
  const twist = rc.service && first && first.service !== rc.service;
  const flaps = ev.severity.flap_count;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-[1.4fr_1fr] gap-4">
      <Section title="What's happening" sub={draft.summary_source === "llm" ? "Written by Claude from the computed facts" : "Deterministic template (Claude drafting off)"}>
        <p className="text-sm text-gray-900 leading-relaxed">{draft.summary}</p>
        {(draft.suppressed || flaps > 1) && (
          <div className="mt-3 rounded-xl border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-950">
            {draft.suppressed && <p><b>Not escalated as an active page.</b> {draft.suppression_reason}. Still drafted and waiting for review, so nothing is lost.</p>}
            {flaps > 1 && <p className={draft.suppressed ? "mt-1" : ""}><b>Flapping: {flaps} threshold crossings collapsed into this one incident</b> instead of {flaps} tickets.</p>}
          </div>
        )}
        <div className="mt-3 flex flex-wrap items-stretch gap-2 text-xs">
          {[
            { n: ev.raw_signals, l: "raw signals", s: "all sources, redacted" },
            { n: ev.unique_signals, l: "unique after dedup", s: `${ev.raw_signals - ev.unique_signals} repeats collapsed` },
            { n: 1, l: "incident", s: `root cause ${ev.root_cause.service ?? "unknown"}`, strong: true },
          ].map((x, i) => (
            <div key={x.l} className="flex items-center gap-2">
              <div className={clsx("rounded-xl border px-3 py-2 min-w-[7.5rem]", x.strong ? "bg-green-700 border-green-700 text-white" : "bg-gray-50 border-gray-100")}>
                <div className="text-xl font-extrabold tabular-nums leading-none">{x.n}</div>
                <div className={clsx("font-semibold mt-0.5", x.strong ? "text-green-50" : "text-gray-800")}>{x.l}</div>
                <div className={clsx("text-[11px]", x.strong ? "text-green-100" : "text-gray-500")}>{x.s}</div>
              </div>
              {i < 2 && <span className="text-gray-300">→</span>}
            </div>
          ))}
          {ev.excluded.length > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 min-w-[7.5rem]">
              <div className="text-xl font-extrabold tabular-nums leading-none text-red-700">{ev.excluded.length}</div>
              <div className="font-semibold mt-0.5 text-red-800">rejected</div>
              <div className="text-[11px] text-red-700">shared no context</div>
            </div>
          )}
        </div>
      </Section>

      <Section title="Probable origin" sub="Causal ranking and a counterfactual test on the dependency graph - inferred, not proven">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="text-2xl font-extrabold" style={{ color }}>{rc.service ?? "undetermined"}</span>
          {rc.service && <span className="text-xs font-semibold text-green-800 bg-green-100 rounded-full px-2 py-0.5">{Math.round(rc.confidence * 100)}% causal confidence</span>}
        </div>
        {path.length > 0 && (
          <ol className="mt-2 flex flex-wrap items-center gap-1 text-xs" aria-label="Propagation">
            {path.map((p, i) => (
              <li key={p.service} className="flex items-center gap-1">
                {i > 0 && <HiArrowRight className="text-gray-400" aria-hidden />}
                <span className={clsx("rounded-full border px-2 py-0.5 font-semibold", p.isRoot ? "text-white" : "bg-white text-gray-800 border-gray-200")}
                  style={p.isRoot ? { background: color, borderColor: color } : undefined}>
                  {p.service}
                </span>
              </li>
            ))}
          </ol>
        )}
        {twist && (
          <p className="mt-3 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-950">
            <HiOutlineLightBulb className="mt-0.5 shrink-0" />
            <span>
              <b>{first.service}</b> complained first ({clock(first.at)} UTC), but it is not the cause
              {firstCand?.symptom_of.length ? <>: it depends on <b>{firstCand.symptom_of.join(", ")}</b></> : null}.
            </span>
          </p>
        )}
        <Link href={`/timemachine?id=${draft.draft_id}`} className="mt-3 inline-flex items-center gap-1.5 text-xs font-semibold text-green-700 hover:underline">
          <TbTimeline /> Replay how it formed, signal by signal
        </Link>
      </Section>
    </div>
  );
}

// --------------------------------------------------------------------------
// 3. the ticket being approved
// --------------------------------------------------------------------------

function TicketSection({ draft, d }: { draft: DraftDetail; d: Decision }) {
  const byClaude = draft.summary_source === "llm";
  const pending = draft.status === "awaiting_review";
  const e = d.edit;
  return (
    <Section id="ticket" title="Ticket draft - what the on-call engineer will receive"
      sub={pending ? "This is exactly what Approve writes to output/tickets/." : "As written."}>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border border-green-200 bg-white p-4">
          <div className="mb-2"><Tag kind="computed" /></div>
          <dl className="text-xs text-gray-800 space-y-2">
            <div><dt className="font-bold text-gray-600">Title</dt><dd className="text-sm font-semibold text-gray-900">{cleanTitle(draft.title)}</dd></div>
            <div><dt className="font-bold text-gray-600">Impact severity</dt><dd>{draft.severity_line}</dd></div>
            <div><dt className="font-bold text-gray-600">Correlation confidence</dt><dd>{draft.correlation_confidence.toFixed(2)} (separate from severity, never blended)</dd></div>
            <div><dt className="font-bold text-gray-600">Affected services</dt><dd>{draft.affected_services.join(", ")}</dd></div>
            {(draft.facts ?? []).length > 0 && (
              <div>
                <dt className="font-bold text-gray-600">Facts (observed)</dt>
                <dd><ul className="list-disc list-inside space-y-0.5 mt-0.5">{draft.facts!.map((f, i) => <li key={i}>{f}</li>)}</ul></dd>
              </div>
            )}
            <div>
              <dt className="font-bold text-gray-600">Timeline (source stream in brackets)</dt>
              <dd className="font-mono text-[11px] space-y-0.5 mt-0.5 max-h-48 overflow-y-auto">
                {draft.timeline.map((t, i) => (
                  <div key={i}>{clock(t.at)} [{SOURCE_LABEL[t.source] ?? t.source}] {t.service}{t.count > 1 ? ` x${t.count}` : ""} - {t.detail}</div>
                ))}
              </dd>
            </div>
            {draft.considered_excluded.length > 0 && (
              <div>
                <dt className="font-bold text-gray-600">Considered &amp; excluded</dt>
                {draft.considered_excluded.map((x) => <dd key={x.service + x.at} className="text-red-800">{x.service} ({x.detail}) - {x.reason}</dd>)}
              </div>
            )}
          </dl>
        </div>

        <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-4">
          <div className="mb-2 flex items-center gap-2 flex-wrap">
            <Tag kind="ai" />
            <span className="text-[11px] text-gray-600">
              {byClaude ? `written by Claude (${draft.drafted_by ?? "claude"}) from the computed facts, checked for grounding`
                : "template - Claude not configured or its reply failed the grounding check"}
            </span>
          </div>
          <h3 className="text-xs font-bold text-gray-700">Summary</h3>
          <p className="text-sm text-gray-900 mt-0.5">{draft.summary}</p>
          <h3 className="text-xs font-bold text-gray-700 mt-3">Suspected root cause <span className="font-normal text-gray-500">(hypothesis, not a fact)</span></h3>
          <p className="text-sm text-gray-900 mt-0.5">{draft.suspected_root_cause || draft.root_cause_detail}</p>
          <h3 className="text-xs font-bold text-gray-700 mt-3">Investigation steps</h3>
          <ol className="list-decimal list-inside text-sm text-gray-900 space-y-0.5 mt-0.5">
            {draft.investigation_steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <p className="text-[11px] text-gray-600 mt-3">
            Claude only writes prose from the facts on the left. A reply that names a service outside the incident, or a different
            root-cause service, is discarded.
            {draft.redaction_kinds.length > 0 && <> Redacted before processing: {draft.redaction_kinds.join(", ")}.</>}
          </p>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {pending && e && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
            <div className="mt-4 rounded-xl border border-blue-200 bg-blue-50/50 p-4 space-y-2">
              <div className="text-[11px] font-bold uppercase tracking-wide text-blue-900">Edit before approving - then use &ldquo;Approve edited ticket&rdquo; above</div>
              <label className="block text-xs font-semibold text-gray-700">Title
                <input value={e.title} onChange={(x) => d.setEdit({ ...e, title: x.target.value })}
                  className="mt-0.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm" />
              </label>
              <label className="block text-xs font-semibold text-gray-700">Priority
                <select value={e.priority} onChange={(x) => d.setEdit({ ...e, priority: x.target.value })}
                  className="mt-0.5 block rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm">
                  {["P1", "P2", "P3", "P4"].map((p) => <option key={p}>{p}</option>)}
                </select>
              </label>
              <label className="block text-xs font-semibold text-gray-700">Summary
                <textarea rows={3} value={e.summary} onChange={(x) => d.setEdit({ ...e, summary: x.target.value })}
                  className="mt-0.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm" />
              </label>
              <label className="block text-xs font-semibold text-gray-700">Suspected root cause
                <textarea rows={2} value={e.suspected_root_cause} onChange={(x) => d.setEdit({ ...e, suspected_root_cause: x.target.value })}
                  className="mt-0.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm" />
              </label>
              <label className="block text-xs font-semibold text-gray-700">Investigation steps (one per line)
                <textarea rows={4} value={e.investigation_steps} onChange={(x) => d.setEdit({ ...e, investigation_steps: x.target.value })}
                  className="mt-0.5 w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm font-mono" />
              </label>
              <p className="text-[11px] text-gray-600">Evidence, timeline, scores and confidence are computed and cannot be edited.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {draft.status === "published" && (
        <ul className="mt-3 text-xs text-green-900 space-y-0.5">
          <li>Single-use approval token minted, bound to this draft</li>
          <li>Ticket written once (idempotency key = draft id)</li>
        </ul>
      )}
    </Section>
  );
}

// --------------------------------------------------------------------------
// 4. why the engine believes this - reachable, but below the decision
// --------------------------------------------------------------------------

function SignalRow({ s }: { s: EvidenceSignal }) {
  const c = s.join.components;
  const src = canonicalSource(s.source);
  return (
    <li className={clsx("rounded-xl border p-3", s.is_root_cause_signal ? "border-green-300 bg-green-50/60" : "border-gray-100 bg-white")}>
      <div className="flex items-start gap-2 flex-wrap">
        <span className="text-[11px] font-mono text-gray-600 pt-0.5">{clock(s.at)}</span>
        <span className="text-[11px] font-semibold rounded-md px-1.5 py-0.5 text-white" style={{ background: SOURCE_COLOR[src] ?? "#64748b" }}>
          {SOURCE_LABEL[s.source] ?? s.source}
        </span>
        <span className="text-sm font-semibold text-gray-900">{s.service}</span>
        {s.occurrences > 1 && <span className="text-[11px] font-bold rounded-md bg-amber-100 text-amber-800 px-1.5 py-0.5">×{s.occurrences} collapsed into 1</span>}
        {s.is_root_cause_signal && <span className="text-[11px] font-bold rounded-md bg-green-700 text-white px-1.5 py-0.5">root-cause signal</span>}
      </div>
      <p className="text-xs text-gray-700 mt-1 break-words">{s.message}</p>
      {(s.value !== null || s.detection_reason) && (
        <p className="text-[11px] text-gray-600 mt-0.5">
          {s.value !== null && <>value <b>{s.value}</b>{s.threshold !== null && <> vs threshold {s.threshold}</>} · </>}
          {s.detection_reason}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-1.5 mt-2">
        {s.badges.map((b) => (
          <span key={b.label} className={clsx("text-[11px] font-semibold rounded-full px-2 py-0.5 border",
            b.ok ? "bg-green-50 text-green-800 border-green-200" : "bg-gray-50 text-gray-400 border-gray-200 line-through")}>
            {b.ok ? "✓" : "✕"} {b.label}
          </span>
        ))}
        {s.join.gate && (
          <span className="text-[11px] text-gray-600">
            gate: <b className="text-gray-800">{s.join.gate}</b>{s.join.linked_to && <> with {s.join.linked_to}</>}{c && <> · similarity {c.total.toFixed(2)}</>}
          </span>
        )}
      </div>
    </li>
  );
}

function SignalsTab({ ev }: { ev: Evidence }) {
  const w = ev.correlation.weights as Record<string, number>;
  return (
    <>
      <p className="text-xs text-gray-700 mb-3">
        similarity = {DIMENSIONS.map((dim) => `${w[dim.key] ?? "?"} × ${dim.label.toLowerCase()}`).join(" + ")}. A pair may only join if it
        also passes the <b>shared-context gate</b> (same service, dependency edge, or common trace). Time alone never groups.
      </p>
      <ul className="flex flex-col gap-2">{ev.signals.map((s) => <SignalRow key={s.id} s={s} />)}</ul>
    </>
  );
}

function RejectedTab({ ev }: { ev: Evidence }) {
  return (
    <div>
      <h3 className="text-xs font-bold uppercase tracking-wide text-red-700 mb-2">Considered and rejected</h3>
      <ul className="flex flex-col gap-2">
        {ev.excluded.map((x) => (
          <li key={x.service + x.at} className="rounded-xl border border-red-200 bg-red-50/70 p-3">
            <div className="flex items-center gap-2 flex-wrap">
              <HiOutlineNoSymbol className="text-red-600" size={16} />
              <span className="text-[11px] font-mono text-gray-600">{clock(x.at)}</span>
              <span className="text-sm font-semibold text-gray-900">{x.service}</span>
              <span className="text-[11px] font-bold rounded-md bg-red-600 text-white px-1.5 py-0.5">REJECTED FROM INCIDENT</span>
            </div>
            <p className="text-xs text-gray-700 mt-1">{x.message}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {x.checks.map((c) => (
                <span key={c.label} className={clsx("text-[11px] font-semibold rounded-full px-2 py-0.5 border",
                  c.ok ? "bg-green-50 text-green-800 border-green-200" : "bg-white text-red-700 border-red-200")}>
                  {c.ok ? "✓" : "✕"} {c.label}
                </span>
              ))}
            </div>
            <p className="text-[11px] text-red-800 mt-1.5">Reason: {x.reason}. It fired inside the same window, but shares nothing with the incident.</p>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RootCauseTab({ ev }: { ev: Evidence }) {
  const rc = ev.root_cause;
  const maxScore = Math.max(...rc.candidates.map((c) => c.rank_score), 0.01);
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ul className="flex flex-col gap-2.5">
        {rc.candidates.map((c, i) => (
          <li key={c.service} className="text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className={clsx("font-semibold", i === 0 ? "text-gray-900" : "text-gray-700")}>
                {i + 1}. {c.service}
                {c.is_symptom && <span className="ml-1.5 text-[10px] font-bold text-red-700">SYMPTOM</span>}
              </span>
              <span className="tabular-nums font-bold text-gray-900">{c.rank_score.toFixed(2)}</span>
            </div>
            <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mt-1">
              <motion.div className="h-full rounded-full" style={{ background: i === 0 ? "#15803d" : "#9ca3af" }}
                initial={{ width: 0 }} animate={{ width: `${(c.rank_score / maxScore) * 100}%` }} transition={{ delay: 0.1 + i * 0.08, duration: 0.5 }} />
            </div>
            <div className="text-[11px] text-gray-600 mt-0.5">
              precedence {c.temporal_precedence} · dependency reach {c.dependency_reach} · evidence {c.evidence_strength}
              {c.rejection_reason && <span className="block text-red-700">✕ {c.rejection_reason}</span>}
              {c.uniquely_explains.length > 0 && <span className="block text-green-800">✓ uniquely explains {c.uniquely_explains.join(", ")}</span>}
            </div>
          </li>
        ))}
      </ul>
      <div className="rounded-xl border border-gray-200 bg-gray-50/60 p-3 h-fit">
        <div className="text-[11px] font-bold uppercase tracking-wide text-gray-700 mb-1">Counterfactual check (graph ablation)</div>
        <ul className="text-xs text-gray-700 space-y-1">{rc.reasoning.map((r, i) => <li key={i}>• {r}</li>)}</ul>
        <p className="text-[11px] text-gray-500 mt-1.5">A rule-based simulation over the dependency graph, not a trained causal model.</p>
      </div>
    </div>
  );
}

function SeverityTab({ ev }: { ev: Evidence }) {
  const s = ev.severity;
  return (
    <div>
      <h3 className="sr-only">Severity — why this priority</h3>
      <div className="flex items-baseline gap-2">
        <span className={clsx("text-2xl font-extrabold", s.priority === "P1" ? "text-red-700" : s.priority === "P2" ? "text-orange-700" : "text-blue-700")}>{s.priority}</span>
        <span className="text-lg font-bold text-gray-900 tabular-nums">{s.score.toFixed(3)}</span>
        <span className="text-xs text-gray-600">
          {s.score >= s.p1_threshold ? `≥ ${s.p1_threshold} → P1` : s.score >= s.p2_threshold ? `≥ ${s.p2_threshold} → P2` : `< ${s.p2_threshold} → P3`}
        </span>
      </div>
      <ul className="mt-3 grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-2.5">
        {s.factors.map((f, i) => (
          <li key={f.key} className="text-xs">
            <div className="flex justify-between gap-2">
              <span className="font-semibold text-gray-800">{f.label} <span className="text-gray-500 font-normal">(weight {f.weight})</span></span>
              <span className="tabular-nums font-bold text-gray-900">+{f.contribution.toFixed(2)}</span>
            </div>
            <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-1">
              <motion.div className="h-full rounded-full bg-green-600" initial={{ width: 0 }} animate={{ width: `${Math.round(f.value * 100)}%` }}
                transition={{ delay: 0.1 + i * 0.08, duration: 0.5 }} />
            </div>
            <div className="text-[11px] text-gray-600 mt-0.5">value {f.value.toFixed(2)} — {f.note}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ConfidenceTab({ ev }: { ev: Evidence }) {
  const c = ev.correlation.confidence;
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <ul className="text-xs text-gray-800 space-y-1.5">
        {c.parts.map((p) => (
          <li key={p.label} className="flex justify-between gap-3"><span>{p.label}</span><b className="tabular-nums">+{p.points.toFixed(2)}</b></li>
        ))}
        <li className="flex justify-between gap-3 border-t border-gray-200 pt-1.5 font-bold text-gray-900"><span>Final</span><span className="tabular-nums">{c.final.toFixed(2)}</span></li>
      </ul>
      <div className="text-xs text-gray-700">
        {c.validation && c.validation.length > 0 && (
          <>
            <div className="text-[11px] font-bold uppercase tracking-wide text-gray-600 mb-1">Validation: {c.validation.filter((v) => v.passed).length}/{c.validation.length} checks passed</div>
            <ul className="space-y-0.5 mb-2">
              {c.validation.map((v) => <li key={v.name}>{v.passed ? "✓" : "✕"} <b>{v.name}</b> · {v.detail}</li>)}
            </ul>
          </>
        )}
        <p className="text-[11px] text-gray-600">
          Links used: {Object.entries(c.gate_reasons).map(([k, v]) => `${v} × ${k}`).join(", ")}. Weaker evidence lowers the score,
          which puts uncertain incidents at the top of the review queue.
        </p>
      </div>
    </div>
  );
}

function HistoryMatch({ draft }: { draft: DraftDetail }) {
  const m = draft.historical_match!;
  return (
    <div>
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-lg font-extrabold text-gray-900">{m.incident_id}</span>
        <span className="text-xs font-semibold text-green-800 bg-green-100 rounded-full px-2 py-0.5">{m.similarity_pct}% similar</span>
      </div>
      <p className="text-xs text-gray-800 mt-1">{m.title}</p>
      <p className="text-xs text-gray-900 mt-2"><b>Resolved by:</b> {m.resolution}</p>
      <p className="text-[11px] text-gray-600 mt-1">Took {m.resolution_minutes} minutes. Shared symptom terms: {m.shared_terms.join(", ")}.</p>
      <p className="text-[11px] text-gray-500 mt-2">Context only: it never forces a grouping. The library is seeded demo history, not real past tickets.</p>
    </div>
  );
}

function EvidenceTabs({ ev, draft }: { ev: Evidence; draft: DraftDetail }) {
  const tabs = [
    { key: "root", label: "Root cause", body: <RootCauseTab ev={ev} /> },
    { key: "signals", label: `Signals & joins (${ev.signals.length})`, body: <SignalsTab ev={ev} /> },
    { key: "severity", label: "Severity", body: <SeverityTab ev={ev} /> },
    { key: "confidence", label: "Confidence", body: <ConfidenceTab ev={ev} /> },
    ...(ev.excluded.length ? [{ key: "rejected", label: `Rejected (${ev.excluded.length})`, body: <RejectedTab ev={ev} /> }] : []),
    ...(draft.historical_match ? [{ key: "history", label: "Historical match", body: <HistoryMatch draft={draft} /> }] : []),
  ];
  const [tab, setTab] = useState("root");
  const active = tabs.find((t) => t.key === tab) ?? tabs[0];
  return (
    <Section title="Why the engine believes this" sub="Everything below is computed from the streams; nothing here is model output" right={<Tag kind="computed" />}>
      <div role="tablist" aria-label="Evidence" className="flex flex-wrap gap-1 mb-4 border-b border-gray-100">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={t.key === active.key} onClick={() => setTab(t.key)}
            className={clsx("relative px-3 py-2 text-xs font-semibold transition-colors", t.key === active.key ? "text-gray-900" : "text-gray-500 hover:text-gray-800")}>
            {t.label}
            {t.key === active.key && <motion.span layoutId="evidence-tab" className="absolute inset-x-1 -bottom-px h-0.5 rounded-full bg-green-700" />}
          </button>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={active.key} role="tabpanel" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.15 }}>
          {active.body}
        </motion.div>
      </AnimatePresence>
    </Section>
  );
}

// --------------------------------------------------------------------------
// 5. activity: lifecycle, late signals, sign-off trail
// --------------------------------------------------------------------------

const STEPS = [
  { key: "open", label: "Open" }, { key: "drafting", label: "Drafting" }, { key: "in_review", label: "In review" },
  { key: "published", label: "Published" }, { key: "resolved", label: "Resolved" },
];

function Activity({ draft, draftId }: { draft: DraftDetail; draftId: string }) {
  const { data: audit } = useEngineAudit();
  const { data: archived } = useArchivedIncident(draftId, { shouldRetryOnError: false });
  const { data: fb } = useEngineFeedback();
  const { resetFeedback } = useEngineActions();
  const idx = STEPS.findIndex((s) => s.key === draft.lifecycle);
  const dead = draft.status === "rejected" || draft.status === "merged";
  const when = (key: string) => {
    const h = [...draft.history].reverse().find((x) => x.state === key);
    return h ? clock(h.at) : null;
  };
  const trail = archived?.audit?.length
    ? archived.audit.map((a) => ({ at: a.at, who: a.actor.email ? `${a.actor.name} <${a.actor.email}>` : a.actor.name, what: a.action, detail: a.note }))
    : (audit ?? []).filter((a) => a.draft_id === draftId).map((a) => ({ at: a.at, who: a.actor, what: a.action, detail: a.detail }));

  return (
    <Section title="Activity" sub="Lifecycle, late evidence and every action taken on this incident">
      <div className="flex flex-wrap items-center gap-2">
        {STEPS.map((s, i) => {
          const done = !dead && i <= idx;
          return (
            <div key={s.key} className="flex items-center gap-2">
              <div className={clsx("flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border",
                done ? "bg-green-700 text-white border-green-700" : "bg-white text-gray-500 border-gray-200")}>
                {done && "✓ "}{s.label}{done && when(s.key) && <span className="font-normal opacity-80">{when(s.key)}</span>}
              </div>
              {i < STEPS.length - 1 && <span className="text-gray-300">›</span>}
            </div>
          );
        })}
        {dead && <span className="text-xs font-bold text-gray-700">Ended: {draft.status}</span>}
      </div>

      <p className="text-xs text-gray-700 mt-3">
        {draft.updates > 0
          ? <>{draft.updates} late signal{draft.updates === 1 ? "" : "s"} from the streams joined this incident after it was drafted, no duplicate ticket.</>
          : <>No late signals yet.</>}{" "}
        A late signal joins only through the structural gate and the merge threshold. Before approval it refreshes the draft; after
        approval it is appended to the written ticket as an update, never a second ticket.
      </p>
      {draft.jira_comments.length > 0 && (
        <ul className="mt-2 text-xs text-gray-800 space-y-0.5">{draft.jira_comments.map((c, i) => <li key={i} className="font-mono">+ {c.issue}: {c.body}</li>)}</ul>
      )}

      {trail.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-bold uppercase tracking-wide text-gray-700 mb-1">Audit trail</h3>
          <ul className="text-xs text-gray-700 space-y-0.5">
            {trail.map((a, i) => <li key={i} className="font-mono">{clock(a.at)} · {a.who} · {a.what}{a.detail ? ` · ${a.detail}` : ""}</li>)}
          </ul>
          {archived && <Link href={`/history/${draftId}`} className="mt-1 inline-block text-xs font-semibold text-green-700 hover:underline">Full record in Incident History →</Link>}
        </div>
      )}

      {fb && fb.decisions.length > 0 && (
        <div className="mt-3 rounded-xl border border-violet-200 bg-violet-50/40 p-3">
          <div className="flex items-center justify-between gap-2 mb-1">
            <div className="text-[11px] font-bold uppercase tracking-wide text-violet-900">What reviewers taught the correlator</div>
            <button onClick={() => resetFeedback()} className="text-[11px] font-semibold text-violet-900 underline">Reset to design weights</button>
          </div>
          <ul className="text-xs text-gray-800 space-y-1">
            {fb.decisions.map((x, i) => (
              <li key={i}>
                <b>{x.action}</b> on {x.services.join(", ")}
                {x.adjustment && (
                  <span className="font-mono text-[11px] block text-gray-700">
                    {Object.keys(x.adjustment.after).filter((k) => x.adjustment!.before[k] !== x.adjustment!.after[k])
                      .map((k) => `${k} ${x.adjustment!.before[k].toFixed(2)} → ${x.adjustment!.after[k].toFixed(2)}`).join(" · ")}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-gray-600 mt-1">A rule-based nudge for this service pattern only, visible and resettable. No model is retrained.</p>
        </div>
      )}
    </Section>
  );
}

// --------------------------------------------------------------------------
// page
// --------------------------------------------------------------------------

export default function InvestigationClient({ draftId }: { draftId: string }) {
  const { data: ev, isLoading, error } = useEngineEvidence(draftId);
  const { data: draft } = useEngineDraft(draftId, { refreshInterval: 5000 });
  const { data: archived } = useArchivedIncident(draftId, { shouldRetryOnError: false });
  const d = useDecision(draftId, draft);
  const ticketRef = useRef<HTMLDivElement>(null);

  if (isLoading) return <KeepLoader loadingText="Loading investigation..." />;
  if (error || !ev) {
    return (
      <div className="p-4">
        <EmptyStateCard icon={HiOutlineExclamationTriangle} title="No incident to investigate"
          description="Incidents appear here when the live signal streams produce a validated correlation.">
          <Link href="/" className="text-sm font-semibold text-green-700 hover:underline">Go to Overview →</Link>
        </EmptyStateCard>
      </div>
    );
  }
  if (!draft) return <KeepLoader loadingText="Loading ticket..." />;

  const onEdit = () => {
    d.startEdit();
    requestAnimationFrame(() => ticketRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }));
  };

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-4 p-4">
        <DecisionBar draft={draft} ev={ev} d={d} raisedAt={archived?.raised_at ?? null} onEdit={onEdit} />
        <Brief draft={draft} ev={ev} />
        <div ref={ticketRef}><TicketSection draft={draft} d={d} /></div>
        <EvidenceTabs ev={ev} draft={draft} />
        <Activity draft={draft} draftId={draftId} />
      </div>
    </MotionConfig>
  );
}
