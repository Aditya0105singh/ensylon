"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import {
  HiCheckCircle,
  HiOutlineArrowTopRightOnSquare,
  HiOutlineBolt,
  HiOutlineCircleStack,
  HiOutlineClipboard,
  HiOutlineExclamationTriangle,
  HiOutlineMinusCircle,
  HiOutlineServerStack,
  HiOutlinePaperAirplane,
  HiOutlineDocumentText,
  HiOutlineCheckBadge,
  HiOutlineSparkles,
  HiOutlineXMark,
} from "react-icons/hi2";
import type { Alert, Cluster } from "../model/types";
import {
  useCorrelationExplanation,
  useIncidentTicket,
  usePlaybook,
  useRootCauseConfidence,
} from "../model/useIncidentInsights";
import { useApi } from "@/shared/lib/hooks/useApi";
import { useSession } from "next-auth/react";
import { AlertDetailDrawer } from "./AlertDetailDrawer";
import { formatTimestamp, timeAgo } from "../lib/format";

type Tab =
  | "overview"
  | "correlation"
  | "evidence"
  | "timeline"
  | "severity"
  | "playbook"
  | "draft"
  | "jira";

const TABS: [Tab, string][] = [
  ["overview", "Overview"],
  ["correlation", "Correlation"],
  ["evidence", "Evidence"],
  ["timeline", "Timeline"],
  ["severity", "Severity"],
  ["playbook", "Playbook"],
  ["draft", "Ticket Draft"],
  ["jira", "Jira"],
];

const SEVERITY_PILL: Record<string, string> = {
  critical: "bg-red-50 text-red-600 ring-red-100",
  high: "bg-orange-50 text-orange-600 ring-orange-100",
  medium: "bg-yellow-50 text-yellow-700 ring-yellow-100",
  low: "bg-green-50 text-green-700 ring-green-100",
  info: "bg-blue-50 text-blue-600 ring-blue-100",
};
const SEVERITY_DOT: Record<string, string> = {
  critical: "bg-red-500",
  high: "bg-orange-500",
  medium: "bg-yellow-500",
  low: "bg-green-500",
  info: "bg-blue-500",
};
const SEVERITY_ORDER = ["critical", "high", "medium", "low", "info"];
const RISK_COLOR: Record<string, string> = { high: "#ef4444", medium: "#f97316", low: "#3b82f6" };
const SIGNAL_CAP = 6;

const clockOf = (ts: string) => ts.slice(11, 19) || formatTimestamp(ts);

const offsetLabel = (sec: number) => {
  if (sec <= 0) return "same second";
  if (sec < 60) return `+${Math.round(sec)}s`;
  if (sec < 3600) return `+${Math.floor(sec / 60)}m`;
  return `+${Math.floor(sec / 3600)}h`;
};

function deriveStatus(c: Cluster): string {
  const root = c.root_cause;
  if (root.dismissed) return "Resolved";
  if (root.escalated || (root.assignee && root.assignee !== "n/a")) return "Investigating";
  return "Open";
}

/**
 * The one incident detail view. Opened as a side panel from anywhere an
 * incident is clicked (Home, Incidents, Correlations, Topology, the alert
 * drawer), so every entry point shows the same thing.
 */
