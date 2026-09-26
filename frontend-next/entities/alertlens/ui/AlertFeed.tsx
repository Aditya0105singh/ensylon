"use client";

import { useCallback, useMemo, useState } from "react";
import clsx from "clsx";
import { LuCheck, LuColumns3, LuMinus } from "react-icons/lu";
import { Badge, Card, Text, TextInput } from "@tremor/react";
import { DisplayColumnDef } from "@tanstack/react-table";
import { GenericTable } from "@/components/table/GenericTable";
import {
  DropdownMenu,
  EmptyStateCard,
  KeepLoader,
  PageHero,
  SeverityLabel,
} from "@/shared/ui";
import type { UISeverity } from "@/shared/ui";
import { AiOutlineAlert } from "react-icons/ai";
import { useFilteredAlerts } from "@/entities/alertlens";
import type { Alert } from "@/entities/alertlens";
import { timeAgo } from "@/entities/alertlens/lib/format";
import { AlertDetailDrawer } from "./AlertDetailDrawer";
import { AlertIcon, ServiceChip, SourceTag } from "./AlertIcon";
import {
  AlertFacets,
  applyFacets,
  emptySelections,
  type FacetKey,
} from "./AlertFacets";

const PAGE_SIZE = 20;

/** Columns that can be toggled off, and those that always show. */
const ALWAYS_ON = ["severity", "alertname"];
const OPTIONAL_COLUMNS: { id: string; label: string }[] = [
  { id: "service", label: "Service" },
  { id: "status", label: "Status" },
  { id: "source", label: "Source" },
  { id: "flags", label: "Flags" },
  { id: "received", label: "Received" },
];

/** Orders severity meaningfully rather than alphabetically. */
const SEVERITY_RANK: Record<string, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

type SortState = { key: string; dir: "asc" | "desc" };

function SortHeader({
  label,
  col,
  sort,
  onSort,
}: {
  label: string;
  col: string;
  sort: SortState;
  onSort: (col: string) => void;
}) {
  const active = sort.key === col;
  return (
    <button
      type="button"
      onClick={() => onSort(col)}
      className={clsx(
        "flex items-center gap-1 hover:text-green-500",
        active && "text-green-500"
      )}
    >
      {label}
      <span className="text-[10px]">
        {active ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}
      </span>
    </button>
  );
}

const statusColor = (status: string) => {
  switch (status) {
    case "firing":
      return "red";
    case "resolved":
      return "emerald";
    case "suppressed":
      return "gray";
    default:
      return "gray";
  }
};

