"use client";

import { useEffect, useMemo } from "react";
import clsx from "clsx";
import {
  Background,
  Controls,
  Edge,
  Handle,
  MarkerType,
  Node,
  NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { HiOutlineExclamationTriangle, HiOutlineServerStack, HiOutlineStar } from "react-icons/hi2";
import { TbTopologyRing } from "react-icons/tb";
import { EmptyStateCard, KeepLoader, PageHero } from "@/shared/ui";
import { usePipelineState } from "@/entities/alertlens";
import { useIncidentPanel } from "@/entities/alertlens/ui/IncidentPanelProvider";
import { useCountUp } from "@/entities/alertlens/ui/KpiCards";
import {
  buildTopology,
  layoutTopology,
  NODE_H,
  NODE_W,
  type TopologyNode,
} from "@/entities/alertlens/lib/buildTopology";

const shell = {
  background: "linear-gradient(160deg,#fff 60%,#f0fdf4)",
  boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -12px rgba(16,24,40,.12)",
} as const;

const Tag = () => (
  <span className="text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-full bg-green-100 text-green-800 shrink-0">
    Computed
  </span>
);

const STATUS_STYLE: Record<
  TopologyNode["status"],
  { border: string; grad: string; dot: string; text: string; label: string; ring: string }
> = {
  critical: {
    border: "border-red-300",
    grad: "linear-gradient(160deg,#fff 45%,#fef2f2)",
    dot: "bg-red-500",
    text: "text-red-700",
    label: "Critical",
    ring: "#dc2626",
  },
  warning: {
    border: "border-amber-300",
    grad: "linear-gradient(160deg,#fff 45%,#fffbeb)",
    dot: "bg-amber-500",
    text: "text-amber-700",
    label: "Degraded",
    ring: "#d97706",
  },
  healthy: {
    border: "border-gray-200",
    grad: "#fff",
    dot: "bg-gray-300",
    text: "text-gray-500",
    label: "Healthy",
    ring: "#9ca3af",
  },
};

function StatRing({
  label,
  value,
  total,
  color,
  sub,
}: {
  label: string;
  value: number;
  total?: number;
  color: string;
  sub?: string;
}) {
  const shown = useCountUp(value);
  const r = 15.9155;
  const pct = total ? Math.min(100, (value / Math.max(1, total)) * 100) : 100;
  return (
    <div className="flex items-center gap-3.5">
      <div className="relative w-16 h-16 shrink-0">
        <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
          <circle cx="18" cy="18" r={r} fill="none" stroke="#f3f4f6" strokeWidth="4" />
          <circle
            className="kpi-ring"
            cx="18"
            cy="18"
            r={r}
            fill="none"
            stroke={color}
            strokeWidth="4"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${pct} ${100 - pct}`}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center text-base font-extrabold text-gray-900 tabular-nums">
          {shown}
        </div>
      </div>
      <div className="min-w-0">
        <div className="text-xs font-bold text-gray-700">{label}</div>
        {sub && <div className="text-[11px] text-gray-600 mt-0.5">{sub}</div>}
      </div>
    </div>
  );
}

type ServiceNodeData = { topo: TopologyNode };

function ServiceNode({ data }: NodeProps<Node<ServiceNodeData>>) {
  const { openIncident } = useIncidentPanel();
  const { topo } = data;
  const s = STATUS_STYLE[topo.status];

  const body = (
    <div
      className={clsx("kpi-card rounded-xl border-2 p-3 transition-transform", s.border, topo.cluster && "hover:-translate-y-0.5")}
      style={{ width: NODE_W, height: NODE_H, background: s.grad, boxShadow: "0 2px 6px -2px rgba(16,24,40,.15)" }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={clsx("w-2 h-2 rounded-full shrink-0", s.dot)} />
          <div className="font-semibold text-sm text-gray-900 truncate">{topo.service}</div>
        </div>
        {topo.isRoot && (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-white bg-red-600 rounded-full px-1.5 py-0.5 shrink-0">
            <HiOutlineStar size={9} /> ROOT
          </span>
        )}
      </div>
      <div className="text-xs text-gray-600 mt-1.5">
        {topo.activeAlerts} alert{topo.activeAlerts === 1 ? "" : "s"}
        {topo.activeAlerts > 0 && ` · ${topo.errorRate}% high/critical`}
      </div>
      <div className={clsx("text-[11px] font-bold mt-1", s.text)}>{s.label}</div>
    </div>
  );

  return (
    <>
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      {topo.cluster ? (
        <button onClick={() => openIncident(topo.cluster!.cluster_id)} className="text-left" aria-label={`Open incident for ${topo.service}`}>
          {body}
        </button>
      ) : (
        body
      )}
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </>
  );
}

const nodeTypes = { service: ServiceNode };

function Legend() {
  const items = [
    { dot: "bg-red-500", label: "Critical — root cause, or a high-risk incident" },
    { dot: "bg-amber-500", label: "Degraded — caught up in an incident, not the root" },
    { dot: "bg-gray-300", label: "Healthy — not part of any correlated incident" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-700">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span className={clsx("w-2.5 h-2.5 rounded-full shrink-0", it.dot)} />
          {it.label}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <span className="w-4 h-0.5 bg-red-500 rounded shrink-0" />
        animated edge = high risk incident
      </span>
      <span className="inline-flex items-center gap-1.5">
        <HiOutlineStar size={12} className="text-red-600 shrink-0" />
        root-cause service
      </span>
    </div>
  );
}

export function TopologyClient() {
  const { state, isLoading, error } = usePipelineState();

  const { flowNodes, flowEdges, stats } = useMemo(() => {
    const { nodes, edges } = buildTopology(state);
    const positions = layoutTopology(nodes, edges);

    const fNodes: Node<ServiceNodeData>[] = nodes.map((n) => ({
      id: n.id,
      type: "service",
      position: positions[n.id] ?? { x: 0, y: 0 },
      data: { topo: n },
      draggable: true,
      // Declare dimensions up front: React Flow needs measured nodes before it
      // will route edges or run fitView, and relying on its ResizeObserver
      // leaves them unmeasured when we swap node objects on data refresh.
      width: NODE_W,
      height: NODE_H,
    }));

    const fEdges: Edge[] = edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      animated: e.cluster.risk.level === "high",
      style: {
        stroke: e.cluster.risk.level === "high" ? "#ef4444" : "#f59e0b",
        strokeWidth: 2,
      },
      markerEnd: { type: MarkerType.ArrowClosed },
    }));

    return {
      flowNodes: fNodes,
      flowEdges: fEdges,
      stats: {
        total: nodes.length,
        critical: nodes.filter((n) => n.status === "critical").length,
        warning: nodes.filter((n) => n.status === "warning").length,
        healthy: nodes.filter((n) => n.status === "healthy").length,
        edges: edges.length,
      },
    };
  }, [state]);

  // React Flow v12 needs to own node state so it can record measured
  // dimensions — fully controlled `nodes` with no onNodesChange leaves nodes
  // unmeasured and edges never render.
  const [nodes, setNodes, onNodesChange] = useNodesState(flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(flowEdges);

  useEffect(() => {
    setNodes(flowNodes);
  }, [flowNodes, setNodes]);

  useEffect(() => {
    setEdges(flowEdges);
  }, [flowEdges, setEdges]);

  if (isLoading) {
    return <KeepLoader loadingText="Building service topology..." />;
  }

  if (error) {
    return (
      <div className="p-4">
        <EmptyStateCard
          icon={TbTopologyRing}
          title="Could not load topology"
          description={String(error)}
        />
      </div>
    );
  }

  const healthyPct = stats.total ? Math.round((stats.healthy / stats.total) * 100) : 0;

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <PageHero
        icon={TbTopologyRing}
        title="Service Topology"
        subtitle="Service dependencies inferred from the loaded dataset's incidents (baseline scale pipeline): links run from a root-cause service to the other services in its incident."
      >
        <span
          className={clsx(
            "inline-flex items-center gap-1.5 rounded-full font-bold text-xs px-3 py-1 border",
            stats.critical > 0 ? "bg-red-50 text-red-700 border-red-200" : "bg-green-100 text-green-800 border-green-200"
          )}
        >
          <HiOutlineExclamationTriangle size={14} />
          {stats.critical > 0 ? `${stats.critical} service(s) critical` : "No critical services"}
        </span>
      </PageHero>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <div className="kpi-card rounded-2xl border border-blue-200 p-4" style={shell}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-bold text-gray-700">Services</span>
            <Tag />
          </div>
          <StatRing label="Seen in the current batch" value={stats.total} color="#2563eb" />
        </div>
        <div className="kpi-card rounded-2xl border border-red-200 p-4" style={{ ...shell, animationDelay: "60ms" }}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-bold text-gray-700">Critical</span>
            <Tag />
          </div>
          <StatRing label="Root cause or high-risk incident" value={stats.critical} total={stats.total} color="#dc2626" sub={`${stats.total ? Math.round((stats.critical / stats.total) * 100) : 0}% of services`} />
        </div>
        <div className="kpi-card rounded-2xl border border-amber-200 p-4" style={{ ...shell, animationDelay: "120ms" }}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-bold text-gray-700">Degraded</span>
            <Tag />
          </div>
          <StatRing label="In an incident, not the root" value={stats.warning} total={stats.total} color="#d97706" />
        </div>
        <div className="kpi-card rounded-2xl border border-green-200 p-4" style={{ ...shell, animationDelay: "180ms" }}>
          <div className="flex items-center justify-between gap-2 mb-2">
            <span className="text-xs font-bold text-gray-700">Correlated links</span>
            <Tag />
          </div>
          <StatRing label="Incident-derived dependencies" value={stats.edges} color="#15803d" sub={`${healthyPct}% of services untouched`} />
        </div>
      </div>

      {flowNodes.length === 0 ? (
        <div className="kpi-card rounded-2xl border border-white/80 p-6" style={shell}>
          <EmptyStateCard
            noCard
            icon={TbTopologyRing}
            title="No services to map"
            description="Load an alert batch to derive the service topology."
          />
        </div>
      ) : (
        <div className="kpi-card rounded-2xl border border-white/80 flex-1 min-h-[500px] flex flex-col overflow-hidden" style={{ ...shell, animationDelay: "220ms" }}>
          <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3 border-b border-gray-100 bg-white/70">
            <h2 className="flex items-center gap-1.5 text-sm font-bold text-gray-900 shrink-0">
              <HiOutlineServerStack size={16} className="text-green-600" />
              Dependency graph
            </h2>
            <Legend />
          </div>
          <div className="flex-1 min-h-0">
            <ReactFlowProvider>
              {/* React Flow's default minZoom (0.5) stops fitView short for a tall
                  chain of services, leaving the graph clipped. A lower floor lets
                  it actually fit, and keying on the node count re-fits when a
                  different dataset changes the graph's size. */}
              <ReactFlow
                key={flowNodes.length}
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.15 }}
                minZoom={0.1}
                proOptions={{ hideAttribution: true }}
              >
                <Background />
                <Controls showInteractive={false} />
              </ReactFlow>
            </ReactFlowProvider>
          </div>
        </div>
      )}

      <p className="text-xs text-gray-600">Click a service that belongs to an incident to open it.</p>
    </div>
  );
}
