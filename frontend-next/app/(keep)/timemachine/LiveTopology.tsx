"use client";

import { useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Evidence, ServiceGraph } from "@/entities/engine/types";
import { PRIORITY_COLOR } from "@/entities/engine/charts";
import { NODE_H, NODE_W, layout, route } from "../_overview/PropagationMap";
import { propagationPath } from "../_overview/lib";
import type { Step } from "./model";

const JOIN = "#16a34a";
const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * The reference graph, evolving with the replay: a service lights up when its
 * first signal lands and counts the rest; the edge a signal joined through
 * draws itself; once every signal is in, the impact arrows run out from the
 * probable origin. Topology is one of the correlation dimensions, so this is
 * where "why these belong together" is easiest to see.
 */
export function LiveTopology({
  graph, steps, index, done, ev, priority,
}: { graph: ServiceGraph; steps: Step[]; index: number; done: boolean; ev: Evidence; priority: string }) {
  const { pos, width, height } = useMemo(() => layout(graph), [graph]);
  const color = PRIORITY_COLOR[priority] ?? "#dc2626";
  const cur = index >= 0 ? steps[index] : null;

  const counts = new Map<string, number>();
  const links = new Set<string>();
  steps.slice(0, index + 1).forEach((s) => {
    counts.set(s.service, (counts.get(s.service) ?? 0) + 1);
    const to = s.join.linked_to;
    if (s.join.joined && to && to !== s.service) links.add(pairKey(s.service, to));
  });
  const curLink = cur?.join.joined && cur.join.linked_to && cur.join.linked_to !== cur.service
    ? pairKey(cur.service, cur.join.linked_to) : null;

  const path = useMemo(() => propagationPath(ev), [ev]);
  // impact runs from the failing callee back to the caller it broke
  const impact = new Set(done ? path.filter((p) => p.from).map((p) => `${p.from}|${p.service}`) : []);
  const root = done ? ev.root_cause.service : null;
  const offGraph = Array.from(counts.keys()).filter((s) => !pos.has(s));

  return (
    <div className="min-w-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img"
        aria-label="Service dependency graph, lighting up as the incident's signals arrive">
        <defs>
          <marker id="tm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={color} />
          </marker>
        </defs>

        {graph.edges.map((e) => {
          const a = pos.get(e.caller), b = pos.get(e.callee);
          if (!a || !b) return null;
          const k = pairKey(e.caller, e.callee);
          const { d, rev } = route(a, b);
          const isImpact = impact.has(`${e.callee}|${e.caller}`);
          const joined = links.has(k);
          const both = counts.has(e.caller) && counts.has(e.callee);
          return (
            <g key={`${e.caller}-${e.callee}`}>
              <path d={d} fill="none" stroke={both ? `${color}66` : "#e2e8f0"} strokeWidth={both ? 1.5 : 1.1}
                strokeDasharray={both ? "4 3" : undefined} />
              {joined && !isImpact && (
                <motion.path d={d} fill="none" stroke={JOIN} strokeWidth={k === curLink ? 3 : 2} strokeLinecap="round"
                  initial={{ pathLength: 0, opacity: 0 }} animate={{ pathLength: 1, opacity: k === curLink ? 1 : 0.55 }}
                  transition={{ duration: 0.7, ease: "easeInOut" }} />
              )}
              {isImpact && (
                <motion.path d={rev} fill="none" stroke={color} strokeWidth={2.75} strokeLinecap="round" markerEnd="url(#tm-arrow)"
                  initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 0.9, ease: "easeInOut", delay: 0.35 }} />
              )}
            </g>
          );
        })}

        {graph.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const count = counts.get(n.id) ?? 0;
          const active = count > 0;
          const isRoot = n.id === root;
          const isCur = cur?.service === n.id;
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`}>
              <title>{`${n.id} · criticality ${n.criticality}${active ? ` · ${count} signal${count === 1 ? "" : "s"} so far` : ""}`}</title>
              <AnimatePresence>
                {isCur && (
                  <motion.rect key={`pulse-${index}`} x={-2} y={-2} width={NODE_W + 4} height={NODE_H + 4} rx={11}
                    fill="none" stroke={isRoot ? color : JOIN} strokeWidth={2}
                    style={{ transformOrigin: `${NODE_W / 2}px ${NODE_H / 2}px` }}
                    initial={{ scale: 1, opacity: 0.8 }} animate={{ scale: 1.25, opacity: 0 }} exit={{ opacity: 0 }}
                    transition={{ duration: 0.9, ease: "easeOut" }} />
                )}
              </AnimatePresence>
              {isRoot && (
                <motion.rect x={-5} y={-5} width={NODE_W + 10} height={NODE_H + 10} rx={13} fill="none" stroke={color}
                  strokeWidth={1.5} strokeDasharray="3 3" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="origin-ring" />
              )}
              <motion.rect width={NODE_W} height={NODE_H} rx={9} initial={false}
                animate={{
                  fill: isRoot ? color : active ? "#f0fdf4" : "#ffffff",
                  stroke: isRoot ? color : active ? JOIN : "#e2e8f0",
                  strokeWidth: active ? 1.5 : 1,
                }}
                transition={{ duration: 0.4 }} />
              <text x={10} y={NODE_H / 2 + 4} fontSize={11} fontWeight={active ? 700 : 500}
                fill={isRoot ? "#ffffff" : active ? "#14532d" : "#94a3b8"}>
                {n.id.length > 16 ? `${n.id.slice(0, 15)}…` : n.id}
              </text>
              {active && (
                <motion.g key={`c-${count}`} initial={{ scale: 0.4 }} animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 18 }}
                  style={{ transformOrigin: `${NODE_W - 12}px ${NODE_H / 2}px` }}>
                  <circle cx={NODE_W - 12} cy={NODE_H / 2} r={8.5} fill={isRoot ? "#ffffff" : JOIN} />
                  <text x={NODE_W - 12} y={NODE_H / 2 + 3.5} fontSize={9.5} fontWeight={800} textAnchor="middle"
                    fill={isRoot ? color : "#ffffff"}>{count}</text>
                </motion.g>
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-gray-600">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded border-2" style={{ borderColor: JOIN, background: "#f0fdf4" }} />has signals (count)</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-5 h-0.5 rounded" style={{ background: JOIN }} />joined through this dependency</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded" style={{ background: color }} />probable origin</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-5 h-0.5 rounded" style={{ background: color }} />direction of impact</span>
      </div>
      {offGraph.length > 0 && (
        <p className="mt-1 text-[11px] text-gray-600">Not in the reference graph: {offGraph.join(", ")} (criticality defaults to 50).</p>
      )}
    </div>
  );
}
