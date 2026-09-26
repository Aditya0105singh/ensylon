"use client";

import { Text } from "@tremor/react";
import {
  HiOutlineArrowDownTray,
  HiOutlineDocumentDuplicate,
  HiOutlinePresentationChartLine,
  HiOutlineSparkles,
  HiOutlineChartBar,
  HiOutlineDocumentText,
  HiOutlineShieldCheck,
} from "react-icons/hi2";
import { TbChartDots3 } from "react-icons/tb";
import type { PipelineReport, QueueSummary } from "./types";

// Mirrors the 8-stage pipeline diagram in the Phase 1 design submission
// (Section 1 / closing page), but wired to a real run instead of frozen
// illustrative numbers. PURPOSE/ALGORITHM/PARAMETERS text is static — it
// describes the fixed algorithm, which doesn't change run to run — while
// every number is read straight from the last /engine/demo/run response.

interface Stage {
  n: number;
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  accent: string; // tailwind color token, e.g. "orange"
  stat: React.ReactNode;
  statLabel: string;
  badge?: string;
  purpose: string;
  algorithm: string;
  parameters: string;
  inputs: string;
  outputs: string;
}

const ACCENT = {
  orange: { text: "text-orange-600", bg: "bg-orange-50", ring: "ring-orange-100", bar: "bg-orange-400" },
  blue: { text: "text-blue-600", bg: "bg-blue-50", ring: "ring-blue-100", bar: "bg-blue-400" },
  emerald: { text: "text-emerald-600", bg: "bg-emerald-50", ring: "ring-emerald-100", bar: "bg-emerald-400" },
  indigo: { text: "text-indigo-600", bg: "bg-indigo-50", ring: "ring-indigo-100", bar: "bg-indigo-400" },
  purple: { text: "text-purple-600", bg: "bg-purple-50", ring: "ring-purple-100", bar: "bg-purple-400" },
  red: { text: "text-red-600", bg: "bg-red-50", ring: "ring-red-100", bar: "bg-red-400" },
  violet: { text: "text-violet-600", bg: "bg-violet-50", ring: "ring-violet-100", bar: "bg-violet-400" },
  amber: { text: "text-amber-700", bg: "bg-amber-50", ring: "ring-amber-100", bar: "bg-amber-400" },
} as const;

function StageCard({ stage, delay }: { stage: Stage; delay: number }) {
  const a = ACCENT[stage.accent as keyof typeof ACCENT];
  const Icon = stage.icon;
  return (
    <div
      className="relative rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden animate-fadeInUp transition-shadow hover:shadow-md"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className={`absolute top-0 left-0 right-0 h-0.5 ${a.bar}`} />
      <div className="p-3.5">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5">
            <span
              className={`flex items-center justify-center w-5 h-5 rounded-full ${a.bg} ${a.text} text-[11px] font-bold ring-1 ${a.ring}`}
            >
              {stage.n}
            </span>
            <Text className="text-xs font-semibold text-gray-700">{stage.title}</Text>
          </div>
          <div className={`rounded-lg ${a.bg} ${a.text} p-1 ring-1 ${a.ring}`}>
            <Icon size={13} />
          </div>
        </div>

        <div className="flex items-baseline gap-1.5 mb-0.5">
          <span className="text-xl font-bold text-gray-900 tabular-nums">{stage.stat}</span>
        </div>
        <div className="flex items-center gap-1.5 mb-2">
          <Text className="text-[10px] text-gray-400">{stage.statLabel}</Text>
          {stage.badge && (
            <span className={`text-[10px] font-medium rounded-full px-1.5 py-0.5 ${a.bg} ${a.text}`}>
              {stage.badge}
            </span>
          )}
        </div>

        <div className="space-y-1.5 border-t border-gray-100 pt-2">
          <div>
            <Text className="text-[9px] uppercase tracking-wider text-gray-400 font-semibold">Purpose</Text>
            <Text className="text-[10.5px] text-gray-600 leading-snug">{stage.purpose}</Text>
          </div>
          <div>
            <Text className="text-[9px] uppercase tracking-wider text-gray-400 font-semibold">Algorithm</Text>
            <Text className="text-[10.5px] text-gray-600 leading-snug">{stage.algorithm}</Text>
          </div>
          <div>
            <Text className="text-[9px] uppercase tracking-wider text-gray-400 font-semibold">Parameters</Text>
            <Text className="text-[10.5px] text-gray-600 leading-snug font-mono">{stage.parameters}</Text>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 mt-2 pt-2 border-t border-gray-100">
          <div>
            <Text className="text-[9px] uppercase tracking-wider text-gray-400 font-semibold">Inputs</Text>
            <Text className="text-[10px] text-gray-500 leading-snug">{stage.inputs}</Text>
          </div>
          <div>
            <Text className="text-[9px] uppercase tracking-wider text-gray-400 font-semibold">Outputs</Text>
            <Text className="text-[10px] text-gray-500 leading-snug">{stage.outputs}</Text>
          </div>
        </div>
      </div>
    </div>
  );
}

