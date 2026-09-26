"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { MdOutlineNotificationsActive } from "react-icons/md";
import {
  HiOutlineBell,
  HiOutlineChevronRight,
  HiOutlineDocumentText,
  HiOutlineExclamationTriangle,
  HiOutlineShare,
  HiOutlineShieldCheck,
} from "react-icons/hi2";
import { EmptyStateCard, KeepLoader, PageHero } from "@/shared/ui";
import { useIncidentPanel, usePipelineState } from "@/entities/alertlens";
import type { Cluster } from "@/entities/alertlens";
import { EngineIncidentsCard } from "@/entities/engine/EngineCards";
import { StatCard } from "@/entities/alertlens/ui/StatCard";
import { timeAgo } from "@/entities/alertlens/lib/format";

type SortKey = "risk" | "size" | "recent";

const SORTS: [SortKey, string][] = [
  ["risk", "Risk"],
  ["size", "Alerts"],
  ["recent", "Most recent"],
];

const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
const RISK_COLOR: Record<string, string> = { high: "#ef4444", medium: "#f97316", low: "#3b82f6" };
const STATUS_STYLE: Record<string, { pill: string; dot: string }> = {
  Open: { pill: "text-red-600 bg-red-50", dot: "bg-red-500" },
  Investigating: { pill: "text-orange-600 bg-orange-50", dot: "bg-orange-500" },
  Resolved: { pill: "text-blue-600 bg-blue-50", dot: "bg-blue-500" },
};

function deriveStatus(c: Cluster): string {
  const root = c.root_cause;
  if (root.dismissed) return "Resolved";
  if (root.escalated || (root.assignee && root.assignee !== "n/a")) return "Investigating";
  return "Open";
}

const SEV_COLOR: Record<string, string> = { critical: "#ef4444", high: "#f97316", medium: "#eab308", low: "#22c55e", info: "#3b82f6" };
// Banded from the measured risk score; the pipeline has no priority field.
const priorityOf = (c: Cluster) => (c.risk.score >= 0.75 ? "P1" : c.risk.score >= 0.5 ? "P2" : c.risk.score >= 0.25 ? "P3" : "P4");
const PRIORITY_STYLE: Record<string, string> = {
  P1: "bg-red-50 text-red-700",
  P2: "bg-orange-50 text-orange-700",
  P3: "bg-blue-50 text-blue-700",
  P4: "bg-gray-100 text-gray-600",
};

const lastSeen = (c: Cluster) => {
  const stamps = c.alerts.map((a) => a.timestamp).sort();
  return stamps[stamps.length - 1] ?? c.root_cause.timestamp;
};

