"use client";

import Link from "next/link";
import clsx from "clsx";
import {
  HiArrowDown,
  HiArrowRight,
  HiCheckCircle,
  HiXCircle,
  HiOutlineSparkles,
  HiOutlineDocumentText,
} from "react-icons/hi2";
import type { DraftDetail, Evidence, QueueSummary, ServiceGraph } from "@/entities/engine/types";
import { PRIORITY_COLOR, SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";
import {
  MERGE_THRESHOLD,
  canonicalSource,
  cleanTitle,
  clockUTC,
  correlationBreakdown,
  impact,
  offset,
  propagationPath,
  type PropagationStep,
} from "./lib";
import { PropagationMap } from "./PropagationMap";

const STATUS_LABEL: Record<string, { text: string; cls: string }> = {
  awaiting_review: { text: "Needs human review", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  published: { text: "Approved · ticket written", cls: "bg-green-100 text-green-800 border-green-200" },
  rejected: { text: "Rejected by reviewer", cls: "bg-gray-100 text-gray-700 border-gray-200" },
  merged: { text: "Merged", cls: "bg-gray-100 text-gray-700 border-gray-200" },
};

function Block({ title, sub, children, className }: { title: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={clsx("rounded-xl border border-gray-100 bg-white p-3.5 min-w-0", className)}>
      <h3 className="text-[11px] font-bold uppercase tracking-wider text-gray-500">{title}</h3>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5">{sub}</p>}
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function Metric({ label, value, sub, bar, color }: { label: string; value: React.ReactNode; sub?: string; bar?: number; color?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">{label}</div>
      <div className="text-xl font-extrabold text-gray-900 leading-tight">{value}</div>
      {bar != null && (
        <div className="mt-1 h-1.5 w-full rounded-full bg-gray-100 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, bar * 100)}%`, background: color ?? "#16a34a" }} />
        </div>
      )}
      {sub && <div className="text-[10.5px] text-gray-500 mt-0.5 truncate">{sub}</div>}
    </div>
  );
}

function Propagation({ path, rootDetail, rootConfidence, color }: { path: PropagationStep[]; rootDetail: string; rootConfidence: number; color: string }) {
  if (path.length === 0) return <p className="text-xs text-gray-500">No causal ranking for this incident.</p>;
  const t0 = path[0].firstSeen;
  return (
    <ol className="flex flex-col">
      {path.map((p, i) => (
        <li key={p.service} className="flex flex-col">
          {i > 0 && (
            <span className="flex items-center gap-1.5 pl-3 py-0.5 text-[10.5px] text-gray-500">
              <HiArrowDown style={{ color }} />
              {p.from ? `symptom of ${p.from}` : "also affected"}
            </span>
          )}
          <div
            className={clsx("rounded-lg border px-2.5 py-2", p.isRoot ? "text-white" : "bg-white")}
            style={p.isRoot ? { background: color, borderColor: color } : { borderColor: "#fecaca" }}
          >
            <div className="flex items-center justify-between gap-2">
              <span className={clsx("text-sm font-bold truncate", p.isRoot ? "text-white" : "text-gray-900")}>{p.service}</span>
              <span className={clsx("text-[10.5px] font-mono shrink-0", p.isRoot ? "text-white/85" : "text-gray-500")}>
                {p.firstSeen && t0 ? (i === 0 ? clockUTC(p.firstSeen) : offset(t0, p.firstSeen)) : ""}
              </span>
            </div>
            {p.isRoot ? (
              <>
                <div className="text-[11px] text-white/90 mt-0.5">{rootDetail}</div>
                <div className="text-[10.5px] text-white/80 mt-1">Probable origin · {Math.round(rootConfidence * 100)}% causal confidence (inferred, not proven)</div>
              </>
            ) : (
              <div className="text-[11px] text-gray-600 mt-0.5">{p.signals} signal{p.signals === 1 ? "" : "s"} · knock-on failure</div>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function FormationTimeline({ detail, priority }: { detail: DraftDetail; priority: string }) {
  const tl = detail.timeline ?? [];
  if (tl.length === 0) return <p className="text-xs text-gray-500">No timeline yet.</p>;
  const t0 = tl[0].at;
  const shown = tl.slice(0, 7);
  return (
    <ol className="relative flex flex-col gap-2.5 pl-4">
      <span aria-hidden className="absolute left-[5px] top-1.5 bottom-1.5 w-px bg-gray-200" />
      {shown.map((t, i) => {
        const src = canonicalSource(t.source);
        return (
          <li key={`${t.at}-${i}`} className="relative timeline-step" style={{ animationDelay: `${i * 90}ms` }}>
            <span className="absolute -left-4 top-1 w-2.5 h-2.5 rounded-full ring-2 ring-white" style={{ background: SOURCE_COLOR[src] }} />
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[10.5px] text-gray-500 w-[60px] shrink-0">{i === 0 ? clockUTC(t.at).slice(0, 8) : offset(t0, t.at)}</span>
              <span className="text-xs font-semibold text-gray-900 truncate">{t.service}</span>
              <span className="text-[10px] text-gray-500 shrink-0">{SOURCE_NAME[src]?.split(" ")[0]}</span>
            </div>
            <div className="pl-[68px] text-[11px] text-gray-700 leading-snug line-clamp-2" title={t.detail}>
              {t.detail}{t.count > 1 ? ` (×${t.count})` : ""}
            </div>
          </li>
        );
      })}
      {tl.length > shown.length && <li className="pl-[68px] text-[11px] text-gray-500">+{tl.length - shown.length} more signals</li>}
      <li className="relative">
        <span className="absolute -left-[19px] top-0.5 w-3.5 h-3.5 rounded-full ring-2 ring-white" style={{ background: PRIORITY_COLOR[priority] }} />
        <div className="pl-[68px] text-xs font-bold text-gray-900">Correlated → {priority} incident drafted</div>
      </li>
    </ol>
  );
}

function WhyCorrelated({ ev }: { ev: Evidence }) {
  const { dims, total, joins } = correlationBreakdown(ev);
  const maxW = Math.max(...dims.map((d) => d.weight), 0.01);
  const gates = Object.entries(ev.correlation.confidence.gate_reasons ?? {});
  const validation = ev.correlation.confidence.validation ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {dims.map((d) => (
          <div key={d.key} className="grid grid-cols-[1fr_auto] gap-x-2 items-center">
            <div className="min-w-0">
              <div className="flex items-baseline justify-between text-[11px]">
                <span className="text-gray-800"><b className="font-mono text-gray-500 mr-1">{d.code}</b>{d.label}</span>
                <span className="text-gray-500">w {d.weight.toFixed(2)}</span>
              </div>
              <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden mt-0.5">
                <div className="absolute inset-y-0 left-0 bg-green-100" style={{ width: `${(d.weight / maxW) * 100}%` }} />
                <div className="absolute inset-y-0 left-0 bg-green-600 rounded-full" style={{ width: `${(d.contribution / maxW) * 100}%` }} />
              </div>
            </div>
            <span className="font-mono text-xs font-bold text-gray-900 w-10 text-right">{d.contribution.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center justify-between rounded-lg bg-green-50 border border-green-100 px-2.5 py-1.5">
        <span className="text-[11px] text-green-900">
          Mean similarity over {joins} join{joins === 1 ? "" : "s"}
        </span>
        <span className="text-sm font-extrabold text-green-900">
          {total.toFixed(2)} <span className="text-[11px] font-semibold text-green-700">≥ {MERGE_THRESHOLD} merge</span>
        </span>
      </div>
      {gates.length > 0 && (
        <div>
          <div className="text-[10.5px] text-gray-500 mb-1">Structural evidence (time alone never links)</div>
          <div className="flex flex-wrap gap-1">
            {gates.map(([g, n]) => (
              <span key={g} className="rounded-full bg-blue-50 border border-blue-100 text-blue-800 text-[10.5px] font-semibold px-2 py-0.5">
                {g}{n > 1 ? ` ×${n}` : ""}
              </span>
            ))}
          </div>
        </div>
      )}
      {validation.length > 0 && (
        <div>
          <div className="text-[10.5px] text-gray-500 mb-1">
            Validation: {validation.filter((v) => v.passed).length}/{validation.length} checks passed
          </div>
          <ul className="flex flex-col gap-0.5">
            {validation.map((v) => (
              <li key={v.name} className="flex items-start gap-1.5 text-[11px]">
                {v.passed ? <HiCheckCircle className="text-green-600 mt-0.5 shrink-0" /> : <HiXCircle className="text-red-600 mt-0.5 shrink-0" />}
                <span><b className="text-gray-800">{v.name}</b> <span className="text-gray-600">· {v.detail}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DecisionTrail({ q, ev, detail }: { q: QueueSummary; ev: Evidence; detail?: DraftDetail }) {
  const { total } = correlationBreakdown(ev);
  const validation = ev.correlation.confidence.validation ?? [];
  const passed = validation.filter((v) => v.passed).length;
  const magnitude = ev.severity.factors.find((f) => f.key === "anomaly_magnitude")?.value;
  const drafter = detail?.drafted_by && detail.drafted_by !== "template" ? detail.drafted_by : q.summary_source === "llm" ? "Claude" : "template";
  const steps = [
    { k: "Detected", v: `${ev.unique_signals} anomalous`, s: magnitude != null ? `peak score ${magnitude.toFixed(2)}` : "" },
    { k: "Correlated", v: `similarity ${total.toFixed(2)}`, s: `merge at ≥ ${MERGE_THRESHOLD}` },
    { k: "Validated", v: `${passed}/${validation.length || 4} checks`, s: "env · bridge · coherence · anomaly" },
    { k: "Scored", v: `${q.priority} · impact ${impact(q)}`, s: `confidence ${q.correlation_confidence.toFixed(2)}` },
    { k: "Drafted", v: drafter === "template" ? "Template" : "Claude", s: drafter === "template" ? "Claude off: deterministic draft" : drafter },
    { k: "Human", v: q.status === "awaiting_review" ? "Awaiting review" : STATUS_LABEL[q.status]?.text ?? q.status, s: q.status === "published" && q.jira_key ? q.jira_key : "approve · edit · reject" },
  ];
  return (
    <ol className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-2">
      {steps.map((s, i) => (
        <li key={s.k} className="relative rounded-lg border border-gray-100 bg-gray-50/70 px-2.5 py-2">
          <div className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider text-gray-500">
            <span className="w-4 h-4 rounded-full bg-green-600 text-white text-[9px] flex items-center justify-center">{i + 1}</span>
            {s.k}
          </div>
          <div className="text-xs font-bold text-gray-900 mt-1 truncate">{s.v}</div>
          <div className="text-[10.5px] text-gray-500 truncate" title={s.s}>{s.s}</div>
          {i < steps.length - 1 && <HiArrowRight className="hidden xl:block absolute -right-2.5 top-1/2 -translate-y-1/2 text-gray-300 z-10" />}
        </li>
      ))}
    </ol>
  );
}

export function IncidentStory({
  q,
  ev,
  detail,
  graph,
  otherIncidentServices,
}: {
  q: QueueSummary;
  ev?: Evidence;
  detail?: DraftDetail;
  graph?: ServiceGraph;
  otherIncidentServices: Set<string>;
}) {
  const color = PRIORITY_COLOR[q.priority] ?? "#9ca3af";
  const status = STATUS_LABEL[q.status] ?? STATUS_LABEL.merged;
  const path = ev ? propagationPath(ev) : [];
  const rootSignal = ev?.signals.find((s) => s.is_root_cause_signal);
  const rootDetail =
    detail?.root_cause_detail?.replace(/^[^—]*—\s*/, "").replace(/\s*\(first seen [^)]*\)\s*$/, "") ??
    (rootSignal ? rootSignal.detection_reason : "");
  const raw = ev?.raw_signals ?? q.signal_count;
  const streams = ev ? new Set(ev.signals.map((s) => canonicalSource(s.source))).size : null;
  const facts = detail?.facts?.length ? detail.facts : (detail?.timeline ?? []).slice(0, 4).map((t) => `${t.service}: ${t.detail}`);
  const hypothesis = detail?.suspected_root_cause || (detail?.causal_reasoning ?? [])[0];
  const byClaude = q.summary_source === "llm" || (!!detail?.drafted_by && detail.drafted_by !== "template");

  return (
    <section
      className="story-card rounded-2xl border bg-white overflow-hidden"
      style={{ borderColor: `${color}55`, boxShadow: `0 1px 2px rgba(16,24,40,.05), 0 18px 40px -24px ${color}88` }}
      aria-label="Incident in focus"
    >
      <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${color}, ${color}55)` }} />
      <div className="p-4 md:p-5 flex flex-col gap-4">
        <header className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs font-extrabold text-white rounded-md px-2 py-0.5" style={{ background: color }}>{q.priority}</span>
              <span className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Incident in focus</span>
              <span className={clsx("text-[11px] font-semibold border rounded-full px-2 py-0.5", status.cls)}>{status.text}</span>
            </div>
            <h2 className="mt-1.5 text-xl md:text-2xl font-extrabold tracking-tight text-gray-900 break-words">{cleanTitle(q.title)}</h2>
            <p className="text-xs text-gray-600 mt-0.5">
              First signal {clockUTC(q.started_at)} UTC · {q.affected_services.length} service{q.affected_services.length === 1 ? "" : "s"}: {q.affected_services.join(", ")}
            </p>
          </div>
          <Link
            href={`/review/${q.draft_id}`}
            className="shrink-0 inline-flex items-center justify-center gap-1.5 rounded-xl bg-green-700 hover:bg-green-800 text-white text-sm font-bold px-4 py-2.5 shadow-sm transition-colors"
          >
            {q.status === "awaiting_review" ? "Review incident" : "Open incident"} <HiArrowRight />
          </Link>
        </header>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 rounded-xl bg-gray-50/80 border border-gray-100 p-3">
          <Metric label="Impact severity" value={<>{impact(q)}<span className="text-sm text-gray-500">/100</span></>} bar={q.severity_score} color={color}
            sub={ev ? ev.severity.factors.slice(0, 3).map((f) => `${f.label.split(" ")[0].toLowerCase()} ${f.value.toFixed(2)}`).join(" · ") : undefined} />
          <Metric label="Correlation confidence" value={q.correlation_confidence.toFixed(2)} bar={q.correlation_confidence}
            sub="density · topology · evidence" />
          <Metric label="Correlated signals" value={<>{q.signal_count}<span className="text-sm text-gray-500"> distinct</span></>}
            sub={`${raw} raw${streams != null ? ` from ${streams} stream${streams === 1 ? "" : "s"}` : ""}`} />
          <Metric label="Alert compression" value={<>{raw}<span className="text-sm text-gray-500"> → 1</span></>}
            sub="alerts a human would triage" />
        </div>

        {!ev ? (
          <p className="text-sm text-gray-500">Loading the evidence behind this incident…</p>
        ) : (
          <>
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <Block title="Probable origin → propagation" sub="From causal ranking + counterfactual test">
                <Propagation path={path} rootDetail={rootDetail} rootConfidence={ev.root_cause.confidence} color={color} />
              </Block>
              <Block title="How it formed" sub="Every signal, labelled with its source stream">
                {detail ? <FormationTimeline detail={detail} priority={q.priority} /> : <p className="text-xs text-gray-500">Loading…</p>}
              </Block>
              <Block title="Why these signals belong together" sub="Weighted contribution of each dimension">
                <WhyCorrelated ev={ev} />
              </Block>
            </div>

            {graph && graph.nodes.length > 0 && (
              <Block title="Propagation on the service dependency graph" sub="Reference graph from /sim/reference/service-dependency-graph">
                <PropagationMap graph={graph} path={path} priority={q.priority} otherIncidentServices={otherIncidentServices} />
              </Block>
            )}

            <Block title="Decision trail" sub="What the engine did, in order, before a human sees it">
              <DecisionTrail q={q} ev={ev} detail={detail} />
            </Block>
          </>
        )}

        {detail && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Block title="Observed evidence" sub="Facts computed by the engine, not by the model">
              <ul className="flex flex-col gap-1">
                {facts.map((f, i) => (
                  <li key={i} className="flex gap-1.5 text-xs text-gray-800">
                    <HiOutlineDocumentText className="text-gray-400 mt-0.5 shrink-0" />
                    <span className="break-words">{f}</span>
                  </li>
                ))}
              </ul>
            </Block>
            <Block title="Incident brief" sub={byClaude ? "Drafted by Claude from the facts only" : "Deterministic template draft (Claude drafting off)"}>
              <div className="flex gap-2">
                <HiOutlineSparkles className={clsx("mt-0.5 shrink-0", byClaude ? "text-violet-600" : "text-gray-400")} />
                <div className="min-w-0 flex flex-col gap-1.5">
                  <p className="text-xs text-gray-800 leading-relaxed">{detail.summary}</p>
                  {hypothesis && (
                    <p className="text-xs text-gray-700">
                      <b className="text-gray-900">Suspected root cause (hypothesis):</b> {hypothesis}
                    </p>
                  )}
                  {detail.investigation_steps?.length > 0 && (
                    <ol className="list-decimal pl-4 text-xs text-gray-700 space-y-0.5">
                      {detail.investigation_steps.slice(0, 3).map((s, i) => <li key={i}>{s}</li>)}
                    </ol>
                  )}
                </div>
              </div>
            </Block>
          </div>
        )}
      </div>
    </section>
  );
}
