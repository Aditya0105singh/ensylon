"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Card,
  Text,
  TextInput,
  NumberInput,
  Select,
  SelectItem,
} from "@tremor/react";
import { toast } from "react-toastify";
import {
  HiOutlineBolt,
  HiOutlineCheck,
  HiOutlineXMark,
  HiOutlineArrowsRightLeft,
  HiOutlineShieldCheck,
  HiOutlineSparkles,
  HiOutlineCpuChip,
} from "react-icons/hi2";
import { EmptyStateCard, KeepLoader, PageSubtitle, PageTitle } from "@/shared/ui";
import {
  useEngineReport,
  useEngineQueue,
  useEngineAudit,
  useEngineDraft,
  useEngineActions,
} from "@/entities/engine/useEngine";
import { PipelineStages } from "@/entities/engine/PipelineStages";
import type { DraftStatus, Priority, QueueSummary } from "@/entities/engine/types";

// NOTE ON THEMING: this app renders dark mode by applying a CSS
// `filter: invert(1) hue-rotate(180deg)` to <html> (see WatchUpdateTheme /
// the "workaround-dark" class) rather than maintaining a separate dark
// palette. Every component in this codebase is therefore authored in LIGHT
// colors (white cards, gray-900 text, pastel accent tints) and the browser
// does the inversion — authoring literal dark colors here (bg-neutral-900,
// text-white) fights that filter and produces broken contrast. Confirmed by
// direct inspection: text-white on a dark card round-trips through
// invert+hue-rotate into near-black-on-near-black.

const PRIORITY_COLOR: Record<Priority, "red" | "orange" | "gray"> = {
  P1: "red",
  P2: "orange",
  P3: "gray",
  P4: "gray",
};

const PRIORITY_BORDER: Record<Priority, string> = {
  P1: "before:bg-red-500",
  P2: "before:bg-orange-400",
  P3: "before:bg-gray-300",
  P4: "before:bg-gray-200",
};

const STATUS_TABS: { key: DraftStatus; label: string }[] = [
  { key: "awaiting_review", label: "Awaiting Review" },
  { key: "published", label: "Published" },
  { key: "rejected", label: "Rejected" },
  { key: "merged", label: "Merged" },
];

// ---------------------------------------------------------------------------
// Hero
// ---------------------------------------------------------------------------

