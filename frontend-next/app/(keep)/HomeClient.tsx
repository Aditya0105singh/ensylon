"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import clsx from "clsx";
import {
  HiOutlineArrowRight,
  HiOutlineBell,
  HiOutlineCheckCircle,
  HiOutlineChevronRight,
  HiOutlineDocumentText,
  HiOutlineExclamationTriangle,
  HiOutlineInbox,
  HiOutlineMinusCircle,
  HiOutlineShare,
  HiOutlineShieldCheck,
  HiOutlineSparkles,
} from "react-icons/hi2";
import { AiOutlineAlert } from "react-icons/ai";
import { EmptyStateCard, KeepLoader } from "@/shared/ui";
import {
  useEvaluation,
  useIncidentPanel,
  usePipelineActions,
  usePipelineState,
  useSettingsStatus,
} from "@/entities/alertlens";
import type { Cluster } from "@/entities/alertlens";
import { DataSourceButtons } from "@/entities/alertlens/ui/DataSourceMenu";
import { TrendChart } from "@/entities/alertlens/ui/TrendChart";
import { SeverityDonut } from "@/entities/alertlens/ui/SeverityDonut";
import { VolumeChart } from "@/entities/alertlens/ui/VolumeChart";
import { KpiCards } from "@/entities/alertlens/ui/KpiCards";
import { InjectFailureButton } from "@/entities/engine/InjectFailureButton";
import { EngineRunCard } from "@/entities/engine/EngineRunCard";
import { EngineIncidentsCard } from "@/entities/engine/EngineCards";
import { useEngineQueue, useEngineReport } from "@/entities/engine/useEngine";
import { timeAgo } from "@/entities/alertlens/lib/format";

// ---------------------------------------------------------------------------
// Everything below is derived from the real pipeline / settings responses.
// ---------------------------------------------------------------------------

type IncidentStatus = "Open" | "Investigating" | "Resolved";

function deriveStatus(cluster: Cluster): IncidentStatus {
  const root = cluster.root_cause;
  if (root.dismissed) return "Resolved";
  if (root.escalated || (root.assignee && root.assignee !== "n/a")) return "Investigating";
  return "Open";
}

const STATUS_STYLE: Record<IncidentStatus, { pill: string; dot: string }> = {
  Open: { pill: "text-red-600 bg-red-50", dot: "bg-red-500" },
  Investigating: { pill: "text-orange-600 bg-orange-50", dot: "bg-orange-500" },
  Resolved: { pill: "text-blue-600 bg-blue-50", dot: "bg-blue-500" },
};

const SEVERITY_COLOR: Record<string, string> = {
  critical: "#ef4444",
  high: "#f97316",
  medium: "#eab308",
  low: "#22c55e",
  info: "#3b82f6",
};
const severityColor = (s: string) => SEVERITY_COLOR[s] ?? "#9ca3af";
const RISK_COLOR: Record<string, string> = { high: "#ef4444", medium: "#f97316", low: "#3b82f6" };
const PRIORITIES = ["P1", "P2", "P3", "P4"];
// Priority is banded from the measured escalation risk score - the pipeline has
// no separate priority field, so the bands (75/50/25%) are the only assumption.
function priorityOf(c: Cluster): string {
  const r = c.risk.score;
  return r >= 0.75 ? "P1" : r >= 0.5 ? "P2" : r >= 0.25 ? "P3" : "P4";
}
const PRIORITY_STYLE: Record<string, string> = {
  P1: "bg-red-50 text-red-700",
  P2: "bg-orange-50 text-orange-700",
  P3: "bg-blue-50 text-blue-700",
  P4: "bg-gray-100 text-gray-600",
};
const ROW_CAP = 10;

function lastSeen(cluster: Cluster): string {
  const stamps = cluster.alerts.map((a) => a.timestamp).sort();
  return stamps[stamps.length - 1] ?? cluster.root_cause.timestamp;
}

