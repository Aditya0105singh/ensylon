"use client";

import { IoMdGitMerge } from "react-icons/io";
import { KeepLoader, PageHero } from "@/shared/ui";
import { useStreamMetrics } from "@/entities/engine/useEngine";
import { SOURCE_COLOR, SOURCE_NAME } from "@/entities/engine/charts";

const hhmmss = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3">
      <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">{label}</div>
      <div className="text-2xl font-extrabold text-gray-900">{value}</div>
      {hint && <div className="text-[11px] text-gray-600">{hint}</div>}
    </div>
  );
}

export function DeduplicationClient() {
  const { data, error, isLoading } = useStreamMetrics();

  if (isLoading) return <KeepLoader loadingText="Loading deduplication stats..." />;
  if (error || !data) {
    return <div className="p-4 text-sm text-red-800">Live streams are not running on the backend.</div>;
  }
  const d = data.dedup;
  const max = Math.max(1, ...data.top_repeats.map((r) => r.count));

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={IoMdGitMerge}
        title="Deduplication"
        subtitle="A condition that keeps firing is one signal, not fifty. Repeats collapse into the earliest occurrence, which keeps the true onset time for root-cause analysis."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Signals received" value={d.received} hint="after parsing + redaction" />
        <Stat label="Distinct conditions" value={d.distinct} hint="what the engine actually reasons about" />
        <Stat label="Collapsed" value={d.collapsed} hint="repeats folded into an earlier signal" />
        <Stat label="Volume removed" value={`${d.collapsed_pct}%`} hint={`fingerprint window ${d.bucket_minutes} min`} />
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-4 text-xs text-gray-800">
        <h2 className="text-sm font-bold text-gray-900 mb-1">How a repeat is recognised</h2>
        <p>
          Fingerprint = <b>service + component + condition</b>, inside a {d.bucket_minutes}-minute window. For logs the condition is the mined Drain3
          template, so "pool exhausted: 100/100" and "pool exhausted: 99/100" are the same condition. For CloudWatch and Grafana it is the alarm or
          metric name. The earliest signal survives and carries the repeat count; a repeat never creates a second signal, and never a second incident.
        </p>
      </div>

      <div className="rounded-2xl border border-gray-200 bg-white p-4">
        <h2 className="text-sm font-bold text-gray-900 mb-2">Most repeated conditions</h2>
        {data.top_repeats.length === 0 ? (
          <p className="text-xs text-gray-500">No repeated conditions yet.</p>
        ) : (
          <ul className="space-y-2">
            {data.top_repeats.map((r) => (
              <li key={r.service + r.component + r.evidence} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate">
                    <span className="font-semibold text-gray-900">{r.service}</span>
                    {r.component && <span className="text-gray-500"> · {r.component}</span>}{" "}
                    <span className="inline-flex items-center gap-1 text-gray-600">
                      <span className="w-2 h-2 rounded-sm" style={{ background: SOURCE_COLOR[r.source] ?? "#9ca3af" }} />
                      {SOURCE_NAME[r.source] ?? r.source}
                    </span>
                  </span>
                  <span className="font-mono font-bold text-gray-900 shrink-0">×{r.count}</span>
                </div>
                <div className="h-1.5 rounded-full bg-gray-100 mt-1 overflow-hidden">
                  <div className="h-full rounded-full bg-green-600" style={{ width: `${Math.max(3, (r.count / max) * 100)}%` }} />
                </div>
                <div className="text-gray-600 truncate mt-0.5" title={r.evidence}>{r.evidence}</div>
                <div className="text-[10px] text-gray-400">first {hhmmss(r.first)} · last {hhmmss(r.last)} UTC</div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