function Hero() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-green-100 bg-gradient-to-br from-green-50 via-white to-white p-6 sm:p-8">
      <div className="pointer-events-none absolute -top-16 -right-10 w-64 h-64 rounded-full bg-green-200/40 blur-3xl animate-auroraDrift" />
      <div className="pointer-events-none absolute -bottom-20 -left-10 w-64 h-64 rounded-full bg-amber-100/50 blur-3xl animate-auroraDrift" style={{ animationDelay: "-7s" }} />
      <div className="relative flex items-center gap-2 mb-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-green-200 bg-white px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-green-600 shadow-sm">
          <HiOutlineSparkles className="animate-glowPulse" size={13} />
          Live engine
        </span>
      </div>
      <h1 className="relative text-2xl sm:text-3xl font-bold tracking-tight text-gray-900">
        Review Queue
      </h1>
      <p className="relative mt-2 max-w-2xl text-sm text-gray-500">
        The real engine, running — ingest, detect, correlate, causal analysis,
        score, draft, and a human review gate that{" "}
        <span className="text-gray-800 font-medium">
          structurally cannot be bypassed
        </span>
        .
      </p>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
  accent = "orange",
  icon: Icon,
  delay = 0,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  accent?: "orange" | "emerald" | "red" | "gray" | "purple" | "blue";
  icon?: React.ComponentType<{ size?: number; className?: string }>;
  delay?: number;
}) {
  const styles = {
    orange: "bg-orange-50 text-orange-600 ring-orange-100",
    emerald: "bg-emerald-50 text-emerald-600 ring-emerald-100",
    red: "bg-red-50 text-red-600 ring-red-100",
    gray: "bg-gray-50 text-gray-500 ring-gray-100",
    purple: "bg-purple-50 text-purple-600 ring-purple-100",
    blue: "bg-blue-50 text-blue-600 ring-blue-100",
  }[accent];
  const topBar = {
    orange: "bg-orange-400",
    emerald: "bg-emerald-400",
    red: "bg-red-400",
    gray: "bg-gray-300",
    purple: "bg-purple-400",
    blue: "bg-blue-400",
  }[accent];

  return (
    <div
      className="group relative rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-all duration-300 hover:-translate-y-0.5 hover:shadow-md animate-fadeInUp overflow-hidden"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={`absolute top-0 left-0 right-0 h-0.5 ${topBar}`} />
      <div className="flex items-start justify-between">
        <Text className="text-[11px] uppercase tracking-wider text-gray-400">
          {label}
        </Text>
        {Icon && (
          <div
            className={`rounded-lg p-1.5 ring-1 transition-transform duration-300 group-hover:scale-110 ${styles}`}
          >
            <Icon size={14} />
          </div>
        )}
      </div>
      <div className="text-2xl font-bold text-gray-900 mt-1.5 tabular-nums">{value}</div>
      {sub && <Text className="text-[11px] text-gray-400 mt-1">{sub}</Text>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Report summary
// ---------------------------------------------------------------------------

function ReportSummary() {
  const { data: report, isLoading } = useEngineReport();

  if (isLoading) return <KeepLoader includeMinHeight={false} loadingText="Loading report..." />;
  if (!report || !report.scenario) {
    return (
      <EmptyStateCard
        icon={HiOutlineBolt}
        title="No run yet"
        description="Waiting for the live streams: stats appear once signals arrive."
      />
    );
  }

  const ev = report.evaluation;
  return (
    <div className="flex flex-col gap-3">
      <Text className="text-[11px] text-gray-400 font-mono truncate" title={report.scenario}>
        {report.scenario}
      </Text>
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <StatCard label="Signals ingested" value={report.signals_ingested} icon={HiOutlineBolt} delay={0} />
        <StatCard
          label="Anomalies detected"
          value={report.anomalies_detected}
          sub={`${report.within_baseline} within baseline`}
          icon={HiOutlineSparkles}
          accent="blue"
          delay={40}
        />
        <StatCard
          label="Incidents formed"
          value={report.incidents_formed}
          sub={`${report.noise_signals} kept as noise`}
          accent="emerald"
          icon={HiOutlineCpuChip}
          delay={80}
        />
        <StatCard
          label="Root causes found"
          value={report.root_causes_identified}
          accent="emerald"
          icon={HiOutlineSparkles}
          delay={120}
        />
        <StatCard
          label="Noise reduction"
          value={`${report.noise_reduction_pct}%`}
          sub={`1 − ${report.incidents_formed} ÷ ${report.signals_ingested} signals`}
          accent="emerald"
          delay={160}
        />
        <StatCard
          label="Auto-published"
          value={report.auto_published}
          sub="structurally impossible"
          accent={report.auto_published === 0 ? "emerald" : "red"}
          icon={HiOutlineShieldCheck}
          delay={200}
        />
      </div>
      {ev && (
        <>
          <div className="rounded-xl border border-gray-200 bg-gray-50 px-3.5 py-2.5 text-xs text-gray-700">
            <b>Ground-truth check on this one run</b> ({report.signals_ingested} signals,{" "}
            {ev.incidents_expected} expected incident{ev.incidents_expected === 1 ? "" : "s"}
            {ev.true_pairs !== undefined && <>, {ev.true_pairs} true pairs</>}). The scenario
            carries its own correct answer, so this confirms the engine reproduces it — a
            sanity check, not an accuracy estimate. Measured accuracy across several seeds is
            on the{" "}
            <Link href="/evaluation" className="font-semibold text-green-700 underline">
              Evaluation page
            </Link>
            .
          </div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard
              label="Pair precision"
              value={ev.pair_precision.toFixed(3)}
              sub={
                ev.predicted_pairs !== undefined
                  ? `${ev.correct_pairs} of ${ev.predicted_pairs} predicted pairs`
                  : undefined
              }
              accent="purple"
              delay={240}
            />
            <StatCard
              label="Pair recall"
              value={ev.pair_recall.toFixed(3)}
              sub={
                ev.true_pairs !== undefined
                  ? `${ev.correct_pairs} of ${ev.true_pairs} true pairs`
                  : undefined
              }
              accent="purple"
              delay={260}
            />
            <StatCard
              label="Cluster purity"
              value={ev.cluster_purity.toFixed(3)}
              sub={`${ev.incidents_formed} incident${ev.incidents_formed === 1 ? "" : "s"} formed`}
              accent="purple"
              delay={280}
            />
            <StatCard
              label="Root cause accuracy"
              value={`${ev.root_cause_correct}/${ev.root_cause_total}`}
              sub={`${ev.root_cause_total} incident${ev.root_cause_total === 1 ? "" : "s"} checked`}
              accent="purple"
              delay={300}
            />
            <StatCard
              label="Blocking saved"
              value={`${report.blocking_saved_pct}%`}
              sub={`${report.candidate_pairs} / ${report.possible_pairs} pairs scored`}
              accent="purple"
              delay={320}
            />
          </div>
        </>
      )}
      {report.calibration_warning && (
        <div className="animate-fadeInUp rounded-xl border border-amber-200 bg-amber-50 p-3.5">
          <Text className="text-amber-800 text-sm">⚠ {report.calibration_warning}</Text>
        </div>
      )}
      {report.causal_splits.length > 0 && (
        <div className="animate-fadeInUp rounded-xl border border-purple-200 bg-purple-50 p-3.5">
          <div className="flex items-center gap-1.5 mb-1">
            <HiOutlineSparkles className="text-purple-500" size={13} />
            <Text className="text-[11px] uppercase tracking-wider text-purple-500">
              Causal engine split concurrent incidents
            </Text>
          </div>
          {report.causal_splits.map((s, i) => (
            <Text key={i} className="text-sm text-purple-900">
              {s}
            </Text>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queue row + detail
// ---------------------------------------------------------------------------

function ConfidenceBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: "blue" | "purple";
}) {
  const styles = {
    blue: "border-blue-200 bg-blue-50 text-blue-700",
    purple: "border-purple-200 bg-purple-50 text-purple-700",
  }[color];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${styles}`}
    >
      {label} {value}
    </span>
  );
}

function DraftDetailPanel({ draftId }: { draftId: string }) {
  const { data: draft, isLoading } = useEngineDraft(draftId);
  if (isLoading || !draft) return <KeepLoader includeMinHeight={false} loadingText="Loading ticket..." />;

  return (
    <div className="animate-fadeInUp p-4 bg-gray-50 border-t border-gray-100 flex flex-col gap-4">
      <div>
        <Text className="text-[11px] uppercase tracking-wider text-gray-400">Root cause</Text>
        <Text className="text-sm text-gray-800">{draft.root_cause_detail}</Text>
      </div>

      <div>
        <Text className="text-[11px] uppercase tracking-wider text-gray-400">
          Summary {draft.summary_source === "template" ? "(template — no LLM configured)" : "(LLM)"}
        </Text>
        <Text className="text-sm text-gray-800">{draft.summary}</Text>
      </div>

      {draft.investigation_steps.length > 0 && (
        <div>
          <Text className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
            Suggested investigation
          </Text>
          <ol className="list-decimal list-inside text-sm text-gray-700 space-y-0.5">
            {draft.investigation_steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}

      <div>
        <Text className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
          Evidence timeline
        </Text>
        <div className="font-mono text-xs text-gray-600 bg-white border border-gray-200 rounded-lg p-2.5 max-h-52 overflow-auto">
          {draft.timeline.map((e, i) => (
            <div key={i} className="py-0.5">
              <span className="text-gray-400">{new Date(e.at).toLocaleTimeString()}</span>{" "}
              <span className="text-green-600">[{e.source}]</span> {e.service}
              {e.count > 1 ? ` ×${e.count}` : ""} — {e.detail}
            </div>
          ))}
        </div>
      </div>

      {draft.causal_reasoning.length > 0 && (
        <div>
          <Text className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
            Why this root cause — causal engine reasoning
          </Text>
          <ul className="list-disc list-inside text-sm text-gray-700 space-y-0.5">
            {draft.causal_reasoning.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}

      {draft.considered_excluded.length > 0 && (
        <div>
          <Text className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
            Considered &amp; excluded
          </Text>
          <ul className="text-sm text-gray-500 space-y-0.5">
            {draft.considered_excluded.map((x, i) => (
              <li key={i}>
                <span className="font-medium text-gray-700">{x.service}</span> at{" "}
                {new Date(x.at).toLocaleTimeString()} ({x.detail}) — {x.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <Text className="text-[11px] uppercase tracking-wider text-gray-400 mb-1">
          Severity factors
        </Text>
        <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-sm text-gray-700">
          {Object.entries(draft.severity_factors).map(([k, v]) => (
            <div key={k}>
              <span className="font-medium capitalize text-gray-800">{k}:</span> {v}
            </div>
          ))}
        </div>
      </div>

      {draft.redaction_kinds.length > 0 && (
        <Text className="text-xs text-gray-400">
          Redacted before processing: {draft.redaction_kinds.join(", ")}
        </Text>
      )}

      {draft.jira_fields && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5">
          <Text className="text-[11px] uppercase tracking-wider text-emerald-600 mb-1">
            Written to output/tickets/ as {draft.jira_key}
          </Text>
          <pre className="text-xs text-emerald-900 whitespace-pre-wrap">
            {draft.jira_fields.description}
          </pre>
        </div>
      )}

      {draft.note && (
        <Text className="text-xs text-gray-500">Reviewer note: {draft.note}</Text>
      )}
    </div>
  );
}

function QueueRow({ item, actor, delay = 0 }: { item: QueueSummary; actor: string; delay?: number }) {
  const [expanded, setExpanded] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const [mergeId, setMergeId] = useState("");
  const { approve, reject, merge } = useEngineActions();

  const requireActor = () => {
    if (!actor.trim()) {
      toast.error("Enter a reviewer name first — approval requires a named human actor");
      return false;
    }
    return true;
  };

  const doApprove = async () => {
    if (!requireActor()) return;
    try {
      const result = await approve(item.draft_id, actor);
      toast.success(`Approved - ticket ${result.jira_key} written`);
    } catch (e: any) {
      toast.error(e?.message || "Approve failed");
    }
  };

  const doReject = async () => {
    if (!requireActor()) return;
    try {
      await reject(item.draft_id, actor, "rejected from review queue");
      toast.info("Rejected — correction fed back to correlation");
    } catch (e: any) {
      toast.error(e?.message || "Reject failed");
    }
  };

  const doMerge = async () => {
    if (!requireActor()) return;
    if (!mergeId.trim()) {
      toast.error("Enter the draft id to merge into");
      return;
    }
    try {
      await merge(item.draft_id, mergeId.trim(), actor, "merged from review queue");
      toast.info(`Merged into ${mergeId.trim()}`);
      setMergeTarget(null);
    } catch (e: any) {
      toast.error(e?.message || "Merge failed");
    }
  };

  const isPending = item.status === "awaiting_review";

  return (
    <div
      className={`group relative rounded-xl border border-gray-200 bg-white overflow-hidden shadow-sm transition-all duration-300 hover:shadow-md animate-fadeInUp
        before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[3px] ${PRIORITY_BORDER[item.priority]}
        ${item.priority === "P1" ? "before:animate-glowPulse" : ""}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div
        className="flex flex-wrap items-center gap-3 p-3 pl-4 cursor-pointer hover:bg-gray-50/80"
        onClick={() => setExpanded((e) => !e)}
      >
        <Badge color={PRIORITY_COLOR[item.priority]} size="xs">
          {item.priority}
        </Badge>
        <div className="flex-1 min-w-[200px]">
          <Text className="text-sm font-medium text-gray-900">{item.title}</Text>
          <Text className="text-xs text-gray-400">
            {item.affected_services.join(", ")} · {item.signal_count} signals
          </Text>
          <Link
            href={`/review/${encodeURIComponent(item.draft_id)}`}
            onClick={(e) => e.stopPropagation()}
            className="text-xs font-semibold text-green-700 hover:underline"
          >
            Investigate why →
          </Link>
        </div>
        <ConfidenceBadge label="corr" value={item.correlation_confidence.toFixed(2)} color="blue" />
        <ConfidenceBadge label="causal" value={`${item.causal_confidence}%`} color="purple" />
        {item.status === "published" && (
          <Badge color="emerald" size="xs">
            {item.jira_key}
          </Badge>
        )}
        {item.status === "rejected" && (
          <Badge color="red" size="xs">
            rejected
          </Badge>
        )}
        {item.status === "merged" && (
          <Badge color="gray" size="xs">
            merged → {item.merged_into}
          </Badge>
        )}
        {item.suppressed && (
          <Badge color="gray" size="xs">
            suppressed
          </Badge>
        )}

        {isPending && (
          <div className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
            <Button
              size="xs"
              icon={HiOutlineCheck}
              color="emerald"
              variant="secondary"
              onClick={doApprove}
              className="transition-transform active:scale-95"
            >
              Approve
            </Button>
            <Button
              size="xs"
              icon={HiOutlineXMark}
              color="red"
              variant="secondary"
              onClick={doReject}
              className="transition-transform active:scale-95"
            >
              Reject
            </Button>
            <Button
              size="xs"
              icon={HiOutlineArrowsRightLeft}
              color="gray"
              variant="secondary"
              onClick={() => setMergeTarget(mergeTarget ? null : item.draft_id)}
              className="transition-transform active:scale-95"
            >
              Merge
            </Button>
          </div>
        )}
      </div>

      {mergeTarget && (
        <div
          className="animate-fadeInUp flex items-center gap-2 px-4 pb-3"
          onClick={(e) => e.stopPropagation()}
        >
          <TextInput
            placeholder="draft id to merge into…"
            value={mergeId}
            onValueChange={setMergeId}
            className="max-w-xs"
          />
          <Button size="xs" color="gray" onClick={doMerge}>
            Confirm merge
          </Button>
        </div>
      )}

      {expanded && <DraftDetailPanel draftId={item.draft_id} />}
    </div>
  );
}

function PipelineStagesSection({ queue }: { queue: QueueSummary[] }) {
  const { data: report, isLoading } = useEngineReport();
  if (isLoading || !report || !report.scenario) return null;
  return <PipelineStages report={report} queue={queue} />;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function ReviewPage() {
  const { data: queue, isLoading } = useEngineQueue();
  const { data: audit } = useEngineAudit();
  const [tab, setTab] = useState<DraftStatus>("awaiting_review");
  const [actor, setActor] = useState("");

  // The bell (Topbar) links here with #review-queue. Next.js's own hash
  // scroll only fires for elements present at the very first paint; this is
  // a client component that renders after hydration, so that race silently
  // drops the scroll. Doing it ourselves, on mount, is reliable either way.
  useEffect(() => {
    if (window.location.hash === "#review-queue") {
      document.getElementById("review-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const filtered = useMemo(
    () => (queue ?? []).filter((i) => i.status === tab),
    [queue, tab]
  );

  return (
    <div className="flex flex-col gap-5">
      <Hero />

      <PipelineStagesSection queue={queue ?? []} />
      <ReportSummary />

      <div id="review-queue" className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 scroll-mt-20">
        <div className="flex flex-wrap items-center gap-2">
          <HiOutlineShieldCheck className="text-amber-600 shrink-0" size={17} />
          <Text className="text-sm text-amber-800">
            Reviewer name (required to Approve, Reject, or Merge — every
            decision is written to the audit log below with this name):
          </Text>
          <TextInput
            placeholder="you@teamspacex"
            value={actor}
            onValueChange={setActor}
            className="max-w-xs"
          />
        </div>
      </div>

      <div>
        <div className="flex gap-1.5 mb-3">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 ${
                tab === t.key
                  ? "bg-gradient-to-r from-green-700 to-green-800 text-white shadow-[0_4px_16px_rgba(21,128,61,0.3)]"
                  : "bg-white border border-gray-200 text-gray-500 hover:bg-gray-50 hover:text-gray-700"
              }`}
            >
              {t.label}
              {queue && (
                <span className="ml-1.5 opacity-70">
                  ({queue.filter((i) => i.status === t.key).length})
                </span>
              )}
            </button>
          ))}
        </div>

        {isLoading ? (
          <KeepLoader includeMinHeight={false} loadingText="Loading queue..." />
        ) : filtered.length === 0 ? (
          <EmptyStateCard
            icon={HiOutlineShieldCheck}
            title="Nothing here"
            description={
              tab === "awaiting_review"
                ? "No incidents awaiting review. Drafts appear here when the live streams produce a validated correlation."
                : `No drafts are currently ${STATUS_TABS.find((t) => t.key === tab)?.label.toLowerCase()}.`
            }
          />
        ) : (
          <div className="flex flex-col gap-2">
            {filtered.map((item, i) => (
              <QueueRow key={item.draft_id} item={item} actor={actor} delay={i * 50} />
            ))}
          </div>
        )}
      </div>

      {audit && audit.length > 0 && (
        <div>
          <Text className="text-[11px] uppercase tracking-wider text-gray-400 mb-2">
            Audit log
          </Text>
          <div className="font-mono text-xs text-gray-600 bg-white border border-gray-200 rounded-xl p-3 max-h-64 overflow-auto shadow-sm">
            {audit.map((e, i) => (
              <div key={i} className="py-0.5">
                <span className="text-gray-400">{new Date(e.at).toLocaleTimeString()}</span>{" "}
                <span className="text-gray-700">{e.actor.padEnd(20)}</span>{" "}
                <span className="text-green-600">{e.action.padEnd(16)}</span>{" "}
                {e.draft_id.slice(0, 20)} {e.detail}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
