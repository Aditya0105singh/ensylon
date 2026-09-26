"use client";

import { useMemo } from "react";
import type { ServiceGraph } from "@/entities/engine/types";
import { PRIORITY_COLOR } from "@/entities/engine/charts";
import type { PropagationStep } from "./lib";

const COL_W = 168;
const ROW_H = 46;
const NODE_W = 138;
const NODE_H = 28;
const PAD = 16;

/** Callers on the left, the shared database on the right: each service sits
 * one column right of its deepest caller. */
function layout(graph: ServiceGraph) {
  const ids = graph.nodes.map((n) => n.id);
  const callers = new Map<string, string[]>(ids.map((id) => [id, []]));
  graph.edges.forEach((e) => callers.get(e.callee)?.push(e.caller));
  const depth = new Map<string, number>();
  const visit = (id: string, stack: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!;
    if (stack.has(id)) return 0;
    stack.add(id);
    const d = Math.max(-1, ...(callers.get(id) ?? []).map((c) => visit(c, stack))) + 1;
    stack.delete(id);
    depth.set(id, d);
    return d;
  };
  ids.forEach((id) => visit(id, new Set()));
  const cols: string[][] = [];
  ids.forEach((id) => {
    const d = depth.get(id) ?? 0;
    (cols[d] ??= []).push(id);
  });
  cols.forEach((c) => c.sort());
  const rows = Math.max(1, ...cols.map((c) => c.length));
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => {
    const offsetY = ((rows - col.length) * ROW_H) / 2;
    col.forEach((id, ri) => pos.set(id, { x: PAD + ci * COL_W, y: PAD + offsetY + ri * ROW_H }));
  });
  return { pos, width: PAD * 2 + (cols.length - 1) * COL_W + NODE_W, height: PAD * 2 + (rows - 1) * ROW_H + NODE_H };
}

/** Orthogonal routing through the gaps between columns and rows, so an edge
 * that skips a column never runs underneath another service's box. */
function route(a: { x: number; y: number }, b: { x: number; y: number }) {
  const gap = (COL_W - NODE_W) / 2;
  const rowGap = (ROW_H - NODE_H) / 2;
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
  const pts: [number, number][] = [[x1, y1]];
  if (x2 - x1 <= COL_W - NODE_W + 1) {
    const mx = x1 + gap;
    pts.push([mx, y1], [mx, y2]);
  } else {
    const lane = b.y >= a.y ? b.y - rowGap : b.y + NODE_H + rowGap;
    pts.push([x1 + gap, y1], [x1 + gap, lane], [x2 - gap, lane], [x2 - gap, y2]);
  }
  pts.push([x2, y2]);
  const toPath = (p: [number, number][]) => rounded(p);
  return { d: toPath(pts), rev: toPath([...pts].reverse()) };
}

