"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { TbTopologyRing } from "react-icons/tb";
import { KeepLoader, PageHero } from "@/shared/ui";
import { useServiceGraph } from "@/entities/engine/useEngine";

const W = 980;
const NODE_W = 150;
const NODE_H = 46;
const ROW_H = 110;

/** Layered layout: callers above their callees (longest path from a root). */
function layout(nodes: string[], edges: { caller: string; callee: string }[]) {
  const depth: Record<string, number> = {};
  const callers: Record<string, string[]> = {};
  nodes.forEach((n) => (callers[n] = []));
  edges.forEach((e) => callers[e.callee]?.push(e.caller));
  const visit = (n: string, seen: Set<string>): number => {
    if (depth[n] !== undefined) return depth[n];
    if (seen.has(n)) return 0;
    seen.add(n);
    const d = callers[n].length ? Math.max(...callers[n].map((c) => visit(c, seen) + 1)) : 0;
    depth[n] = d;
    return d;
  };
  nodes.forEach((n) => visit(n, new Set()));
  const rows: Record<number, string[]> = {};
  nodes.forEach((n) => (rows[depth[n]] ??= []).push(n));
  const pos: Record<string, { x: number; y: number }> = {};
  Object.entries(rows).forEach(([d, list]) => {
    list.sort();
    const gap = W / (list.length + 1);
    list.forEach((n, i) => (pos[n] = { x: gap * (i + 1), y: 40 + Number(d) * ROW_H }));
  });
  const height = 40 + (Math.max(...Object.keys(rows).map(Number)) + 1) * ROW_H;
  return { pos, height };
}

export function NexusTopologyClient() {
  const { data, error, isLoading } = useServiceGraph();
  const [hover, setHover] = useState<string | null>(null);

  const geo = useMemo(() => (data ? layout(data.nodes.map((n) => n.id), data.edges) : null), [data]);

  if (isLoading) return <KeepLoader loadingText="Loading dependency graph..." />;
  if (error || !data || !geo) {
    return <div className="p-4 text-sm text-red-800">Dependency graph not available from the backend.</div>;
  }

  const byId = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
  const active = hover ? new Set([hover, ...data.edges.filter((e) => e.caller === hover || e.callee === hover).flatMap((e) => [e.caller, e.callee])]) : null;

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={TbTopologyRing}
        title="Service dependency graph"
        subtitle={`${data.nodes.length} services from the reference endpoint (${data.origin}). Arrows point from caller to callee; failures propagate upward. Click a service to highlight its edges. Used for the dependency dimension, the structural gate and root-cause analysis.`}
      />
      <div className="rounded-2xl border border-gray-200 bg-white p-2 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${geo.height}`} className="w-full min-w-[720px]" role="img" aria-label="Service dependency graph">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="#9ca3af" />
            </marker>
          </defs>
          {data.edges.map((e) => {
            const a = geo.pos[e.caller], b = geo.pos[e.callee];
            if (!a || !b) return null;
            const lit = active ? active.has(e.caller) && active.has(e.callee) && (e.caller === hover || e.callee === hover) : false;
            return (
              <line key={e.caller + e.callee} x1={a.x} y1={a.y + NODE_H / 2} x2={b.x} y2={b.y - NODE_H / 2 - 2}
                stroke={lit ? "#15803d" : "#d1d5db"} strokeWidth={lit ? 2.2 : 1.2} markerEnd="url(#arrow)" />
            );
          })}
          {data.nodes.map((n) => {
            const p = geo.pos[n.id];
            const inIncident = n.incidents.length > 0;
            const isRoot = n.root_cause_of.length > 0;
            const dim = active && !active.has(n.id);
            return (
              <g key={n.id} transform={`translate(${p.x - NODE_W / 2},${p.y - NODE_H / 2})`} opacity={dim ? 0.35 : 1}
                onClick={() => setHover(hover === n.id ? null : n.id)} className="cursor-pointer">
                <rect width={NODE_W} height={NODE_H} rx={10}
                  fill={isRoot ? "#fee2e2" : inIncident ? "#ffedd5" : "#ffffff"}
                  stroke={isRoot ? "#dc2626" : inIncident ? "#ea580c" : "#86efac"} strokeWidth={isRoot || inIncident ? 2 : 1.2} />
                <text x={NODE_W / 2} y={19} textAnchor="middle" fontSize="12" fontWeight="700" fill="#111827">{n.id}</text>
                <text x={NODE_W / 2} y={35} textAnchor="middle" fontSize="10.5" fill="#4b5563">
                  criticality {n.criticality}{isRoot ? " · suspected root" : inIncident ? " · in incident" : ""}
                </text>
                <rect x={8} y={NODE_H - 5} width={(NODE_W - 16) * (n.criticality / 100)} height={2.5} rx={1} fill="#16a34a" opacity={0.7} />
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-gray-700">
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border-2 border-red-600 bg-red-100" /> suspected root cause of an open incident</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border-2 border-orange-600 bg-orange-100" /> involved in an open incident</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-1 bg-green-600" /> criticality (0-100, from the brief; feeds impact severity)</span>
      </div>
      {hover && byId[hover]?.incidents.length > 0 && (
        <div className="text-xs text-gray-700">
          {hover} is in: {byId[hover].incidents.map((id) => (
            <Link key={id} href={`/review/${id}`} className={clsx("font-mono text-green-700 hover:underline mr-2")}>{id}</Link>
          ))}
        </div>
      )}
    </div>
  );
}
