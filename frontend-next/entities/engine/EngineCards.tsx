"use client";

import Link from "next/link";
import clsx from "clsx";
import { HiOutlineArrowRight, HiOutlineCheckCircle, HiOutlineExclamationTriangle } from "react-icons/hi2";
import { LuZap } from "react-icons/lu";
import { useEngineActions, useEngineQueue, useEngineReport } from "./useEngine";
import { PipelineStages } from "./PipelineStages";

const shell = {
  background: "linear-gradient(160deg,#fff 60%,#f0fdf4)",
  boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)",
} as const;

const PRIORITY: Record<string, string> = {
  P1: "bg-red-50 text-red-700",
  P2: "bg-orange-50 text-orange-700",
  P3: "bg-blue-50 text-blue-700",
};
const STATUS_LABEL: Record<string, string> = {
  awaiting_review: "Awaiting human review",
  published: "Published",
  rejected: "Rejected as noise",
  merged: "Merged",
};

/** Incidents produced by the live engine, each opening its investigation. */
export function EngineIncidentsCard({ note }: { note?: string }) {
  const { data: queue } = useEngineQueue();
  if (!queue || queue.length === 0) return null;
  return (
    <section className="kpi-card rounded-2xl border border-green-200 p-4" style={shell}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Live engine incidents</h2>
          <p className="text-xs text-gray-600">{note ?? "From the latest injected run. Open one to see why its signals were grouped, the root cause, and the ticket."}</p>
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {queue.map((q) => (
          <li key={q.draft_id}>
            <Link
              href={`/review/${encodeURIComponent(q.draft_id)}`}
              className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white/80 hover:border-green-300 hover:bg-green-50/50 px-3 py-2.5 transition-colors"
            >
              <span className={clsx("text-[11px] font-bold px-2.5 py-1 rounded-lg shrink-0", PRIORITY[q.priority] ?? "bg-gray-100 text-gray-700")}>
                {q.priority}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold text-gray-900 truncate" title={q.title}>{q.title}</span>
                <span className="block text-[11px] text-gray-600">
                  {q.signal_count} signals · {q.affected_services.length} services · confidence {q.correlation_confidence.toFixed(2)} · root cause {q.causal_confidence}%
                </span>
              </span>
              <span className={clsx("text-[11px] font-semibold rounded-full px-2.5 py-1 shrink-0 border",
                q.status === "published" ? "bg-green-100 text-green-800 border-green-200" : "bg-amber-50 text-amber-800 border-amber-200")}>
                {q.jira_key ?? STATUS_LABEL[q.status] ?? q.status}
              </span>
              <HiOutlineArrowRight size={14} className="text-gray-400 shrink-0" />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Measured against the scenario's own ground truth, not asserted. */
export function EngineEvaluationCard() {
  const { data: report } = useEngineReport();
  const { injectGolden } = useEngineActions();
  const ev = report?.evaluation;
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  return (
    <section className="kpi-card rounded-2xl border border-green-200 p-4" style={shell}>
      <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
        <div>
          <h2 className="text-sm font-bold text-gray-900">Latest engine run — measured against ground truth</h2>
          <p className="text-xs text-gray-600">
            The scenario generator knows which signals really belong together. It hands the pipeline no answers, then scores the result.
          </p>
        </div>
        <button
          onClick={() => injectGolden()}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-green-800 border border-green-300 bg-green-50 hover:bg-green-100 rounded-lg px-3 py-1.5"
        >
          <LuZap size={13} /> Replay golden incident
        </button>
      </div>

      {!ev ? (
        <p className="text-sm text-gray-700">No engine run yet. Use “Replay golden incident” or Inject failure on Overview.</p>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
            {[
              { l: "Incidents", v: `${ev.incidents_formed} of ${ev.incidents_expected} expected`, ok: ev.incidents_formed === ev.incidents_expected },
              { l: "Pair precision (no false merges)", v: pct(ev.pair_precision), ok: ev.pair_precision >= 0.99 },
              { l: "Pair recall (no false splits)", v: pct(ev.pair_recall), ok: ev.pair_recall >= 0.99 },
              { l: "Cluster purity", v: pct(ev.cluster_purity), ok: ev.cluster_purity >= 0.99 },
              { l: "Root cause correct", v: `${ev.root_cause_correct} of ${ev.root_cause_total}`, ok: ev.root_cause_correct === ev.root_cause_total },
              { l: "Noise correctly excluded", v: pct(ev.noise_precision), ok: ev.noise_precision >= 0.99 },
              { l: "Signals ingested", v: String(report?.signals_ingested ?? 0), ok: true },
              { l: "Auto-published tickets", v: String(report?.auto_published ?? 0), ok: (report?.auto_published ?? 0) === 0 },
            ].map((m) => (
              <div key={m.l} className={clsx("rounded-xl border px-3 py-2.5", m.ok ? "border-green-200 bg-white" : "border-amber-300 bg-amber-50")}>
                <div className="flex items-center gap-1.5 text-lg font-extrabold text-gray-900 tabular-nums">
                  {m.ok ? <HiOutlineCheckCircle className="text-green-600" size={18} /> : <HiOutlineExclamationTriangle className="text-amber-600" size={18} />}
                  {m.v}
                </div>
                <div className="text-[11px] text-gray-700 mt-0.5">{m.l}</div>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-gray-600 mt-2">Scenario: {report?.scenario}</p>
          <p className="text-[11px] text-gray-600">
            One run is a sanity check{ev.true_pairs !== undefined && <> ({ev.correct_pairs} of {ev.true_pairs} true pairs)</>}, not an
            accuracy estimate — the held-out engine benchmark above is.
          </p>
        </>
      )}
    </section>
  );
}

/** Stage-by-stage trace of the latest run, with timings and degraded dependencies. */
export function EnginePipelineSection() {
  const { data: report } = useEngineReport();
  const { data: queue } = useEngineQueue();
  if (!report || !report.scenario) {
    return (
      <section className="kpi-card rounded-2xl border border-green-200 p-4" style={shell}>
        <h2 className="text-sm font-bold text-gray-900">Live engine</h2>
        <p className="text-sm text-gray-700 mt-1">No run yet. Use Inject failure on Overview to send telemetry through the real pipeline.</p>
      </section>
    );
  }

  const stages = Object.entries(report.elapsed_ms);
  const slowest = Math.max(1, ...stages.map(([, ms]) => ms));
  const llmDegraded = (queue ?? []).some((q) => q.summary_source === "template");
  const redacted = Object.values(report.redaction_counts).reduce((a, b) => a + b, 0);
  const health: { label: string; state: "ok" | "degraded"; note: string }[] = [
    { label: "Human review gate", state: "ok", note: `${report.auto_published} auto-published, always` },
    { label: "Redaction", state: "ok", note: `${redacted} field(s) redacted before processing; NER ${report.redaction_backends.ner ? "on" : "off (regex only)"}` },
    { label: "LLM narrative", state: llmDegraded ? "degraded" : "ok", note: llmDegraded ? "not configured: drafts use the deterministic template, review still works" : "grounded summaries active" },
    { label: "Jira", state: "degraded", note: "mock transport (real REST client is a swap, no workflow change)" },
    ...(report.calibration_warning ? [{ label: "P1 calibration", state: "degraded" as const, note: report.calibration_warning }] : []),
  ];

  return (
    <div className="flex flex-col gap-4">
      <PipelineStages report={report} queue={queue ?? []} />
      <section className="kpi-card rounded-2xl border border-green-200 p-4" style={shell}>
        <h2 className="text-sm font-bold text-gray-900 mb-3">Run health</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-700 mb-2">Time per stage</h3>
            <ul className="space-y-1.5">
              {stages.map(([name, ms]) => (
                <li key={name} className="text-xs">
                  <div className="flex justify-between"><span className="capitalize text-gray-800">{name.replace(/_/g, " ")}</span><span className="tabular-nums text-gray-700">{ms} ms</span></div>
                  <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden mt-0.5">
                    <div className="kpi-hbar h-full rounded-full bg-green-600" style={{ width: `${Math.max(3, (ms / slowest) * 100)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-gray-600 mt-2">
              Blocking compared {report.candidate_pairs.toLocaleString()} of {report.possible_pairs.toLocaleString()} possible pairs ({report.blocking_saved_pct}% skipped).
            </p>
          </div>
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-700 mb-2">Dependencies</h3>
            <ul className="space-y-1.5">
              {health.map((h) => (
                <li key={h.label} className="flex gap-2 text-xs">
                  <span className={clsx("mt-0.5 w-2 h-2 rounded-full shrink-0", h.state === "ok" ? "bg-green-600" : "bg-amber-500")} />
                  <span><b className="text-gray-900">{h.label}</b> <span className="text-gray-700">{h.note}</span></span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}
