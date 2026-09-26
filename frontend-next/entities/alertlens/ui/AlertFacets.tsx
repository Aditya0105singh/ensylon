"use client";

import { useMemo, useState } from "react";
import { Card, Text } from "@tremor/react";
import { LuChevronRight, LuRotateCcw } from "react-icons/lu";
import clsx from "clsx";
import type { Alert } from "@/entities/alertlens";

export type FacetKey = "severity" | "status" | "source" | "service" | "alertname";

export type FacetSelections = Record<FacetKey, Set<string>>;

export const FACET_FIELDS: { key: FacetKey; label: string }[] = [
  { key: "severity", label: "Severity" },
  { key: "status", label: "Status" },
  { key: "source", label: "Source" },
  { key: "service", label: "Service" },
  { key: "alertname", label: "Alert Name" },
];

export const emptySelections = (): FacetSelections => ({
  severity: new Set(),
  status: new Set(),
  source: new Set(),
  service: new Set(),
  alertname: new Set(),
});

const DOT_COLOR: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-green-500",
  info: "bg-blue-500",
  firing: "bg-red-500",
  suppressed: "bg-gray-400",
  resolved: "bg-emerald-500",
};

/**
 * Applies facet selections. Within a facet the options are OR-ed; across
 * facets they are AND-ed — the behaviour the original FacetSidebar had.
 */
export function applyFacets(
  alerts: Alert[],
  selections: FacetSelections
): Alert[] {
  return alerts.filter((a) =>
    FACET_FIELDS.every(({ key }) => {
      const selected = selections[key];
      if (!selected || selected.size === 0) return true;
      return selected.has(String(a[key] ?? ""));
    })
  );
}

/**
 * Counts are computed against the alerts filtered by every *other* facet, so
 * a count shows what you'd get by adding that option — not a stale total.
 */
function countsFor(
  key: FacetKey,
  alerts: Alert[],
  selections: FacetSelections
): Map<string, number> {
  const others: FacetSelections = { ...selections, [key]: new Set<string>() };
  const scoped = applyFacets(alerts, others);
  const counts = new Map<string, number>();
  for (const a of scoped) {
    const v = String(a[key] ?? "");
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return counts;
}

function FacetGroup({
  label,
  facetKey,
  alerts,
  selections,
  onToggle,
}: {
  label: string;
  facetKey: FacetKey;
  alerts: Alert[];
  selections: FacetSelections;
  onToggle: (key: FacetKey, value: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);

  const options = useMemo(() => {
    const counts = countsFor(facetKey, alerts, selections);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [facetKey, alerts, selections]);

  const visible = showAll ? options : options.slice(0, 6);
  const selected = selections[facetKey];

  if (options.length === 0) return null;

  return (
    <div className="border-b border-gray-200 last:border-0 py-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 w-full text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-gray-700"
      >
        <LuChevronRight
          className={clsx("w-3 h-3 transition-transform", open && "rotate-90")}
        />
        {label}
        {selected.size > 0 && (
          <span className="ml-auto text-green-500 normal-case">
            {selected.size}
          </span>
        )}
      </button>

      {open && (
        <div className="mt-1.5 flex flex-col gap-0.5">
          {visible.map(([value, count]) => {
            const isOn = selected.has(value);
            return (
              <label
                key={value}
                className="flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-0.5 hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={isOn}
                  onChange={() => onToggle(facetKey, value)}
                  className="accent-green-500"
                />
                {DOT_COLOR[value] && (
                  <span
                    className={clsx(
                      "w-1.5 h-1.5 rounded-full shrink-0",
                      DOT_COLOR[value]
                    )}
                  />
                )}
                <span className="truncate flex-1" title={value}>
                  {value}
                </span>
                <span className="text-xs text-gray-400 shrink-0">{count}</span>
              </label>
            );
          })}

          {options.length > 6 && (
            <button
              type="button"
              onClick={() => setShowAll(!showAll)}
              className="text-xs text-green-500 text-left px-1 mt-0.5"
            >
              {showAll ? "Show less" : `Show ${options.length - 6} more`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function AlertFacets({
  alerts,
  selections,
  onToggle,
  onReset,
}: {
  alerts: Alert[];
  selections: FacetSelections;
  onToggle: (key: FacetKey, value: string) => void;
  onReset: () => void;
}) {
  const activeCount = FACET_FIELDS.reduce(
    (n, f) => n + selections[f.key].size,
    0
  );

  // Collapsed by default below lg: on a phone this panel used to render its
  // full filter list above the actual alert table, so the table was the
  // second screenful instead of the first thing visible. `lg:block` forces
  // it open unconditionally at desktop widths regardless of this state.
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <Card className="p-3 w-full lg:w-64 shrink-0 self-start">
      <button
        type="button"
        onClick={() => setMobileOpen((v) => !v)}
        className="flex items-center justify-between gap-2 w-full pb-1 lg:pointer-events-none"
      >
        <Text className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          Filters{activeCount > 0 && ` (${activeCount})`}
        </Text>
        <div className="flex items-center gap-2">
          {activeCount > 0 && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                onReset();
              }}
              onKeyDown={(e) => e.key === "Enter" && onReset()}
              className="flex items-center gap-1 text-xs text-green-500 lg:pointer-events-auto"
            >
              <LuRotateCcw className="w-3 h-3" />
              Reset
            </span>
          )}
          <LuChevronRight
            className={clsx(
              "w-3.5 h-3.5 shrink-0 transition-transform lg:hidden",
              mobileOpen && "rotate-90"
            )}
          />
        </div>
      </button>
      <div className={clsx(mobileOpen ? "block" : "hidden", "lg:block")}>
        {FACET_FIELDS.map(({ key, label }) => (
          <FacetGroup
            key={key}
            label={label}
            facetKey={key}
            alerts={alerts}
            selections={selections}
            onToggle={onToggle}
          />
        ))}
      </div>
    </Card>
  );
}
