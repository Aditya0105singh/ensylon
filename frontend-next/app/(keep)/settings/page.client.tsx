"use client";

import { HiOutlineCog6Tooth } from "react-icons/hi2";
import { KeepLoader, PageHero } from "@/shared/ui";
import { useStreamStatus } from "@/entities/engine/useEngine";

function Row({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-gray-100 last:border-0 text-sm">
      <span className="text-gray-500">{label}</span>
      <span className={mono ? "text-xs font-mono text-gray-800 break-all text-right" : "font-medium text-gray-900 text-right"}>{value}</span>
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-gray-200 bg-white p-4">
      <h2 className="text-xs uppercase tracking-wide text-gray-400 font-semibold mb-1">{title}</h2>
      {children}
    </section>
  );
}

export default function SettingsPage() {
  const { data, error, isLoading } = useStreamStatus();

  return (
    <div className="flex flex-col gap-4 p-4">
      <PageHero
        icon={HiOutlineCog6Tooth}
        title="Settings"
        subtitle="What is actually configured and running. Everything here is read from the backend; change it with environment variables (see README)."
      />
      {isLoading ? (
        <KeepLoader includeMinHeight={false} loadingText="Loading status..." />
      ) : error || !data ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">Backend not reachable, or the live streams are not running.</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card title="Input">
            <Row label="Signal host" value={data.base_url} mono />
            <Row label="Dependency graph" value={data.graph_origin} />
            <Row label="Streams connected" value={`${data.streams.filter((s) => s.connected).length} of ${data.streams.length}`} />
            <Row label="Micro-batch interval" value={`${data.tick_seconds}s`} />
            <Row label="Backend uptime" value={`${Math.round(data.uptime_seconds / 60)} min`} />
          </Card>
          <Card title="Ticket drafting (Claude)">
            <Row label="Claude drafting" value={data.claude.enabled ? "on" : "off - template drafts"} />
            <Row label="Model" value={data.claude.model} mono />
            <Row label="Drafts written by Claude" value={data.claude.narrated ?? 0} />
            <Row label="Fell back to template" value={data.claude.fallback ?? 0} />
            {!data.claude.enabled && (
              <p className="text-[11px] text-gray-500 mt-2">Set ANTHROPIC_API_KEY in the backend environment or .env and restart to turn this on.</p>
            )}
          </Card>
          <Card title="Output">
            <Row label="Approved tickets are written to" value={data.tickets_dir} mono />
            <Row label="Written before approval" value="never" />
          </Card>
          <Card title="Engine">
            <Row label="Signals received" value={data.engine.signals_received} />
            <Row label="Micro-batches run" value={data.engine.ticks} />
            <Row label="Incidents" value={data.engine.incidents} />
            <Row label="Rejected by validation" value={data.engine.validation_rejections} />
          </Card>
        </div>
      )}
    </div>
  );
}