export function PipelineStages({
  report,
  queue,
}: {
  report: PipelineReport;
  queue: QueueSummary[];
}) {
  const redactedFields = Object.values(report.redaction_counts).reduce((a, b) => a + b, 0);
  const p1 = report.priorities.P1 ?? 0;
  const p2 = report.priorities.P2 ?? 0;
  const p3 = report.priorities.P3 ?? 0;
  const awaiting = queue.filter((q) => q.status === "awaiting_review").length;
  const published = queue.filter((q) => q.status === "published").length;

  const stages: Stage[] = [
    {
      n: 1,
      title: "Ingest & Redact",
      icon: HiOutlineArrowDownTray,
      accent: "orange",
      stat: report.signals_ingested,
      statLabel: "signals ingested",
      badge: `${redactedFields} fields redacted`,
      purpose: "Receive telemetry from every source and normalize to one Signal envelope before anything downstream touches it.",
      algorithm: "SSE reader per stream (Last-Event-ID resume) → parser → PII redaction (emails, IPs, sessions, accounts, cloud account ids, service accounts, phones, names) → canonical schema.",
      parameters: "Redaction happens inside the parser: no raw value exists past this stage, on disk or in a prompt.",
      inputs: "The three Nexus SSE streams: application logs, CloudWatch alarms, Grafana alerts",
      outputs: `${report.signals_ingested} normalized, redacted Signal envelopes`,
    },
    {
      n: 2,
      title: "Deduplicate",
      icon: HiOutlineDocumentDuplicate,
      accent: "blue",
      stat: report.unique_signals,
      statLabel: "unique signals",
      badge: `${report.dedup_collapsed} collapsed (${report.dedup_collapsed_pct}%)`,
      purpose: "Collapse repeated firings of the same underlying condition — a stuck check re-fires every evaluation interval.",
      algorithm: "Fingerprint match on service + component + log template/alert name + time bucket, keeping the earliest of each group with an occurrence count.",
      parameters: `bucket = ${report.dedup_bucket_minutes || 5} minutes`,
      inputs: `${report.signals_ingested} signals`,
      outputs: `${report.unique_signals} unique (occurrence counts preserved)`,
    },
    {
      n: 3,
      title: "Detect",
      icon: HiOutlinePresentationChartLine,
      accent: "emerald",
      stat: report.anomalies_detected,
      statLabel: "anomalous signals",
      badge: `${report.within_baseline} within baseline`,
      purpose: "Establish per-source baselines and flag genuine deviations, so correlation runs on anomalies rather than on all traffic.",
      algorithm: "EWMA baseline + z-score for metrics · Drain3 template mining for novel and bursting log errors · alarms and alerts are scored by how far past their threshold they are.",
      parameters: "anomaly_score ≥ 0.60 · z ≥ 3.0 · EWMA α = 0.3",
      inputs: `${report.unique_signals} unique signals`,
      outputs: `${report.anomalies_detected} flagged anomalous`,
    },
    {
      n: 4,
      title: "Correlate",
      icon: TbChartDots3,
      accent: "indigo",
      stat: report.incidents_formed,
      statLabel: "incident clusters",
      badge: `${report.noise_signals} kept as noise`,
      purpose: "Group signals that belong to one incident — never force unrelated signals together.",
      algorithm: "A structural gate first (same service, dependency edge, component, or service named in the evidence), then a five-dimension similarity, then DBSCAN. Time alone never links two signals.",
      parameters: "0.25 T + 0.20 S + 0.20 D + 0.20 E + 0.15 C · merge at ≥ 0.34 · 15 min window",
      inputs: `${report.anomalies_detected} anomalous · ${report.possible_pairs} possible pairs, ${report.candidate_pairs} scored after blocking`,
      outputs: `${report.incidents_formed} clusters, ${report.noise_signals} background noise`,
    },
    {
      n: 5,
      title: "Causal Engine",
      icon: HiOutlineSparkles,
      accent: "violet",
      stat: report.root_causes_identified,
      statLabel: "root causes identified",
      badge: report.causal_splits.length > 0 ? `${report.causal_splits.length} concurrent split(s)` : undefined,
      purpose: "Move beyond correlation — determine what actually caused the incident, and separate causes from downstream symptoms.",
      algorithm: "Temporal precedence → the reference dependency graph → evidence across metrics, logs and alerts → cause-versus-symptom separation → counterfactual check by graph ablation.",
      parameters: "Ablation test: remove the candidate node; if remaining signals still have an explanation path, reject the candidate.",
      inputs: `${report.incidents_formed} clusters + service dependency graph`,
      outputs: `${report.root_causes_identified} root causes with causal confidence scores`,
    },
    {
      n: 6,
      title: "Score & Impact",
      icon: HiOutlineChartBar,
      accent: "red",
      stat: p1,
      statLabel: "P1 incident(s)",
      badge: `${p2} P2 · ${p3} P3`,
      purpose: "Validate each candidate, then score it on two separate scales: impact severity and correlation confidence.",
      algorithm: "Five validation checks decide whether a candidate is raised. Impact severity = blast radius, business criticality, anomaly magnitude. Confidence = density, topology support, evidence agreement. Never blended.",
      parameters: "impact 0-100 = 100 × (0.40 blast + 0.35 criticality + 0.25 magnitude) · P1 ≥ 75, P2 ≥ 50, P3 ≥ 25 · confidence 0-1",
      inputs: `${report.incidents_formed} incidents`,
      outputs: `${p1} P1 · ${p2} P2 · ${p3} P3`,
    },
    {
      n: 7,
      title: "Explain & Draft",
      icon: HiOutlineDocumentText,
      accent: "amber",
      stat: report.drafts_created,
      statLabel: "ticket drafts",
      badge: `${report.elapsed_ms.causal_score_draft ?? 0}ms`,
      purpose: "Produce a well-formed ticket a human can act on immediately.",
      algorithm: "Title, severity, services, source-labelled timeline and facts are assembled deterministically. Claude writes only the summary, the suspected root cause (as a hypothesis) and investigation steps, and is discarded if it names anything outside the incident.",
      parameters: "The model never sources a fact. Without a key, a template draft is used.",
      inputs: `${report.drafts_created} scored incidents + causal evidence`,
      outputs: `${report.drafts_created} structured ticket drafts, status AWAITING REVIEW`,
    },
    {
      n: 8,
      title: "Human Review Gate",
      icon: HiOutlineShieldCheck,
      accent: "orange",
      stat: awaiting,
      statLabel: "awaiting review",
      badge: `${report.auto_published} auto-published`,
      purpose: "No ticket file is written without a named human decision. Hard constraint.",
      algorithm: "Approve / Edit and approve / Reject. Writing to output/tickets/ requires a single-use approval token only this queue can mint — no code path bypasses it.",
      parameters: "Idempotent write (draft id is the key) · every decision is audited with the reviewer name.",
      inputs: `${report.drafts_created} drafts`,
      outputs: `${published} ticket file(s) written — only on approval`,
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <Text className="text-[11px] uppercase tracking-wider text-gray-400">
          Pipeline — how raw signals become an actionable, human-approved incident
        </Text>
        <Text className="text-[10px] text-gray-400">live, from the last run</Text>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {stages.map((s, i) => (
          <StageCard key={s.n} stage={s} delay={i * 40} />
        ))}
      </div>
    </div>
  );
}
