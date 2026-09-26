"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Text } from "@tremor/react";
import { LuChevronRight, LuListChecks } from "react-icons/lu";
import { HiOutlineMagnifyingGlass } from "react-icons/hi2";
import { EmptyStateCard, KeepLoader, SeverityLabel } from "@/shared/ui";
import type { UISeverity } from "@/shared/ui";
import { useClusters } from "@/entities/alertlens";
import { riskColor, timeAgo } from "@/entities/alertlens/lib/format";
import { AlertIcon } from "./AlertIcon";

// Tailwind's compiler needs literal class names in source, so a template
// string like `border-t-${color}-400` gets purged at build time — this maps
// each risk level to a class Tailwind can actually see.
const RISK_ACCENT: Record<string, string> = {
  red: "border-t-red-400",
  amber: "border-t-amber-400",
  emerald: "border-t-emerald-400",
  gray: "border-t-gray-300",
};

type SortKey = "risk" | "size" | "recent";
// A 114-incident batch as one wall of cards is unusable; render a page at a time.
const PAGE_SIZE = 24;

const shell = {
  background: "linear-gradient(160deg,#fff 60%,#f0fdf4)",
  boxShadow:
    "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)",
} as const;

/**
 * Shared incident chooser for the analysis pages (/forecast, /timemachine)
 * that operate on one incident at a time.
 *
 * Deliberately does not accept the empty-state icon as a prop: the callers
 * are Server Components, and passing a component reference (as opposed to a
 * rendered element) from a Server Component into this "use client" module
 * crashes with "functions cannot be passed to Client Components". Since the
 * icon is decorative, it's simplest to just own a default here.
 */
export function IncidentPicker({
  basePath,
  emptyTitle,
}: {
  basePath: string;
  emptyTitle: string;
}) {
  const { clusters, isLoading, error } = useClusters();
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("risk");
  const [visible, setVisible] = useState(PAGE_SIZE);

  const levels = useMemo(
    () => ["all", ...Array.from(new Set(clusters.map((c) => c.risk.level)))],
    [clusters]
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = clusters.filter(
      (c) =>
        (level === "all" || c.risk.level === level) &&
        (!q ||
          c.root_cause.alertname.toLowerCase().includes(q) ||
          c.root_cause.service.toLowerCase().includes(q) ||
          String(c.cluster_id) === q.replace(/^#/, ""))
    );
    return [...filtered].sort((a, b) =>
      sort === "risk"
        ? b.risk.score - a.risk.score
        : sort === "size"
          ? b.size - a.size
          : new Date(b.root_cause.timestamp).getTime() -
            new Date(a.root_cause.timestamp).getTime()
    );
  }, [clusters, query, level, sort]);

  if (isLoading) return <KeepLoader loadingText="Loading incidents..." />;

  if (error) {
    return (
      <EmptyStateCard
        icon={LuListChecks}
        title="Could not load incidents"
        description={String(error)}
      />
    );
  }

  if (clusters.length === 0) {
    return (
      <div
        className="kpi-card rounded-2xl border border-white/80 p-4"
        style={shell}
      >
        <EmptyStateCard
          noCard
          icon={LuListChecks}
          title={emptyTitle}
          description="Load an alert batch to get incidents to analyse."
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[220px] max-w-md">
          <HiOutlineMagnifyingGlass
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
          />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setVisible(PAGE_SIZE);
            }}
            placeholder="Search by alert, service or #id…"
            aria-label="Search incidents"
            className="w-full rounded-xl border border-gray-200 bg-white py-2 pl-9 pr-3 text-sm text-gray-800 placeholder:text-gray-400 outline-none focus:border-green-300 focus:ring-4 focus:ring-green-100 transition"
          />
        </div>
        <div className="flex items-center gap-1">
          {levels.map((l) => (
            <button
              key={l}
              onClick={() => {
                setLevel(l);
                setVisible(PAGE_SIZE);
              }}
              className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                level === l
                  ? "bg-green-700 text-white"
                  : "bg-white text-gray-600 border border-gray-200 hover:bg-green-50 hover:text-green-700"
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-1.5 text-xs text-gray-600">
          Sort
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="rounded-lg border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-700"
          >
            <option value="risk">Highest risk</option>
            <option value="size">Most alerts</option>
            <option value="recent">Most recent</option>
          </select>
        </label>
      </div>
      <Text className="text-xs text-gray-600">
        Showing {Math.min(visible, shown.length)} of {shown.length}
        {shown.length !== clusters.length &&
          ` (filtered from ${clusters.length})`}{" "}
        incidents
      </Text>

      {shown.length === 0 && (
        <div
          className="kpi-card rounded-2xl border border-white/80 p-4"
          style={shell}
        >
          <EmptyStateCard
            noCard
            icon={LuListChecks}
            title="No incidents match"
            description="Try a different search or clear the risk filter."
          />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3">
        {shown.slice(0, visible).map((c, i) => (
          <Link
            key={c.cluster_id}
            href={`${basePath}/${c.cluster_id}`}
            className="group"
          >
            <div
              className={`kpi-card rounded-2xl border border-white/80 border-t-2 p-4 h-full transition-shadow hover:shadow-md ${RISK_ACCENT[riskColor(c.risk.level)] ?? RISK_ACCENT.gray}`}
              style={{ ...shell, animationDelay: `${Math.min(i, 12) * 60}ms` }}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-start gap-2.5 min-w-0">
                  <AlertIcon
                    alertname={c.root_cause.alertname}
                    severity={c.root_cause.severity}
                    service={c.root_cause.service}
                    className="mt-0.5"
                  />
                  <div className="min-w-0">
                    <div
                      className="font-semibold text-gray-900 truncate"
                      title={c.root_cause.alertname}
                    >
                      {c.root_cause.alertname}
                    </div>
                    <Text className="text-xs text-gray-600 truncate">
                      #{c.cluster_id} · {c.root_cause.service} ·{" "}
                      {timeAgo(c.root_cause.timestamp)}
                    </Text>
                  </div>
                </div>
                <SeverityLabel severity={c.root_cause.severity as UISeverity} />
              </div>
              <div className="flex items-center justify-between gap-2 mt-2">
                <div className="flex items-center gap-2">
                  <Badge size="xs" color={riskColor(c.risk.level)}>
                    {c.risk.level} risk
                  </Badge>
                  <Text className="text-xs text-gray-600">
                    {c.size} alerts · {c.risk.services_affected} services
                  </Text>
                </div>
                <LuChevronRight className="w-4 h-4 text-gray-300 shrink-0 transition-transform group-hover:translate-x-0.5 group-hover:text-green-500" />
              </div>
            </div>
          </Link>
        ))}
      </div>

      {visible < shown.length && (
        <button
          onClick={() => setVisible((v) => v + PAGE_SIZE)}
          className="self-center rounded-full border border-green-200 bg-white px-4 py-1.5 text-sm font-semibold text-green-700 hover:bg-green-50 transition-colors"
        >
          Show {Math.min(PAGE_SIZE, shown.length - visible)} more
        </button>
      )}
    </div>
  );
}