export function IncidentsClient() {
  const { state, isLoading, error } = usePipelineState();
  const [severity, setSeverity] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("risk");
  const { openIncident, openIncidentId } = useIncidentPanel();

  const clusters = state.clusters;

  const stats = useMemo(() => {
    const raw = state.dedup_stats?.raw_count ?? state.raw_alerts.length;
    const unique = state.dedup_stats?.unique_count ?? state.raw_alerts.length;
    const noise = raw && clusters.length ? Math.round(1000 * (1 - clusters.length / raw)) / 10 : 0;
    return { raw, unique, noise };
  }, [state.dedup_stats, state.raw_alerts.length, clusters.length]);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of clusters) {
      const s = c.root_cause.severity;
      m.set(s, (m.get(s) ?? 0) + 1);
    }
    return m;
  }, [clusters]);

  const visible = useMemo(() => {
    const filtered = clusters.filter((c) => !severity || c.root_cause.severity === severity);
    const by: Record<SortKey, (a: Cluster, b: Cluster) => number> = {
      risk: (a, b) => b.risk.score - a.risk.score,
      size: (a, b) => b.size - a.size,
      recent: (a, b) => lastSeen(b).localeCompare(lastSeen(a)),
    };
    return [...filtered].sort(by[sort]);
  }, [clusters, severity, sort]);

  if (isLoading) return <KeepLoader loadingText="Loading incidents..." />;

  if (error) {
    return (
      <div className="p-4">
        <EmptyStateCard
          icon={MdOutlineNotificationsActive}
          title="Could not load incidents"
          description={String(error)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={MdOutlineNotificationsActive}
        title="Incidents"
        subtitle="The loaded dataset, grouped by the baseline scale pipeline. Live engine incidents (full causal analysis and review gate) are listed first."
      />

      <EngineIncidentsCard />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Raw alerts" value={stats.raw} icon={HiOutlineBell} color="green" />
        <StatCard label="Unique after dedup" value={stats.unique} icon={HiOutlineShare} color="green" />
        <StatCard label="Actionable incidents" value={clusters.length} icon={HiOutlineDocumentText} color="green" />
        <StatCard
          label="Noise reduction"
          value={clusters.length ? `${stats.noise}%` : "—"}
          icon={HiOutlineShieldCheck}
          color="green"
        />
      </div>

      {clusters.length === 0 ? (
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <EmptyStateCard
            noCard
            icon={MdOutlineNotificationsActive}
            title="No incidents"
            description="No alert batch is loaded, or nothing correlated into an incident."
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3 items-start">
          {/* Incident list */}
          <div className="rounded-xl border border-gray-200 bg-white overflow-hidden min-w-0 lg:col-span-2 xl:col-span-3">
            <div className="p-3 border-b border-gray-100 flex flex-col gap-2">
              <div className="flex items-center gap-1.5 flex-wrap">
                <Pill active={severity === null} onClick={() => setSeverity(null)}>
                  All {clusters.length}
                </Pill>
                {SEVERITY_ORDER.filter((s) => counts.get(s)).map((s) => (
                  <Pill key={s} active={severity === s} onClick={() => setSeverity(severity === s ? null : s)}>
                    <span className="capitalize">{s}</span> {counts.get(s)}
                  </Pill>
                ))}
              </div>
              <div className="flex items-center gap-1.5 text-[11px] text-gray-400">
                <span>Sort by:</span>
                {SORTS.map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setSort(key)}
                    className={clsx(
                      "px-1.5 py-0.5 rounded font-medium",
                      sort === key ? "text-green-700 bg-green-50" : "hover:text-gray-600"
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <ul className="divide-y divide-gray-50">
              {visible.map((c, idx) => {
                const st = deriveStatus(c);
                const isSel = openIncidentId === c.cluster_id;
                const risk = Math.round(c.risk.score * 100);
                return (
                  <li key={c.cluster_id}>
                    <button
                      onClick={() => openIncident(c.cluster_id)}
                      aria-current={isSel}
                      style={{ animationDelay: `${Math.min(idx, 12) * 45}ms` }}
                      className={clsx(
                        "kpi-row w-full text-left px-4 py-3 flex flex-col gap-2 transition-all",
                        isSel ? "bg-green-50/80 shadow-[inset_3px_0_0_#16a34a]" : "hover:bg-green-50/50 hover:shadow-[inset_3px_0_0_#16a34a]"
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <span
                          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
                          style={{ background: `${SEV_COLOR[c.root_cause.severity] ?? "#9ca3af"}1f`, color: SEV_COLOR[c.root_cause.severity] ?? "#9ca3af" }}
                        >
                          <HiOutlineExclamationTriangle size={18} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-sm font-semibold text-gray-900 line-clamp-2 break-words">
                            {c.root_cause.alertname}
                          </div>
                          <div className="text-[11px] text-gray-500 mt-0.5">
                            #{c.cluster_id} · {c.root_cause.service} · {timeAgo(lastSeen(c))}
                          </div>
                        </div>
                        <span className={clsx("text-[11px] font-bold px-2.5 py-1 rounded-lg shrink-0", PRIORITY_STYLE[priorityOf(c)])}>
                          {priorityOf(c)}
                        </span>
                        <HiOutlineChevronRight className="text-gray-300 shrink-0 mt-2" size={14} />
                      </div>
                      <div className="flex items-center gap-2">
                        <span
                          className={clsx(
                            "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full whitespace-nowrap",
                            STATUS_STYLE[st]?.pill
                          )}
                        >
                          <span className={clsx("w-1.5 h-1.5 rounded-full", STATUS_STYLE[st]?.dot)} />
                          {st}
                        </span>
                        <span className="text-[11px] text-gray-500 whitespace-nowrap">{c.size} alerts</span>
                        <div className="flex-1 flex items-center gap-1.5 min-w-0">
                          <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                            <div
                              className="kpi-hbar h-full rounded-full"
                              style={{ width: `${risk}%`, background: RISK_COLOR[c.risk.level] ?? "#9ca3af", animationDelay: `${300 + Math.min(idx, 12) * 45}ms` }}
                            />
                          </div>
                          <span className="text-[11px] text-gray-500 w-8 text-right">{risk}%</span>
                        </div>
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

        </div>
      )}
    </div>
  );
}

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
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
