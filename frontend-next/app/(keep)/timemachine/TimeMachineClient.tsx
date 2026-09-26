"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { MotionConfig, motion } from "motion/react";
import { TbTimeline } from "react-icons/tb";
import { EmptyStateCard, KeepLoader, PageHero } from "@/shared/ui";
import { useEngineEvidence, useEngineQueue, useServiceGraph } from "@/entities/engine/useEngine";
import { PRIORITY_COLOR } from "@/entities/engine/charts";
import type { Evidence, QueueSummary } from "@/entities/engine/types";
import { cleanTitle, clockUTC } from "../_overview/lib";
import { buildSteps, usePlayback } from "./model";
import { Swimlanes } from "./Swimlanes";
import { LiveTopology } from "./LiveTopology";
import { JoinExplainer } from "./JoinExplainer";
import { EvidenceTape, Vitals } from "./Vitals";
import { Verdict } from "./Verdict";

function Panel({ title, sub, children, className }: { title: string; sub?: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={clsx("rounded-2xl border border-gray-100 bg-white p-4 min-w-0", className)} aria-label={title}
      style={{ boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -16px rgba(16,24,40,.14)" }}>
      <h2 className="text-sm font-bold text-gray-900">{title}</h2>
      {sub && <p className="text-[11px] text-gray-500 mt-0.5 mb-3">{sub}</p>}
      {children}
    </section>
  );
}

/** Every incident, newest first, as a strip to pick the one to replay. */
function IncidentReel({ items, active, onPick }: { items: QueueSummary[]; active: string | null; onPick: (id: string) => void }) {
  return (
    <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1" role="listbox" aria-label="Incident to replay">
      {items.map((q) => {
        const on = q.draft_id === active;
        const color = PRIORITY_COLOR[q.priority] ?? "#9ca3af";
        return (
          <button key={q.draft_id} role="option" aria-selected={on} onClick={() => onPick(q.draft_id)}
            className={clsx("relative shrink-0 w-56 text-left rounded-xl border bg-white px-3 py-2 transition-colors",
              on ? "border-transparent" : "border-gray-100 hover:border-gray-300")}>
            {on && (
              <motion.span layoutId="reel-active" className="absolute inset-0 rounded-xl ring-2 ring-green-600"
                transition={{ type: "spring", stiffness: 500, damping: 36 }} />
            )}
            <span className="flex items-center gap-1.5 text-[10.5px]">
              <span className="rounded px-1.5 font-extrabold text-white" style={{ background: color }}>{q.priority}</span>
              <span className="font-mono text-gray-500">{clockUTC(q.started_at)}</span>
              <span className="ml-auto text-gray-500">{q.signal_count} signals</span>
            </span>
            <span className="mt-1 block text-xs font-bold text-gray-900 truncate">{cleanTitle(q.title)}</span>
            <span className="block text-[10.5px] text-gray-500 truncate">{q.affected_services.join(" · ")}</span>
          </button>
        );
      })}
    </div>
  );
}

function Replay({ ev, priority }: { ev: Evidence; priority: string }) {
  const { steps, span, t0 } = useMemo(() => buildSteps(ev), [ev]);
  const pb = usePlayback(steps, span, ev.draft_id);
  const { data: graph } = useServiceGraph();
  const cur = pb.index >= 0 ? steps[pb.index] : null;

  if (steps.length === 0) return null;
  return (
    <div className="flex flex-col gap-4">
      <Swimlanes steps={steps} span={span} t0={t0} pb={pb} />

      <div className="grid grid-cols-1 xl:grid-cols-[1.55fr_1fr] gap-4 items-start">
        <div className="flex flex-col gap-4 min-w-0">
          <Panel title="Where it spread" sub="The reference dependency graph, lighting up as each service's signals arrive">
            {graph && graph.nodes.length > 0
              ? <LiveTopology graph={graph} steps={steps} index={pb.index} done={pb.done} ev={ev} priority={priority} />
              : <p className="text-xs text-gray-500">Loading the dependency graph…</p>}
          </Panel>
          <Vitals steps={steps} index={pb.index} />
        </div>
        <Panel title="Why this signal joined" sub="The structural gate it passed, and the weighted similarity against the merge threshold">
          <JoinExplainer step={cur} first={pb.index === 0} ev={ev} />
        </Panel>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_1fr] gap-4 items-start">
        <Panel title="Evidence so far" sub="Newest first. Click a signal to jump to it.">
          <EvidenceTape steps={steps} index={pb.index} onSeek={pb.seek} />
        </Panel>
        <Panel title="Verdict" sub="Root cause, ranked on the complete incident">
          <Verdict ev={ev} steps={steps} index={pb.index} done={pb.done} onSkip={() => pb.seek(span)} priority={priority} />
        </Panel>
      </div>
    </div>
  );
}

export function TimeMachineClient() {
  const { data: queue, isLoading } = useEngineQueue();
  const [id, setId] = useState<string | null>(null);
  const items = useMemo(
    () => [...(queue ?? [])].filter((q) => q.status !== "merged").sort((a, b) => (a.started_at < b.started_at ? 1 : -1)),
    [queue]
  );
  const active = id ?? items[0]?.draft_id ?? null;
  const summary = items.find((q) => q.draft_id === active);
  // Evidence of a replayed incident must not change under the playhead.
  const { data: ev } = useEngineEvidence(active, { refreshInterval: 0, revalidateOnFocus: false });

  return (
    <MotionConfig reducedMotion="user">
      <div className="flex flex-col gap-4 p-4">
        <PageHero
          icon={TbTimeline}
          title="Time machine"
          subtitle="Watch an incident form, signal by signal, across the three streams: which structural gate let each signal in, how the services light up on the dependency graph, and why the first service to complain was not necessarily the cause."
        />

        {isLoading ? (
          <KeepLoader includeMinHeight={false} loadingText="Loading incidents..." />
        ) : items.length === 0 ? (
          <EmptyStateCard icon={TbTimeline} title="Nothing to replay yet"
            description="An incident appears here as soon as the streams produce a validated correlation.">
            <Link href="/" className="text-sm font-semibold text-green-700 hover:underline">Back to Overview →</Link>
          </EmptyStateCard>
        ) : (
          <>
            <IncidentReel items={items} active={active} onPick={setId} />
            {ev && ev.draft_id === active ? (
              <Replay key={ev.draft_id} ev={ev} priority={summary?.priority ?? "P3"} />
            ) : (
              <KeepLoader includeMinHeight={false} loadingText="Loading evidence..." />
            )}
          </>
        )}
      </div>
    </MotionConfig>
  );
}