export function AlertFeed({
  title,
  subtitle,
  firingOnly = false,
  criticalOnly = false,
}: {
  title: string;
  subtitle: string;
  firingOnly?: boolean;
  criticalOnly?: boolean;
}) {
  const { alerts, isLoading, error } = useFilteredAlerts({
    firingOnly,
    criticalOnly,
  });

  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Alert | null>(null);
  const [facets, setFacets] = useState(emptySelections);
  const [sort, setSort] = useState<SortState>({
    key: "received",
    dir: "desc",
  });
  const [visibleCols, setVisibleCols] = useState<Set<string>>(
    () => new Set(OPTIONAL_COLUMNS.map((c) => c.id))
  );

  const toggleSort = useCallback((key: string) => {
    setSort((prev) =>
      prev.key === key
        ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
        : { key, dir: "desc" }
    );
  }, []);

  const toggleColumn = (id: string) =>
    setVisibleCols((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const toggleFacet = (key: FacetKey, value: string) => {
    setFacets((prev) => {
      const next = { ...prev, [key]: new Set(prev[key]) };
      if (next[key].has(value)) next[key].delete(value);
      else next[key].add(value);
      return next;
    });
    setOffset(0);
  };

  const filtered = useMemo(() => {
    const faceted = applyFacets(alerts, facets);
    const q = query.trim().toLowerCase();
    if (!q) return faceted;
    return faceted.filter((a) =>
      [a.alertname, a.service, a.message, a.source].some((f) =>
        f?.toLowerCase().includes(q)
      )
    );
  }, [alerts, facets, query]);

  const sorted = useMemo(() => {
    const dir = sort.dir === "asc" ? 1 : -1;
    const value = (a: Alert) => {
      switch (sort.key) {
        case "severity":
          return SEVERITY_RANK[a.severity] ?? 0;
        case "received":
          return a.timestamp;
        default:
          return String(a[sort.key as keyof Alert] ?? "");
      }
    };
    return [...filtered].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === vb) return 0;
      return va > vb ? dir : -dir;
    });
  }, [filtered, sort]);

  const allColumns = useMemo<DisplayColumnDef<Alert>[]>(
    () => [
      {
        id: "severity",
        header: () => <SortHeader label="Severity" col="severity" sort={sort} onSort={toggleSort} />,
        cell: ({ row }) => (
          <SeverityLabel severity={row.original.severity as UISeverity} />
        ),
      },
      {
        id: "alertname",
        header: () => <SortHeader label="Alert" col="alertname" sort={sort} onSort={toggleSort} />,
        cell: ({ row }) => (
          <div className="flex items-center gap-2.5 min-w-0">
            <AlertIcon
              alertname={row.original.alertname}
              severity={row.original.severity}
              service={row.original.service}
            />
            <div className="min-w-0">
              <div className="font-medium truncate">
                {row.original.alertname}
              </div>
              <div className="text-xs text-gray-500 truncate">
                {row.original.message}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: "service",
        header: () => <SortHeader label="Service" col="service" sort={sort} onSort={toggleSort} />,
        cell: ({ row }) => (
          <Text className="truncate">
            <ServiceChip service={row.original.service} />
          </Text>
        ),
      },
      {
        id: "status",
        header: () => <SortHeader label="Status" col="status" sort={sort} onSort={toggleSort} />,
        cell: ({ row }) => (
          <Badge size="xs" color={statusColor(row.original.status)}>
            {row.original.status}
          </Badge>
        ),
      },
      {
        id: "source",
        header: () => <SortHeader label="Source" col="source" sort={sort} onSort={toggleSort} />,
        cell: ({ row }) => <SourceTag source={row.original.source} />,
      },
      {
        id: "flags",
        header: "",
        cell: ({ row }) => (
          <div className="flex gap-1">
            {row.original.acked && (
              <Badge size="xs" color="emerald">
                ack
              </Badge>
            )}
            {row.original.escalated && (
              <Badge size="xs" color="red">
                esc
              </Badge>
            )}
            {(row.original.duplicate_count ?? 1) > 1 && (
              <Badge size="xs" color="emerald">
                ×{row.original.duplicate_count}
              </Badge>
            )}
          </div>
        ),
      },
      {
        id: "received",
        header: () => <SortHeader label="Received" col="received" sort={sort} onSort={toggleSort} />,
        cell: ({ row }) => (
          <Text className="text-xs text-gray-500 whitespace-nowrap">
            {timeAgo(row.original.timestamp)}
          </Text>
        ),
      },
    ],
    [sort, toggleSort]
  );

  // Severity and Alert always show; the rest are user-selectable.
  const columns = useMemo(
    () =>
      allColumns.filter(
        (c) => ALWAYS_ON.includes(c.id as string) || visibleCols.has(c.id as string)
      ),
    [allColumns, visibleCols]
  );

  const pageRows = useMemo(
    () => sorted.slice(offset, offset + limit),
    [sorted, offset, limit]
  );

  if (isLoading) {
    return <KeepLoader loadingText="Loading alerts..." />;
  }

  if (error) {
    return (
      <div className="p-4">
        <EmptyStateCard
          icon={AiOutlineAlert}
          title="Could not load alerts"
          description={String(error)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <PageHero icon={AiOutlineAlert} title={title} subtitle={subtitle}>
        <div className="flex items-center gap-2">
          <TextInput
            className="max-w-xs"
            placeholder="Filter alerts..."
            value={query}
            onValueChange={(v) => {
              setQuery(v);
              setOffset(0);
            }}
          />
          <DropdownMenu.Menu icon={LuColumns3} label="Columns">
            {OPTIONAL_COLUMNS.map((c) => (
              <DropdownMenu.Item
                key={c.id}
                icon={visibleCols.has(c.id) ? LuCheck : LuMinus}
                label={c.label}
                onClick={() => toggleColumn(c.id)}
              />
            ))}
          </DropdownMenu.Menu>
        </div>
      </PageHero>

      <div className="flex flex-col lg:flex-row gap-4 items-start">
        <AlertFacets
          alerts={alerts}
          selections={facets}
          onToggle={toggleFacet}
          onReset={() => {
            setFacets(emptySelections());
            setOffset(0);
          }}
        />

        <div className="flex-1 min-w-0 w-full">
          {filtered.length === 0 ? (
            <Card>
              <EmptyStateCard
                noCard
                icon={AiOutlineAlert}
                title="No alerts match"
                description={
                  alerts.length === 0
                    ? "No alert batch is loaded, or none match this view."
                    : "Try clearing the filters."
                }
              />
            </Card>
          ) : (
            <GenericTable<Alert>
              data={pageRows}
              columns={columns}
              rowCount={filtered.length}
              offset={offset}
              limit={limit}
              dataFetchedAtOneGO
              onRowClick={(row) => setSelected(row)}
              onPaginationChange={(newLimit, newOffset) => {
                setLimit(newLimit);
                setOffset(newOffset);
              }}
            />
          )}
        </div>
      </div>

      <AlertDetailDrawer alert={selected} onClose={() => setSelected(null)} />
    </div>
  );
}