function fmtBucket(ms: number, span: number): string {
  const d = new Date(ms);
  const p2 = (n: number) => String(n).padStart(2, "0");
  if (span <= 24 * 3600000) return `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}h`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

// ---------------------------------------------------------------------------

export function HomeClient() {
  const { data: session } = useSession();
  const { state, isLoading, error } = usePipelineState();
  const { data: status } = useSettingsStatus();
  const { data: evaluation } = useEvaluation();
  const [riskFilter, setRiskFilter] = useState<string | null>(null);
  const { openIncident } = useIncidentPanel();
  const [showAll, setShowAll] = useState(false);
  const { loadBgl } = usePipelineActions();
  const autoLoaded = useRef(false);

  // Two different runs live in the backend at once: the loaded dataset (BGL /
  // synthetic) and the injected engine scenario. Mixing their numbers on one
  // screen made a 9,695-alert dataset and an 18-signal incident look like one
  // story, so the page shows exactly one of them, chosen here.
  const { data: engineReport } = useEngineReport();
  const { data: engineQueue } = useEngineQueue();
  const hasEngineRun = !!engineReport?.scenario;
  const [view, setView] = useState<"dataset" | "engine">("dataset");
  useEffect(() => {
    try {
      if (sessionStorage.getItem("overview-view") === "engine") setView("engine");
    } catch {}
  }, []);
  const chooseView = (v: "dataset" | "engine") => {
    setView(v);
    try {
      sessionStorage.setItem("overview-view", v);
    } catch {}
  };
  const effView = view === "engine" && hasEngineRun ? "engine" : "dataset";

  // First visit with nothing loaded: load the BGL sample once instead of
  // leaving a blank page. Only when the backend truly reports no dataset.
  const nothingLoaded = !isLoading && !state.dedup_stats && status?.dataset === "none";
  useEffect(() => {
    if (!nothingLoaded || autoLoaded.current) return;
    autoLoaded.current = true;
    loadBgl().catch(() => {});
  }, [nothingLoaded, loadBgl]);

  const alerts = state.raw_alerts;
  const clusters = state.clusters;

  const summary = useMemo(() => {
    const raw = state.dedup_stats?.raw_count ?? alerts.length;
    const unique = state.dedup_stats?.unique_count ?? alerts.length;
    const noise = raw && clusters.length ? Math.round(1000 * (1 - clusters.length / raw)) / 10 : 0;
    return { raw, unique, noise };
  }, [state.dedup_stats, alerts.length, clusters.length]);

  // Arrival volume over the whole batch, split into alerts that ended up in an
  // incident (correlated) vs everything ingested. The bucket width adapts to
  // the batch's span (minutes for a short batch, hours for a multi-day one) and
  // empty buckets are kept so quiet stretches between bursts stay visible.
  const buckets = useMemo(() => {
    if (!alerts.length) return [] as { label: string; total: number; correlated: number; noiseCum: number; incCum: number; critical: number }[];
    const clusteredIds = new Set(clusters.flatMap((c) => c.alerts.map((a) => a.id)));
    const points = alerts.map((a) => ({ t: new Date(a.timestamp).getTime(), corr: clusteredIds.has(a.id), crit: a.severity === "critical" }));
    const min = Math.min(...points.map((p) => p.t));
    const max = Math.max(...points.map((p) => p.t));
    const span = Math.max(max - min, 1);
    const widths = [1, 5, 15, 30, 60, 180, 360, 720, 1440].map((m) => m * 60000);
    const width = widths.find((w) => span / w <= 30) ?? widths[widths.length - 1];
    const start = Math.floor(min / width) * width;
    const count = Math.floor((max - start) / width) + 1;
    const out = Array.from({ length: count }, (_, i) => ({
      label: fmtBucket(start + i * width, span),
      total: 0,
      correlated: 0,
      noiseCum: 0,
      incCum: 0,
      critical: 0,
    }));
    for (const p of points) {
      const b = out[Math.floor((p.t - start) / width)];
      b.total += 1;
      if (p.corr) b.correlated += 1;
      if (p.crit) b.critical += 1;
    }
    // Cumulative noise reduction: 1 - (incidents opened so far / alerts so far).
    const opened = new Array(count).fill(0);
    for (const c of clusters) {
      const first = Math.min(...c.alerts.map((a) => new Date(a.timestamp).getTime()));
      opened[Math.min(count - 1, Math.max(0, Math.floor((first - start) / width)))] += 1;
    }
    let seen = 0;
    let inc = 0;
    out.forEach((b, i) => {
      seen += b.total;
      inc += opened[i];
      b.incCum = inc;
      b.noiseCum = seen ? Math.max(0, 100 * (1 - inc / seen)) : 0;
    });
    return out;
  }, [alerts, clusters]);

  const correlatedAlerts = useMemo(() => clusters.reduce((n, c) => n + c.size, 0), [clusters]);
  const spanText = useMemo(() => {
    if (alerts.length < 2) return "";
    const ts = alerts.map((a) => new Date(a.timestamp).getTime());
    const h = (Math.max(...ts) - Math.min(...ts)) / 3600000;
    return h >= 48 ? `${Math.round(h / 24)} days` : h >= 1 ? `${Math.round(h)}h` : `${Math.max(1, Math.round(h * 60))} min`;
  }, [alerts]);

  const severityCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of alerts) counts.set(a.severity, (counts.get(a.severity) ?? 0) + 1);
    const order = ["critical", "high", "medium", "low", "info"];
    const rank = (s: string) => (order.includes(s) ? order.indexOf(s) : order.length);
    return [...counts.entries()]
      .map(([severity, count]) => ({ severity, count }))
      .sort((a, b) => rank(a.severity) - rank(b.severity));
  }, [alerts]);

  const topServices = useMemo(() => {
    const counts = new Map<string, number>();
    for (const a of alerts) counts.set(a.service, (counts.get(a.service) ?? 0) + 1);
    return [...counts.entries()]
      .map(([service, count]) => ({ service, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [alerts]);

  const insights = useMemo(() => {
    const items: { icon: React.ElementType; tone: string; title: string; body: string; href: string }[] = [];
    const top = [...clusters].sort((a, b) => b.risk.score - a.risk.score)[0];
    if (top) {
      items.push({
        icon: HiOutlineExclamationTriangle,
        tone: "bg-orange-50 text-orange-600",
        title: `Highest risk: ${top.root_cause.alertname}`,
        body: `${Math.round(top.risk.score * 100)}% escalation risk on ${top.root_cause.service}`,
        href: `/incidents/${top.cluster_id}`,
      });
    }
    items.push({
      icon: HiOutlineShieldCheck,
      tone: "bg-green-50 text-green-600",
      title: `Noise reduced by ${summary.noise}%`,
      body: `${summary.raw} raw alerts became ${clusters.length} incident${clusters.length === 1 ? "" : "s"}`,
      href: "/correlations",
    });
    const matched = clusters.filter((c) => c.dna_match);
    if (matched.length) {
      const best = [...matched].sort(
        (a, b) => (b.dna_match?.similarity_pct ?? 0) - (a.dna_match?.similarity_pct ?? 0)
      )[0];
      items.push({
        icon: HiOutlineSparkles,
        tone: "bg-blue-50 text-blue-600",
        title: `${matched.length} incident${matched.length === 1 ? "" : "s"} match past ones`,
        body: `Best match ${best.dna_match?.incident_id} (${best.dna_match?.similarity_pct}% similar)`,
        href: `/timemachine/${best.cluster_id}`,
      });
    } else {
      items.push({
        icon: HiOutlineSparkles,
        tone: "bg-gray-100 text-gray-500",
        title: "No historical matches",
        body: "No incident resembles a past one yet",
        href: "/timemachine",
      });
    }
    return items;
  }, [clusters, summary]);

  const readiness = useMemo(() => {
    const loaded = !!status && status.dataset !== "none" && status.persisted_alert_count > 0;
    return {
      healthy: loaded,
      checks: [
        { label: `Data source (${status?.dataset ?? "none"})`, ok: loaded },
        { label: `Correlation engine (${clusters.length} active)`, ok: loaded },
        {
          label: status?.llm_configured ? `LLM service (${status.llm_provider})` : "LLM service (not configured)",
          ok: !!status?.llm_configured,
        },
        { label: "Human review gate (no auto-publish)", ok: true },
        { label: "Jira (mock transport)", ok: true },
      ],
    };
  }, [status, clusters.length]);

  const triageSaved = useMemo(
    () => Math.round(clusters.reduce((n, c) => n + (c.est_triage_minutes_saved ?? 0), 0)),
    [clusters]
  );

  const visibleClusters = useMemo(
    () =>
      [...clusters]
        .filter((c) => !riskFilter || priorityOf(c) === riskFilter)
        .sort((a, b) => b.risk.score - a.risk.score),
    [clusters, riskFilter]
  );

  const shown = showAll ? visibleClusters : visibleClusters.slice(0, ROW_CAP);

  if (isLoading || (nothingLoaded && autoLoaded.current)) {
    return <KeepLoader loadingText={nothingLoaded ? "Loading demo data..." : "Loading overview..."} />;
  }

  if (error) {
    return (
      <div className="p-4">
        <EmptyStateCard icon={AiOutlineAlert} title="Could not load overview" description={String(error)} />
      </div>
    );
  }

  const firstName = session?.user?.name?.split(" ")[0];
  const heading = (
    <div>
      <h1 className="text-2xl font-bold text-gray-900">
        {greeting()}
        {firstName ? `, ${firstName}` : ""}
      </h1>
      <p className="text-sm text-gray-500 mt-1">Turning noisy alerts into clear, actionable incidents.</p>
    </div>
  );

  if (!state.dedup_stats) {
    return (
      <div className="flex flex-col gap-4">
        {heading}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <EmptyStateCard noCard icon={HiOutlineInbox} title="No alert batch loaded" description="Load one of the datasets below to run the pipeline.">
            <DataSourceButtons />
          </EmptyStateCard>
        </div>
      </div>
    );
  }

  const maxBucket = Math.max(1, ...buckets.map((b) => b.total));
  const maxService = Math.max(1, ...topServices.map((s) => s.count));

  return (
    <div className="flex flex-col gap-4">
      <div
        className="kpi-card relative overflow-hidden rounded-2xl border border-green-100 px-6 py-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4"
        style={{ background: "linear-gradient(120deg,#f0fdf4 0%,#ffffff 55%,#ecfdf5 100%)", boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(22,163,74,.25)" }}
      >
        <div aria-hidden className="pointer-events-none absolute -right-10 -top-16 w-64 h-64 rounded-full bg-green-200/40 blur-3xl" />
        <div className="relative min-w-0">
          {heading}
          <div className="flex flex-wrap items-center gap-2 mt-3">
            {(effView === "engine" && engineReport
              ? [
                  [`Engine run: ${engineReport.scenario.split(":")[0]}`, "bg-gray-50 text-gray-700 border-gray-200"],
                  [`${engineReport.signals_ingested} signals`, "bg-white text-gray-700 border-gray-200"],
                  [`${engineReport.incidents_formed} incident${engineReport.incidents_formed === 1 ? "" : "s"}`, "bg-white text-gray-700 border-gray-200"],
                  [`${(engineQueue ?? []).filter((q) => q.status === "awaiting_review").length} awaiting review`, "bg-green-100 text-green-800 border-green-200"],
                ]
              : [
                  [`Dataset: ${status?.dataset === "restored-from-db" ? "last session" : (status?.dataset ?? "none")}`, "bg-gray-50 text-gray-700 border-gray-200"],
                  [`${summary.raw.toLocaleString()} alerts`, "bg-white text-gray-700 border-gray-200"],
                  [`${clusters.length} incidents`, "bg-white text-gray-700 border-gray-200"],
                  ...(clusters.length ? [[`${summary.noise}% less noise`, "bg-green-100 text-green-800 border-green-200"]] : []),
                ]
            ).map(([t, c]) => (
              <span key={t} className={clsx("rounded-full border px-2.5 py-1 text-xs font-semibold", c)}>
                {t}
              </span>
            ))}
            <span className="hidden xl:inline text-xs italic text-green-800 ml-1">
              &ldquo;Less noise. Faster answers. Happier on-calls.&rdquo;
            </span>
          </div>
        </div>
        <div className="relative flex flex-col items-start lg:items-end gap-1.5 shrink-0">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">Data source</span>
          <div className="flex items-center gap-2 flex-wrap lg:justify-end">
            <DataSourceButtons />
            <InjectFailureButton />
          </div>
        </div>
      </div>

      {hasEngineRun && (
        <div
          role="tablist"
          aria-label="What this page shows"
          className="inline-flex self-start rounded-full border border-gray-200 bg-white p-1 text-xs font-semibold shadow-sm"
        >
          {(
            [
              ["dataset", "Loaded dataset", status?.dataset && status.dataset !== "none" ? (status.dataset === "restored-from-db" ? "last session" : status.dataset) : ""],
              ["engine", "Live engine run", ""],
            ] as const
          ).map(([key, label, hint]) => (
            <button
              key={key}
              role="tab"
              aria-selected={effView === key}
              onClick={() => chooseView(key)}
              className={clsx(
                "rounded-full px-3.5 py-1.5 transition-colors",
                effView === key ? "bg-green-700 text-white" : "text-gray-600 hover:text-green-700"
              )}
            >
              {label}
              {hint && <span className={clsx("ml-1.5 font-normal", effView === key ? "text-green-100" : "text-gray-400")}>{hint}</span>}
            </button>
          ))}
        </div>
      )}

      {hasEngineRun && (
        <p className="-mt-2 text-xs text-gray-600">
          {effView === "engine"
            ? "The full engine: shared-context correlation, causal root cause, severity scoring and the human review gate."
            : "The baseline scale explorer: the loaded dataset grouped by alert text and time. Switch to the live engine run for full causal analysis."}
        </p>
      )}

      {effView === "engine" ? (
        <>
          <EngineRunCard />
          <EngineIncidentsCard note="Drafts from the injected run. Nothing is published until a named person approves." />
        </>
      ) : (
        <>
      <KpiCards
        d={{
          raw: summary.raw,
          unique: summary.unique,
          correlated: correlatedAlerts,
          incidents: clusters.length,
          noise: clusters.length ? summary.noise : null,
          totalSeries: buckets.map((b) => b.total),
          correlatedSeries: buckets.map((b) => b.correlated),
          incidentSeries: buckets.map((b) => b.incCum),
          peak: maxBucket,
          peakLabel: buckets.find((b) => b.total === maxBucket)?.label ?? "",
          p1: clusters.filter((c) => priorityOf(c) === "P1").length,
        }}
      />

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-3 items-start">
        <div className="min-w-0">
          {/* Recent incidents */}
          <div className="kpi-card rounded-2xl border border-white/80 overflow-hidden" style={{ background: "linear-gradient(160deg,#fff 60%,#f0fdf4)", boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)", animationDelay: "400ms" }}>
            <div className="flex items-center justify-between gap-2 flex-wrap p-3.5 border-b border-gray-100">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-gray-900 text-base mr-1">Active incidents <span className="text-green-700">({clusters.length})</span></span>
                <FilterPill active={riskFilter === null} onClick={() => setRiskFilter(null)}>
                  All {clusters.length}
                </FilterPill>
                {PRIORITIES.map((pr) => (
                  <FilterPill key={pr} active={riskFilter === pr} onClick={() => setRiskFilter(riskFilter === pr ? null : pr)}>
                    {pr} {clusters.filter((c) => priorityOf(c) === pr).length}
                  </FilterPill>
                ))}
              </div>
              <Link href="/incidents" className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 border border-gray-200 rounded-lg px-3 py-1.5 hover:border-green-300 hover:text-green-700">
                View all incidents <HiOutlineArrowRight size={12} />
              </Link>
            </div>

            {visibleClusters.length === 0 ? (
              <div className="p-6">
                <EmptyStateCard noCard icon={HiOutlineCheckCircle} title="No incidents match" description="Nothing correlated at this risk level." />
              </div>
            ) : (
              <>
              {/* Phones: one card per incident - a 640px table would hide the
                  Alerts / Risk / Status columns behind a sideways scroll. */}
              <ul className="md:hidden divide-y divide-gray-100">
                {shown.map((c) => {
                  const st = deriveStatus(c);
                  const svcs = [...new Set([c.root_cause.service, ...c.alerts.map((a) => a.service)])];
                  const sev = severityColor(c.root_cause.severity);
                  const risk = Math.round(c.risk.score * 100);
                  return (
                    <li key={c.cluster_id}>
                      <button
                        onClick={() => openIncident(c.cluster_id)}
                        aria-label={`Open incident ${c.root_cause.alertname}`}
                        className="w-full text-left p-3.5 flex flex-col gap-2 active:bg-green-50/60"
                      >
                        <div className="flex items-start gap-2.5">
                          <span className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${sev}1a`, color: sev }}>
                            <HiOutlineExclamationTriangle size={16} />
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="text-sm font-semibold text-gray-900 line-clamp-2 break-words">{c.root_cause.alertname}</div>
                            <div className="text-[11px] text-gray-400 mt-0.5">#{c.cluster_id} · {timeAgo(lastSeen(c))}</div>
                          </div>
                          <span className={clsx("inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap shrink-0", STATUS_STYLE[st].pill)}>
                            <span className={clsx("w-1.5 h-1.5 rounded-full", STATUS_STYLE[st].dot)} />
                            {st}
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {svcs.slice(0, 3).map((x) => (
                            <span key={x} className="text-[11px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{x}</span>
                          ))}
                          {svcs.length > 3 && <span className="text-[11px] text-gray-400 self-center">+{svcs.length - 3}</span>}
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-600 whitespace-nowrap w-[104px] shrink-0">
                            <span className="font-semibold text-gray-800">{c.size}</span> alerts <span className="text-gray-400">({c.raw_alert_count} raw)</span>
                          </span>
                          <div className="flex-1 flex items-center gap-1.5">
                            <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                              <div className="h-full rounded-full" style={{ width: `${risk}%`, background: RISK_COLOR[c.risk.level] ?? "#9ca3af" }} />
                            </div>
                            <span className="text-[11px] text-gray-500 w-8 text-right">{risk}%</span>
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>

              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b border-green-100/70 bg-green-50/40">
                      <th className="font-medium px-2.5 py-2 w-8">#</th>
                      <th className="font-medium px-2.5 py-2">Incident</th>
                      <th className="font-medium px-2.5 py-2">Priority</th>
                      <th className="font-medium px-2.5 py-2 hidden 2xl:table-cell">Root cause (AI)</th>
                      <th className="font-medium px-2.5 py-2">Affected services</th>
                      <th className="font-medium px-2.5 py-2">Signals</th>
                      <th className="font-medium px-2.5 py-2">Risk</th>
                      <th className="font-medium px-2.5 py-2">Status</th>
                      <th className="font-medium px-2.5 py-2 hidden 2xl:table-cell">Last updated</th>
                      <th className="w-6" />
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((c, i) => {
                      const st = deriveStatus(c);
                      const services = [...new Set([c.root_cause.service, ...c.alerts.map((a) => a.service)])];
                      const sev = severityColor(c.root_cause.severity);
                      return (
                        <tr
                          key={c.cluster_id}
                          onClick={() => openIncident(c.cluster_id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              openIncident(c.cluster_id);
                            }
                          }}
                          tabIndex={0}
                          aria-label={`Open incident ${c.root_cause.alertname}`}
                          style={{ animationDelay: `${500 + i * 60}ms` }}
                          className="kpi-row group cursor-pointer border-b border-gray-100/70 last:border-0 hover:bg-green-50/60 hover:shadow-[inset_3px_0_0_#16a34a] focus:outline-none focus-visible:bg-green-50 transition-all"
                        >
                          <td className="px-2.5 py-2.5 text-gray-400 text-xs">{i + 1}</td>
                          <td className="px-2.5 py-2.5">
                            <div className="flex items-center gap-2.5">
                              <span
                                className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-110"
                                style={{ background: `${sev}1f`, color: sev }}
                              >
                                <HiOutlineExclamationTriangle size={16} />
                              </span>
                              <div className="min-w-0">
                                {/* Two lines, not a 120px one-liner: BGL titles share long
                                    prefixes ("KERNTERM: rts: kernel terminated..."), so a hard
                                    single-line cut made rows look identical. Full text on hover. */}
                                <div
                                  className="font-semibold text-gray-900 line-clamp-2 break-words max-w-[260px] leading-snug"
                                  title={c.root_cause.alertname}
                                >
                                  {c.root_cause.alertname}
                                </div>
                                <div className="text-[11px] text-gray-400">#{c.cluster_id}</div>
                              </div>
                            </div>
                          </td>
                          <td className="px-2.5 py-2.5">
                            <span className={clsx("inline-block text-[11px] font-bold px-2.5 py-1 rounded-lg", PRIORITY_STYLE[priorityOf(c)])}>{priorityOf(c)}</span>
                          </td>
                          <td className="px-2.5 py-2.5 hidden 2xl:table-cell max-w-[220px]">
                            <div className="text-xs text-gray-500 line-clamp-2">{c.summary || `Root cause on ${c.root_cause.service}.`}</div>
                          </td>
                          <td className="px-2.5 py-2.5">
                            <div className="flex flex-wrap gap-1 max-w-[130px]">
                              {services.slice(0, 2).map((s) => (
                                <span key={s} className="text-[11px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">{s}</span>
                              ))}
                              {services.length > 2 && <span className="text-[11px] text-gray-400">+{services.length - 2}</span>}
                            </div>
                          </td>
                          <td className="px-2.5 py-2.5 whitespace-nowrap">
                            <span className="font-semibold text-gray-800">{c.size}</span>
                            <div className="text-[11px] text-gray-400">({c.raw_alert_count} collapsed)</div>
                          </td>
                          <td className="px-2.5 py-2.5 w-32">
                            <div className="flex items-center gap-1.5">
                              <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                                <div className="kpi-hbar h-full rounded-full" style={{ width: `${Math.round(c.risk.score * 100)}%`, background: RISK_COLOR[c.risk.level] ?? "#9ca3af", animationDelay: `${600 + i * 60}ms` }} />
                              </div>
                              <span className="text-[11px] text-gray-500 w-8 text-right">{Math.round(c.risk.score * 100)}%</span>
                            </div>
                          </td>
                          <td className="px-2.5 py-2.5">
                            <span className={clsx("inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full whitespace-nowrap", STATUS_STYLE[st].pill)}>
                              <span className={clsx("w-1.5 h-1.5 rounded-full", STATUS_STYLE[st].dot)} />
                              {st}
                            </span>
                          </td>
                          <td className="px-2.5 py-2.5 hidden 2xl:table-cell text-xs text-gray-400 whitespace-nowrap">{timeAgo(lastSeen(c))}</td>
                          <td className="pr-3 text-gray-300"><HiOutlineChevronRight size={14} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {visibleClusters.length > ROW_CAP && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full py-2.5 text-xs font-medium text-green-700 hover:bg-green-50/50 border-t border-gray-100"
                >
                  {showAll ? "Show fewer" : `Show all ${visibleClusters.length} incidents`}
                </button>
              )}
              </>
            )}
          </div>
          <div className="mt-3">
      <div className="grid grid-cols-1 min-[1400px]:grid-cols-[1.4fr_1fr] gap-3">
            {/* Alert volume & correlation */}
            <Panel title="Alert volume & correlation" delay={450}>
              <VolumeChart buckets={buckets} />
            </Panel>
            <Panel title="Noise reduction trend" delay={550}>
              <TrendChart
                points={(() => {
                  let seen = 0;
                  return buckets.map((b) => {
                    seen += b.total;
                    return { label: b.label, noise: b.noiseCum, alerts: seen, incidents: b.incCum };
                  });
                })()}
              />
            </Panel>
      </div>
          </div>
        </div>
        <div className="flex flex-col gap-3">
          <Panel title="AI Insights" icon={<HiOutlineSparkles className="text-green-600" size={16} />}>
            <ul className="flex flex-col gap-2">
              {insights.map((it) => (
                <li key={it.title}>
                  <Link href={it.href} className="flex items-center gap-2.5 rounded-lg border border-gray-100 p-2.5 hover:border-green-200 hover:bg-green-50/40 transition-colors">
                    <span className={clsx("w-7 h-7 rounded-full flex items-center justify-center shrink-0", it.tone)}>
                      <it.icon size={14} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs font-semibold text-gray-800 truncate" title={it.title}>{it.title}</span>
                      <span className="block text-[11px] text-gray-400 line-clamp-2">{it.body}</span>
                    </span>
                    <HiOutlineChevronRight size={13} className="text-gray-300 shrink-0" />
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>

          {evaluation && (
            <Panel
              title="Measured accuracy"
              right={
                <Link href="/evaluation" className="text-[11px] font-medium text-green-700 hover:underline">
                  Details
                </Link>
              }
            >
              <div className="grid grid-cols-2 gap-2">
                <Metric label="Incident detection" value={`${evaluation.incident_detection_pct}%`} />
                <Metric label="Cluster purity" value={`${evaluation.cluster_purity_pct}%`} />
                <Metric label="Noise excluded" value={`${evaluation.noise_excluded_pct}%`} />
                <Metric label="Triage saved" value={`~${triageSaved}m`} />
              </div>
              <p className="text-[11px] text-gray-400 mt-2.5">
                Scored against hidden ground truth over {evaluation.seeds_tested} seeds; the pipeline never reads it.
              </p>
            </Panel>
          )}

          <Panel title="On-call readiness">
            <div
              className={clsx(
                "rounded-lg px-3 py-2 mb-3 flex items-center gap-2 border",
                readiness.healthy ? "bg-green-50 border-green-100" : "bg-gray-50 border-gray-200"
              )}
            >
              {readiness.healthy ? (
                <HiOutlineCheckCircle className="text-green-600" size={18} />
              ) : (
                <HiOutlineMinusCircle className="text-gray-400" size={18} />
              )}
              <div>
                <div className={clsx("text-xs font-semibold", readiness.healthy ? "text-green-800" : "text-gray-600")}>
                  {readiness.healthy ? "System healthy" : "No data loaded"}
                </div>
                <div className="text-[11px] text-gray-500">
                  {readiness.healthy ? "Pipeline has processed alerts" : "Load a dataset to run the pipeline"}
                </div>
              </div>
            </div>
            <ul className="flex flex-col gap-2">
              {readiness.checks.map((c) => (
                <li key={c.label} className="flex items-center gap-2 text-xs text-gray-600">
                  {c.ok ? (
                    <HiOutlineCheckCircle className="text-green-600 shrink-0" size={15} />
                  ) : (
                    <HiOutlineMinusCircle className="text-gray-300 shrink-0" size={15} />
                  )}
                  <span className={c.ok ? "" : "text-gray-400"}>{c.label}</span>
                </li>
              ))}
            </ul>
          </Panel>
            {/* Top affected services */}
            <Panel title="Top affected services">
              <ul className="flex flex-col gap-2.5">
                {topServices.map((s) => (
                  <li key={s.service} className="text-xs">
                    <div className="flex items-center justify-between gap-2 mb-1">
                      <span className="text-gray-600 truncate" title={s.service}>{s.service}</span>
                      <span className="font-semibold text-gray-800">{s.count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-green-50 overflow-hidden">
                      <div className="h-full rounded-full bg-green-600" style={{ width: `${(s.count / maxService) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
              <Link href="/topology" className="inline-flex items-center gap-1 text-xs font-medium text-green-700 hover:underline mt-3">
                View all services <HiOutlineArrowRight size={12} />
              </Link>
            </Panel>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 items-start">
            {/* Alerts by severity */}
            <Panel title="Alerts by severity" delay={750}>
              <SeverityDonut slices={severityCounts.map((s) => ({ ...s, color: severityColor(s.severity) }))} />
            </Panel>

      </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Panel({
  title,
  right,
  icon,
  className,
  delay = 0,
  children,
}: {
  title: string;
  right?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
  delay?: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx("kpi-card rounded-2xl border border-white/80 p-4 min-w-0", className)}
      style={{ background: "linear-gradient(160deg,#fff 60%,#f0fdf4)", boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)", animationDelay: `${delay}ms` }}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-1.5 font-semibold text-gray-900 text-sm">
          {icon}
          {title}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

function FilterPill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "text-[11px] px-3 py-1 rounded-full font-semibold transition-all",
        active ? "bg-green-700 text-white shadow-sm" : "bg-white border border-gray-200 text-gray-600 hover:border-green-300 hover:text-green-700"
      )}
    >
      {children}
    </button>
  );
}

function FlowArrow() {
  return <HiOutlineArrowRight className="hidden lg:block text-green-500 mx-auto" size={18} />;
}

function FlowCard({
  icon: Icon,
  value,
  label,
  spark,
  sub,
  accent,
}: {
  icon: React.ElementType;
  value: string | number;
  label: string;
  spark?: number[];
  sub?: string;
  accent?: boolean;
}) {
  const max = spark && spark.length ? Math.max(1, ...spark) : 1;
  return (
    <div className={clsx("rounded-xl border bg-white p-4 shadow-sm flex items-center gap-3 min-w-0", accent ? "border-green-200 bg-green-50/40" : "border-gray-200")}>
      <span className="w-11 h-11 rounded-xl bg-green-100 text-green-700 flex items-center justify-center shrink-0">
        <Icon size={22} />
      </span>
      <div className="min-w-0">
        <div className="text-2xl font-bold text-gray-900 tabular-nums leading-none">
          {typeof value === "number" ? value.toLocaleString() : value}
        </div>
        <div className="text-xs text-gray-600 mt-1 truncate">{label}</div>
        {sub && <div className="text-[11px] text-green-700 mt-0.5 truncate">{sub}</div>}
      </div>
      {spark && spark.length > 1 && (
        <div className="ml-auto flex items-end gap-[2px] h-9 w-16 shrink-0">
          {spark.slice(-10).map((v, i) => (
            <div key={i} className="flex-1 rounded-[1px] bg-green-300" style={{ height: `${Math.max(10, (v / max) * 100)}%` }} />
          ))}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-green-50/60 border border-green-100 px-2.5 py-2">
      <div className="text-base font-bold text-green-800 leading-none">{value}</div>
      <div className="text-[10px] text-gray-500 mt-1">{label}</div>
    </div>
  );
}

function NoiseGauge({ value, from, to }: { value: number | null; from: number; to: number }) {
  const pct = value ?? 0;
  const r = 15.9155;
  return (
    <div className="rounded-xl border border-green-200 bg-green-50/40 p-4 shadow-sm flex items-center gap-3 min-w-0">
      <div className="relative w-16 h-16 shrink-0">
        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
          <circle cx="18" cy="18" r={r} fill="none" stroke="#dcfce7" strokeWidth="4" />
          <circle cx="18" cy="18" r={r} fill="none" stroke="#15803d" strokeWidth="4" strokeLinecap="round" strokeDasharray={`${pct} ${100 - pct}`} />
        </svg>
        <HiOutlineShieldCheck className="absolute inset-0 m-auto text-green-700" size={20} />
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold text-green-800 tabular-nums leading-none">{value === null ? "—" : `${value}%`}</div>
        <div className="text-xs text-gray-600 mt-1">Noise reduction</div>
        <div className="text-[11px] text-green-700 mt-0.5 truncate">{from.toLocaleString()} alerts → {to} incidents</div>
      </div>
    </div>
  );
}