function rounded(p: [number, number][], r = 6) {
  let d = `M${p[0][0]},${p[0][1]}`;
  for (let i = 1; i < p.length - 1; i++) {
    const [px, py] = p[i - 1], [cx, cy] = p[i], [nx, ny] = p[i + 1];
    const l1 = Math.hypot(cx - px, cy - py), l2 = Math.hypot(nx - cx, ny - cy);
    const k = Math.min(r, l1 / 2, l2 / 2);
    if (k < 0.5) { d += ` L${cx},${cy}`; continue; }
    const ax = cx - ((cx - px) / l1) * k, ay = cy - ((cy - py) / l1) * k;
    const bx = cx + ((nx - cx) / l2) * k, by = cy + ((ny - cy) / l2) * k;
    d += ` L${ax},${ay} Q${cx},${cy} ${bx},${by}`;
  }
  const last = p[p.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}

export function PropagationMap({
  graph,
  path,
  priority,
  otherIncidentServices,
}: {
  graph: ServiceGraph;
  path: PropagationStep[];
  priority: string;
  otherIncidentServices: Set<string>;
}) {
  const { pos, width, height } = useMemo(() => layout(graph), [graph]);
  const color = PRIORITY_COLOR[priority] ?? "#dc2626";
  const inPath = new Map(path.map((p) => [p.service, p]));
  const offGraph = path.filter((p) => !pos.has(p.service));

  // A propagation edge runs from a failing callee back to the caller it broke.
  const hot = new Set(path.filter((p) => p.from).map((p) => `${p.from}|${p.service}`));

  return (
    <div className="min-w-0">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-auto" role="img" aria-label="Service dependency graph with the incident's propagation path highlighted">
        <defs>
          <marker id="arrow-hot" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill={color} />
          </marker>
          <marker id="arrow-dep" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="#cbd5e1" />
          </marker>
        </defs>
        {graph.edges.map((e) => {
          const a = pos.get(e.caller);
          const b = pos.get(e.callee);
          if (!a || !b) return null;
          const isHot = hot.has(`${e.callee}|${e.caller}`);
          const bothIn = inPath.has(e.caller) && inPath.has(e.callee);
          const { d, rev } = route(a, b);
          if (isHot) {
            // Drawn callee → caller so the arrow shows the direction of impact.
            return (
              <path key={`${e.caller}-${e.callee}`} d={rev} fill="none" stroke={color} strokeWidth={2.5}
                markerEnd="url(#arrow-hot)" className="propagation-edge" />
            );
          }
          if (bothIn) {
            return <path key={`${e.caller}-${e.callee}`} d={d} fill="none" stroke={color} strokeOpacity={0.45} strokeWidth={1.5} strokeDasharray="4 3" />;
          }
          return <path key={`${e.caller}-${e.callee}`} d={d} fill="none" stroke="#e2e8f0" strokeWidth={1.2} markerEnd="url(#arrow-dep)" />;
        })}
        {graph.nodes.map((n) => {
          const p = pos.get(n.id)!;
          const step = inPath.get(n.id);
          const other = !step && otherIncidentServices.has(n.id);
          return (
            <g key={n.id} transform={`translate(${p.x},${p.y})`}>
              <title>{`${n.id} · criticality ${n.criticality}${step ? (step.isRoot ? " · probable origin" : " · affected") : ""}`}</title>
              {step?.isRoot && (
                <rect x={-4} y={-4} width={NODE_W + 8} height={NODE_H + 8} rx={12} fill="none" stroke={color} strokeWidth={1.5} strokeDasharray="3 3" className="origin-ring" />
              )}
              <rect width={NODE_W} height={NODE_H} rx={9}
                fill={step ? (step.isRoot ? color : "#fff1f2") : other ? "#fffbeb" : "#ffffff"}
                stroke={step ? color : other ? "#f59e0b" : "#e2e8f0"} strokeWidth={step ? 1.5 : 1} />
              <text x={10} y={NODE_H / 2 + 4} fontSize={11} fontWeight={step ? 700 : 500}
                fill={step?.isRoot ? "#ffffff" : step ? "#7f1d1d" : "#334155"}>
                {n.id.length > 19 ? `${n.id.slice(0, 18)}…` : n.id}
              </text>
              <text x={NODE_W - 8} y={NODE_H / 2 + 4} fontSize={9.5} textAnchor="end" fill={step?.isRoot ? "#fee2e2" : "#94a3b8"}>
                {n.criticality}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-2 text-[11px] text-gray-600">
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded" style={{ background: color }} />probable origin</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded border" style={{ borderColor: color, background: "#fff1f2" }} />affected by this incident</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-5 h-0.5" style={{ background: color }} />direction of impact</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-3 h-3 rounded border border-amber-400 bg-amber-50" />in another incident</span>
        <span className="text-gray-500">number = business criticality</span>
      </div>
      {offGraph.length > 0 && (
        <p className="mt-1 text-[11px] text-gray-600">
          Not in the reference graph: {offGraph.map((p) => p.service).join(", ")} (criticality defaults to 50).
        </p>
      )}
    </div>
  );
}