export function IncidentSidePanel({
  cluster,
  onClose,
}: {
  cluster: Cluster | null;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("overview");
  const [alert, setAlert] = useState<Alert | null>(null);
  const [copied, setCopied] = useState(false);
  const id = cluster?.cluster_id ?? null;

  const { data: correlation } = useCorrelationExplanation(id);
  const { data: confidence } = useRootCauseConfidence(id);
  const { data: playbook } = usePlaybook(id);
  const { data: ticket, mutate: refreshTicket } = useIncidentTicket(id);
  const api = useApi();
  const { data: session } = useSession();
  const [approving, setApproving] = useState(false);
  const [approveError, setApproveError] = useState<string | null>(null);

  const approveAndCreate = async () => {
    if (!id) return;
    setApproving(true);
    setApproveError(null);
    try {
      // The gate records who approved, so send the signed-in user.
      const actor = session?.user?.email || session?.user?.name || "on-call";
      await api.post(`/incidents/${id}/ticket/approve?actor=${encodeURIComponent(actor)}`, {});
      await refreshTicket();
      setTab("jira");
    } catch (e) {
      setApproveError(e instanceof Error ? e.message : String(e));
    } finally {
      setApproving(false);
    }
  };

  useEffect(() => setTab("overview"), [id]);

  useEffect(() => {
    if (!cluster) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !alert) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cluster, alert, onClose]);

  const sorted = useMemo(
    () => (cluster ? [...cluster.alerts].sort((a, b) => a.timestamp.localeCompare(b.timestamp)) : []),
    [cluster]
  );

  /** Each service with when it first fired - a real propagation order, not an
   * assumed dependency chain. */
  const cascade = useMemo(() => {
    if (!cluster || !sorted.length) return [];
    const t0 = new Date(sorted[0].timestamp).getTime();
    const byService = new Map<string, { first: number; count: number; worst: string }>();
    for (const a of sorted) {
      const cur = byService.get(a.service);
      const at = new Date(a.timestamp).getTime();
      if (!cur) byService.set(a.service, { first: at, count: 1, worst: a.severity });
      else {
        cur.count += 1;
        if (SEVERITY_ORDER.indexOf(a.severity) < SEVERITY_ORDER.indexOf(cur.worst)) cur.worst = a.severity;
      }
    }
    return [...byService.entries()]
      .map(([service, v]) => ({ service, ...v, offset: (v.first - t0) / 1000 }))
      .sort((a, b) => a.first - b.first);
  }, [cluster, sorted]);

  const severityCounts = useMemo(() => {
    if (!cluster) return [];
    const m = new Map<string, number>();
    for (const a of cluster.alerts) m.set(a.severity, (m.get(a.severity) ?? 0) + 1);
    return SEVERITY_ORDER.filter((s) => m.get(s)).map((s) => ({ severity: s, count: m.get(s)! }));
  }, [cluster]);

  const copySteps = async () => {
    const steps = (playbook?.steps ?? []).map((s, i) => `${i + 1}. ${s.title} — ${s.description}`);
    if (!steps.length) return;
    try {
      await navigator.clipboard.writeText(steps.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  if (!cluster) return null;

  const rootNode = cascade.find((c) => c.service === cluster.root_cause.service) ?? cascade[0];
  const downstream = cascade.filter((c) => c.service !== rootNode?.service);
  const risk = Math.round(cluster.risk.score * 100);
  const sev = cluster.root_cause.severity;
  const status = deriveStatus(cluster);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-slate-900/30 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={`Incident ${cluster.root_cause.alertname}`}
        className="fixed right-0 top-0 z-50 h-full w-full max-w-[min(680px,100vw)] bg-gray-50 shadow-2xl border-l border-gray-200 flex flex-col animate-drawerSlideLeftAndFade"
      >
        {/* Header */}
        <div className="border-b border-green-100 px-5 pt-4 shrink-0" style={{ background: "linear-gradient(135deg,#f0fdf4 0%,#ffffff 60%,#ecfdf5 100%)" }}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-semibold text-gray-600">#{id}</span>
            <span
              title="Severity of the first (root-cause) alert. The incident's priority, which also weighs blast radius and trend, is shown below."
              className={clsx("text-[11px] font-semibold px-2 py-0.5 rounded-md ring-1", SEVERITY_PILL[sev] ?? "bg-gray-50 text-gray-600 ring-gray-100")}
            >
              Root alert: <span className="capitalize">{sev}</span>
            </span>
            <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-600">
              <span className={clsx("w-1.5 h-1.5 rounded-full", status === "Open" ? "bg-red-500" : status === "Investigating" ? "bg-orange-500" : "bg-blue-500")} />
              {status}
            </span>
            <div className="ml-auto flex items-center gap-2">
              {ticket?.published ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-green-700 bg-green-50 ring-1 ring-green-200 rounded-lg px-2.5 py-1.5">
                  <HiOutlineCheckBadge size={13} /> {ticket.jira.key}
                </span>
              ) : (
                <button
                  onClick={approveAndCreate}
                  disabled={approving || !ticket}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-700 hover:bg-green-800 disabled:opacity-60 text-white text-xs font-semibold px-3 py-1.5 shadow-sm transition-colors"
                >
                  <HiOutlinePaperAirplane size={13} />
                  {approving ? "Approving..." : "Approve & Create Jira"}
                </button>
              )}
              <button
                onClick={onClose}
                aria-label="Close"
                className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"
              >
                <HiOutlineXMark size={18} />
              </button>
            </div>
          </div>

          <div className="flex items-start gap-3 mt-2.5">
            <span className={clsx("kpi-pop w-12 h-12 rounded-2xl flex items-center justify-center shrink-0", sev === "critical" ? "bg-red-100 text-red-600" : sev === "high" ? "bg-orange-100 text-orange-600" : sev === "medium" ? "bg-yellow-100 text-yellow-700" : "bg-green-100 text-green-700")}>
              <HiOutlineExclamationTriangle size={24} />
            </span>
            <div className="min-w-0">
              <h2 className="text-xl font-extrabold tracking-tight text-gray-900 break-words leading-tight">
                {cluster.root_cause.alertname}
              </h2>
              <p className="text-xs text-gray-600 mt-1">
                {cluster.root_cause.service}
                {downstream.length > 0 && <> causing issues across {downstream.length} downstream service(s)</>}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap mt-3">
            {playbook?.priority && <Chip tone="amber">{playbook.priority}</Chip>}
            <Chip tone="red">
              Risk <b className="font-bold">{risk}%</b>
            </Chip>
            {correlation && (
              <Chip tone="green">
                Confidence <b className="font-bold">{correlation.confidence_pct}%</b>
              </Chip>
            )}
            <Chip>{cascade.length} Services</Chip>
            <Chip>
              {cluster.size} Signals <span className="text-gray-400 font-normal">({cluster.raw_alert_count} collapsed)</span>
            </Chip>
          </div>

          <div className="flex gap-1.5 mt-4 pb-3 overflow-x-auto">
            {TABS.map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={clsx(
                  "text-[13px] px-3 py-1.5 rounded-full font-semibold whitespace-nowrap transition-all",
                  tab === key ? "bg-green-700 text-white shadow-sm" : "text-gray-600 hover:bg-green-50 hover:text-green-700"
                )}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          {tab === "overview" && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Card title="Root cause (rule-based)">
                  <div className="flex items-start gap-3">
                    <span className="w-10 h-10 rounded-xl bg-red-100 text-red-600 flex items-center justify-center shrink-0">
                      <HiOutlineCircleStack size={19} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-sm font-bold text-gray-900 break-words">{cluster.root_cause.service}</div>
                      <div className="text-xs text-gray-500 mt-1 break-words line-clamp-3">
                        {cluster.root_cause.message || cluster.root_cause.alertname}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 rounded-lg bg-gray-50 border border-gray-100 px-3 py-2 text-xs font-medium text-gray-700">
                    {cluster.size} of {cluster.raw_alert_count} signals · first at {clockOf(cluster.root_cause.timestamp)}
                  </div>
                </Card>

                <Card title="Why this incident?" tint="green">
                  {correlation ? (
                    <ul className="flex flex-col gap-2">
                      {correlation.reasons.map((r, i) => (
                        <li key={i} className="flex items-start gap-2 text-xs text-gray-700">
                          {r.ok ? (
                            <HiCheckCircle className="text-green-500 shrink-0 mt-px" size={15} />
                          ) : (
                            <HiOutlineMinusCircle className="text-gray-300 shrink-0 mt-px" size={15} />
                          )}
                          <span className="break-words leading-snug">{r.text}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <Loading />
                  )}
                </Card>
              </div>

              <Card title="Correlation confidence">
                {correlation ? (
                  <div className="flex flex-col sm:flex-row gap-4">
                    <div className="sm:w-32 shrink-0">
                      <div className="text-3xl font-bold text-gray-900 leading-none">{correlation.confidence_pct}%</div>
                      <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-3">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-green-400 to-green-600"
                          style={{ width: `${correlation.confidence_pct}%` }}
                        />
                      </div>
                    </div>
                    <dl className="flex-1 flex flex-col gap-1.5 min-w-0">
                      {correlation.factors.map((f) => (
                        <div key={f.key} className="flex items-center justify-between gap-2 text-xs">
                          <dt className="text-gray-500 truncate" title={f.detail}>{f.label}</dt>
                          <dd className="font-bold text-gray-900 tabular-nums">{f.score.toFixed(2)}</dd>
                        </div>
                      ))}
                    </dl>
                  </div>
                ) : (
                  <Loading />
                )}
              </Card>

              <Card title="Service Impact Graph">
                {rootNode ? (
                  <>
                    <div className="flex flex-col items-center pt-1">
                      <GraphNode name={rootNode.service} role="Root cause" count={rootNode.count} severity={rootNode.worst} primary />
                      {downstream.length > 0 && (
                        <>
                          <span className="w-px h-5 bg-gray-300" />
                          <div className="flex justify-center w-full">
                            {downstream.slice(0, 4).map((d, i, arr) => (
                              <div key={d.service} className="relative flex justify-center px-1.5 pt-5 min-w-0">
                                {arr.length > 1 && (
                                  <span
                                    className={clsx(
                                      "absolute top-0 h-px bg-gray-300",
                                      i === 0 ? "left-1/2 right-0" : i === arr.length - 1 ? "left-0 right-1/2" : "left-0 right-0"
                                    )}
                                  />
                                )}
                                <span className="absolute top-0 left-1/2 w-px h-4 bg-gray-300" />
                                <span className="absolute top-[15px] left-1/2 -translate-x-1/2 w-0 h-0 border-x-[3.5px] border-x-transparent border-t-[5px] border-t-gray-300" />
                                <GraphNode name={d.service} role={offsetLabel(d.offset)} count={d.count} severity={d.worst} />
                              </div>
                            ))}
                          </div>
                          {downstream.length > 4 && (
                            <p className="text-[11px] text-gray-400 mt-2">+{downstream.length - 4} more service(s)</p>
                          )}
                        </>
                      )}
                    </div>
                    <p className="text-[11px] text-gray-400 mt-4 text-center">
                      Branches are ordered by each service&apos;s real first-alert time in this incident.
                    </p>
                  </>
                ) : (
                  <Loading />
                )}
              </Card>

              <Card
                title={`Related Signals (${cluster.size})`}
                action={
                  cluster.size > SIGNAL_CAP ? (
                    <button onClick={() => setTab("timeline")} className="text-xs font-semibold text-green-700 hover:underline">
                      View all →
                    </button>
                  ) : undefined
                }
              >
                <ul className="flex flex-col">
                  {sorted.slice(0, SIGNAL_CAP).map((a) => (
                    <li key={a.id}>
                      <button
                        onClick={() => setAlert(a)}
                        className="w-full text-left flex items-center gap-2.5 text-xs py-1.5 px-1.5 rounded-lg hover:bg-green-50/70 transition-colors"
                      >
                        <span className={clsx("w-2 h-2 rounded-full shrink-0", SEVERITY_DOT[a.severity] ?? "bg-gray-300")} />
                        <span className="font-mono text-[11px] text-gray-400 shrink-0">{clockOf(a.timestamp)}</span>
                        <span className="text-gray-700 truncate flex-1" title={a.alertname}>{a.alertname}</span>
                        <span className="text-[11px] text-gray-400 shrink-0 truncate max-w-[90px]" title={a.service}>{a.service}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Card title={correlation?.excluded.length ? `Considered & Excluded (${correlation.excluded.length})` : "Considered & Excluded"}>
                  {correlation && correlation.excluded.length > 0 ? (
                    <div className="flex flex-col gap-2.5">
                      {correlation.excluded.map((e) => (
                        <div key={e.id} className="rounded-xl border border-gray-100 bg-gray-50/60 p-3">
                          <div className="flex items-start gap-2.5">
                            <span className="w-9 h-9 rounded-lg bg-white border border-gray-200 text-gray-400 flex items-center justify-center shrink-0">
                              <HiOutlineServerStack size={16} />
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-xs font-semibold text-gray-800 break-words">{e.alertname}</div>
                              <ul className="mt-1.5 flex flex-col gap-1">
                                {e.reasons.map((r, i) => (
                                  <li key={i} className="flex items-start gap-1.5 text-[11px] text-gray-500">
                                    <span className="w-1 h-1 rounded-full bg-gray-300 shrink-0 mt-1.5" />
                                    <span className="break-words">{r}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 mt-2.5">
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-gray-200/70 text-gray-600">Excluded</span>
                            <span className="text-[10px] text-gray-400">distance {e.distance.toFixed(2)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400">
                      No near-miss alerts: everything else sat well outside this incident&apos;s boundary.
                    </p>
                  )}
                </Card>

                <div className="flex flex-col gap-4">
                  <Card
                    title="Incident Summary (AI)"
                    action={
                      <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-green-700 bg-green-50 ring-1 ring-green-100 rounded-full px-2 py-0.5">
                        <HiOutlineSparkles size={11} /> Verified facts
                      </span>
                    }
                  >
                    <p className="text-xs text-gray-600 leading-relaxed break-words">{cluster.summary}</p>
                    {cluster.dna_match && (
                      <div className="rounded-lg bg-blue-50 border border-blue-100 p-2.5 mt-2.5">
                        <div className="text-[11px] font-semibold text-blue-700">
                          Resembles {cluster.dna_match.incident_id} ({cluster.dna_match.similarity_pct}% similar)
                        </div>
                        {cluster.dna_match.resolution && (
                          <div className="text-[11px] text-blue-800 mt-0.5">Previous fix: {cluster.dna_match.resolution}</div>
                        )}
                      </div>
                    )}
                  </Card>

                  <Card title="Suggested Next Steps">
                    {playbook ? (
                      <>
                        <ol className="flex flex-col gap-2">
                          {playbook.steps.slice(0, 3).map((s, i) => (
                            <li key={s.step_number} className="flex items-start gap-2.5 text-xs">
                              <span className="text-gray-400 font-medium shrink-0">{i + 1}.</span>
                              <span className="text-gray-700 break-words leading-snug">{s.title}</span>
                            </li>
                          ))}
                        </ol>
                        <div className="flex items-center justify-between gap-2 mt-3">
                          {playbook.steps.length > 3 ? (
                            <button onClick={() => setTab("playbook")} className="text-xs font-semibold text-green-700 hover:underline">
                              All {playbook.steps.length} steps →
                            </button>
                          ) : (
                            <span />
                          )}
                          <button
                            onClick={copySteps}
                            className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-600 hover:text-green-700 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 shadow-sm"
                          >
                            <HiOutlineClipboard size={12} /> {copied ? "Copied" : "Copy"}
                          </button>
                        </div>
                      </>
                    ) : (
                      <Loading />
                    )}
                  </Card>
                </div>
              </div>
            </>
          )}

          {tab === "correlation" && (
            <Card title="How this group was formed">
              {correlation ? (
                <div className="flex flex-col gap-4">
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {correlation.factors.map((f) => (
                      <div key={f.key} className="rounded-xl bg-green-50 border border-green-100 px-3 py-2.5">
                        <div className="text-lg font-bold text-green-800 leading-none">{f.score.toFixed(2)}</div>
                        <div className="text-[10px] text-gray-500 mt-1.5">{f.label}</div>
                      </div>
                    ))}
                  </div>
                  <ul className="flex flex-col gap-2">
                    {correlation.factors.map((f) => (
                      <li key={f.key} className="text-xs text-gray-600">
                        <span className="font-semibold text-gray-800">{f.label}:</span> {f.detail}
                      </li>
                    ))}
                  </ul>
                  <div className="rounded-xl bg-gray-50 border border-gray-100 p-3 text-xs text-gray-600">
                    <div className="font-semibold text-gray-800 mb-1 flex items-center gap-1.5">
                      <HiOutlineBolt size={13} className="text-gray-400" /> Engine parameters
                    </div>
                    eps {correlation.params.eps.toFixed(2)} · min_samples {correlation.params.min_samples} · time scale{" "}
                    {correlation.params.time_scale_min} min · time penalty {correlation.params.time_penalty ?? "-"}
                  </div>
                </div>
              ) : (
                <Loading />
              )}
            </Card>
          )}

          {tab === "evidence" && (
            <Card title="Root-cause candidates">
              {confidence ? (
                <div className="flex flex-col gap-2.5">
                  {confidence.candidates.map((c) => (
                    <div
                      key={c.service}
                      className={clsx(
                        "rounded-xl border p-3.5",
                        c.is_selected ? "border-green-200 bg-green-50/60" : "border-gray-100 bg-gray-50/40"
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-bold text-gray-900 break-words">{c.service}</span>
                        <span className={clsx("text-sm font-bold", c.is_selected ? "text-green-700" : "text-gray-400")}>
                          {c.confidence}%
                        </span>
                      </div>
                      <ul className="mt-2 flex flex-col gap-1">
                        {c.explanation.map((e, i) => (
                          <li key={i} className="text-[11px] text-gray-600 break-words">{e}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ) : (
                <Loading />
              )}
            </Card>
          )}

          {tab === "timeline" && (
            <Card title={`All signals (${cluster.size})`}>
              <ol className="flex flex-col">
                {sorted.map((a, i) => (
                  <li key={a.id} className="flex gap-3">
                    <div className="flex flex-col items-center pt-1.5">
                      <span className={clsx("w-2.5 h-2.5 rounded-full shrink-0 ring-4 ring-white", SEVERITY_DOT[a.severity] ?? "bg-gray-300")} />
                      {i < sorted.length - 1 && <span className="w-px flex-1 bg-gray-200 min-h-[18px]" />}
                    </div>
                    <button onClick={() => setAlert(a)} className="text-left pb-3.5 min-w-0 flex-1 group">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[11px] text-gray-400">{clockOf(a.timestamp)}</span>
                        <span className={clsx("text-[10px] px-1.5 rounded-md capitalize font-medium", SEVERITY_PILL[a.severity] ?? "bg-gray-100 text-gray-600")}>
                          {a.severity}
                        </span>
                      </div>
                      <div className="text-xs text-gray-800 group-hover:text-green-700 break-words mt-0.5">{a.alertname}</div>
                      <div className="text-[11px] text-gray-400">{a.service} · {timeAgo(a.timestamp)}</div>
                    </button>
                  </li>
                ))}
              </ol>
            </Card>
          )}

          {tab === "severity" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Card title="Severity mix">
                <ul className="flex flex-col gap-3">
                  {severityCounts.map((s) => (
                    <li key={s.severity}>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="flex items-center gap-2">
                          <span className={clsx("w-2 h-2 rounded-full", SEVERITY_DOT[s.severity])} />
                          <span className="capitalize text-gray-600">{s.severity}</span>
                        </span>
                        <span className="text-gray-900 font-bold">
                          {s.count} <span className="text-gray-400 font-normal">({Math.round((100 * s.count) / cluster.size)}%)</span>
                        </span>
                      </div>
                      <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-1.5">
                        <div className={clsx("h-full rounded-full", SEVERITY_DOT[s.severity])} style={{ width: `${(100 * s.count) / cluster.size}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
              <Card title="Risk breakdown">
                <div className="text-3xl font-bold text-gray-900 leading-none">{risk}%</div>
                <div className="text-xs text-gray-400 mt-1.5 capitalize">{cluster.risk.level} risk of escalation</div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden mt-3">
                  <div className="h-full rounded-full" style={{ width: `${risk}%`, background: RISK_COLOR[cluster.risk.level] ?? "#9ca3af" }} />
                </div>
                <dl className="flex flex-col gap-2 mt-4 text-xs">
                  <Row label="Signals" value={`${cluster.size} (${cluster.raw_alert_count} raw)`} />
                  <Row label="Services" value={String(cascade.length)} />
                  <Row label="Triage time saved" value={`~${cluster.est_triage_minutes_saved}m`} />
                </dl>
              </Card>
            </div>
          )}

          {tab === "draft" && (
          <Card
            title="Ticket draft"
            action={
              ticket ? (
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-gray-600 bg-gray-100 rounded-full px-2 py-0.5">
                  {ticket.summary_source === "template" ? "Template-generated" : "LLM-generated"}
                </span>
              ) : undefined
            }
          >
            {ticket ? (
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <Row label="Priority" value={ticket.priority} />
                  <Row label="Signals" value={String(ticket.signal_count)} />
                  <Row label="Services" value={String(ticket.affected_services.length)} />
                  <Row label="Status" value={ticket.status.replace(/_/g, " ")} />
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-gray-500 mb-1">Summary line</div>
                  <div className="text-xs text-gray-800 font-medium break-words">{ticket.title}</div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-gray-500 mb-1">Labels</div>
                  <div className="flex flex-wrap gap-1.5">
                    {ticket.labels.map((l) => (
                      <span key={l} className="text-[10px] bg-gray-100 text-gray-600 rounded px-1.5 py-0.5">
                        {l}
                      </span>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] font-semibold text-gray-500 mb-1">
                    Description (exactly what would be filed)
                  </div>
                  <pre className="text-[11px] text-gray-700 bg-gray-50 border border-gray-100 rounded-xl p-3 whitespace-pre-wrap break-words max-h-72 overflow-y-auto font-mono">
                    {ticket.description}
                  </pre>
                </div>
              </div>
            ) : (
              <Loading />
            )}
          </Card>
        )}

        {tab === "jira" && (
          <Card title="Jira">
            {ticket ? (
              <div className="flex flex-col gap-3">
                <div
                  className={clsx(
                    "rounded-xl border p-3.5 flex items-start gap-3",
                    ticket.published ? "border-green-200 bg-green-50/60" : "border-gray-200 bg-gray-50/60"
                  )}
                >
                  <span
                    className={clsx(
                      "w-10 h-10 rounded-xl flex items-center justify-center shrink-0",
                      ticket.published ? "bg-green-100 text-green-600" : "bg-gray-200 text-gray-500"
                    )}
                  >
                    <HiOutlineDocumentText size={19} />
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-gray-900">
                      {ticket.published ? ticket.jira.key : "Not filed yet"}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {ticket.published
                        ? `Approved by ${ticket.jira.approved_by}`
                        : "Approve to publish this draft through the review gate."}
                    </div>
                  </div>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <div className="text-[11px] font-bold text-amber-800">Simulated Jira</div>
                  <p className="text-[11px] text-amber-800 mt-1 leading-relaxed">
                    No Jira credentials are configured, so the review gate records the exact payload it
                    would have sent and returns a synthetic key instead of calling Jira. The approval
                    itself is real: the gate mints a token for a named human and refuses to file
                    without one. Connecting a live Jira is a one-line transport swap.
                  </p>
                </div>

                {ticket.audit && ticket.audit.length > 0 && (
                  <div>
                    <div className="text-[11px] font-semibold text-gray-500 mb-1">Audit trail</div>
                    <ul className="flex flex-col gap-1">
                      {ticket.audit.map((a, i) => (
                        <li key={i} className="text-[10px] font-mono text-gray-500 break-words">
                          {a}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {approveError && (
                  <p className="text-[11px] text-red-600">Could not approve: {approveError}</p>
                )}

                {!ticket.published && (
                  <button
                    onClick={approveAndCreate}
                    disabled={approving}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-green-700 hover:bg-green-800 disabled:opacity-60 text-white text-xs font-semibold px-3 py-2.5 shadow-sm"
                  >
                    <HiOutlinePaperAirplane size={13} />
                    {approving ? "Approving..." : "Approve & Create Jira"}
                  </button>
                )}
              </div>
            ) : (
              <Loading />
            )}
          </Card>
        )}

        {tab === "playbook" && (
            <Card
              title="Suggested next steps"
              action={
                playbook?.steps?.length ? (
                  <button
                    onClick={copySteps}
                    className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-gray-600 hover:text-green-700 bg-white border border-gray-200 rounded-lg px-2.5 py-1.5 shadow-sm"
                  >
                    <HiOutlineClipboard size={12} /> {copied ? "Copied" : "Copy"}
                  </button>
                ) : undefined
              }
            >
              {playbook ? (
                <div className="flex flex-col gap-3">
                  <div className="flex items-center gap-2 flex-wrap text-xs text-gray-500">
                    <Chip tone="amber">{playbook.priority}</Chip>
                    {playbook.failure_family && <Chip>{playbook.failure_family}</Chip>}
                    <span>
                      {playbook.estimated_resolution
                        ? `Est. ${playbook.estimated_resolution} (${playbook.resolution_basis})`
                        : `No time estimate: ${playbook.resolution_basis}`}
                    </span>
                  </div>
                  <ol className="flex flex-col gap-2.5">
                    {playbook.steps.map((s) => (
                      <li key={s.step_number} className="rounded-xl border border-gray-100 bg-gray-50/40 p-3.5">
                        <div className="flex items-start gap-2.5">
                          <span className="w-6 h-6 rounded-full bg-green-100 text-green-700 text-[11px] font-bold flex items-center justify-center shrink-0">
                            {s.step_number}
                          </span>
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-gray-900 break-words">{s.title}</div>
                            <div className="text-[11px] text-gray-600 mt-1 break-words leading-relaxed">{s.description}</div>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ol>
                </div>
              ) : (
                <Loading />
              )}
            </Card>
          )}
        </div>

        {/* Footer */}
        <div className="shrink-0 bg-white border-t border-gray-100 p-4 flex gap-2">
          <Link
            href={`/incidents/${id}`}
            onClick={onClose}
            className="flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg bg-green-700 hover:bg-green-800 text-white text-xs font-semibold py-2.5 shadow-sm transition-colors"
          >
            Open full incident <HiOutlineArrowTopRightOnSquare size={13} />
          </Link>
          <Link
            href={`/forecast/${id}`}
            onClick={onClose}
            className="inline-flex items-center justify-center rounded-lg border border-gray-200 bg-white hover:border-green-300 text-gray-700 hover:text-green-700 text-xs font-semibold px-4 py-2.5 transition-colors"
          >
            Forecast
          </Link>
        </div>
      </aside>

      <AlertDetailDrawer alert={alert} onClose={() => setAlert(null)} />
    </>
  );
}

function Card({
  title,
  action,
  tint,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  tint?: "green";
  children: React.ReactNode;
}) {
  return (
    <div
      className={clsx(
        "kpi-card rounded-2xl border p-4 min-w-0",
        tint === "green" ? "border-green-100" : "border-white/80"
      )}
      style={{
        background: tint === "green" ? "linear-gradient(160deg,#f0fdf4,#ffffff)" : "linear-gradient(160deg,#fff 60%,#f0fdf4)",
        boxShadow: "0 1px 2px rgba(16,24,40,.05), 0 8px 24px -14px rgba(16,24,40,.15)",
      }}
    >
      <div className="flex items-center justify-between gap-2 mb-3">
        <h3 className="text-sm font-bold text-gray-900">{title}</h3>
        {action}
      </div>
      {children}
    </div>
  );
}

function GraphNode({
  name,
  role,
  count,
  severity,
  primary,
}: {
  name: string;
  role: string;
  count: number;
  severity: string;
  primary?: boolean;
}) {
  return (
    <div
      className={clsx(
        "rounded-xl border px-3 py-2.5 min-w-[120px] max-w-full shadow-sm",
        primary ? "border-red-200 bg-red-50" : "border-amber-200 bg-amber-50"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={clsx(
            "w-6 h-6 rounded-lg flex items-center justify-center shrink-0",
            primary ? "bg-red-100 text-red-600" : "bg-amber-100 text-amber-600"
          )}
        >
          {primary ? <HiOutlineCircleStack size={13} /> : <HiOutlineExclamationTriangle size={13} />}
        </span>
        <span className="text-xs font-bold text-gray-900 truncate" title={name}>{name}</span>
      </div>
      <div className={clsx("text-[10px] mt-1.5 font-medium", primary ? "text-red-600" : "text-amber-700")}>{role}</div>
      <div className="text-[10px] text-gray-400 flex items-center gap-1 mt-0.5">
        <span className={clsx("w-1.5 h-1.5 rounded-full", SEVERITY_DOT[severity] ?? "bg-gray-300")} />
        {count} alert{count === 1 ? "" : "s"}
      </div>
    </div>
  );
}

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: string }) {
  const tones: Record<string, string> = {
    slate: "bg-white text-gray-600 ring-gray-200",
    green: "bg-green-50 text-green-700 ring-green-200",
    red: "bg-red-50 text-red-600 ring-red-200",
    amber: "bg-amber-50 text-amber-700 ring-amber-200",
  };
  return (
    <span className={clsx("text-[11px] font-semibold px-2.5 py-1 rounded-full ring-1 whitespace-nowrap", tones[tone] ?? tones.slate)}>
      {children}
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-gray-400">{label}</dt>
      <dd className="text-gray-800 font-semibold">{value}</dd>
    </div>
  );
}

function Loading() {
  return <div className="text-xs text-gray-400">Loading…</div>;
}
