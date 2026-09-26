"use client";

import { Badge, Card, Text } from "@tremor/react";
import { useEngineHealth } from "./useEngine";

function formatUptime(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 90) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 border-b border-gray-100 last:border-0">
      <Text className="text-sm text-gray-500">{label}</Text>
      <span className="text-sm font-medium text-right">{children}</span>
    </div>
  );
}

/** A live integration and a mock one must never look alike: the mock badge is
 * grey and says so, because a green "connected" on a stub would be a lie. */
function Transport({ live, name }: { live: boolean; name: string }) {
  return (
    <Badge color={live ? "emerald" : "gray"} size="xs">
      {live ? `live · ${name}` : "mock"}
    </Badge>
  );
}

/** The engine's own health, straight from GET /engine/health. An incident tool
 * that watches other systems should be able to answer "are you working?"
 * about itself. */
export function EngineHealthCard() {
  const { data: h, error } = useEngineHealth();

  if (error) {
    return (
      <Card>
        <Text className="text-xs uppercase tracking-wide text-gray-400 mb-2">
          Engine health
        </Text>
        <Text className="text-sm text-red-600">Health endpoint unreachable.</Text>
      </Card>
    );
  }
  if (!h) return null;

  const stages = Object.entries(h.last_pipeline_run?.elapsed_ms ?? {});
  const slowest = Math.max(1, ...stages.map(([, ms]) => ms));

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <Text className="text-xs uppercase tracking-wide text-gray-400">
          Engine health
        </Text>
        <Badge color={h.status === "ok" ? "emerald" : "red"} size="xs">
          {h.status} · up {formatUptime(h.uptime_seconds)}
        </Badge>
      </div>

      <Row label="Awaiting human review">
        {h.queue.awaiting_review}
        {h.queue.awaiting_review_p1 > 0 && (
          <span className="ml-2 text-red-700">({h.queue.awaiting_review_p1} P1)</span>
        )}
      </Row>
      <Row label="Jira">
        <Transport live={h.jira.live} name={h.jira.transport} />
      </Row>
      <Row label="P1 paging">
        <span className="mr-2 text-gray-600">{h.notifications.sent} sent</span>
        <Transport live={h.notifications.live} name={h.notifications.transport} />
      </Row>
      <Row label="LLM narrative">
        {h.llm.live ? (
          <Badge color="emerald" size="xs">
            {h.llm.configured_providers.join(", ")}
          </Badge>
        ) : (
          <Badge color="gray" size="xs">
            template fallback
          </Badge>
        )}
      </Row>
      <Row label="State persistence">
        <Badge color={h.persistence_enabled ? "emerald" : "gray"} size="xs">
          {h.persistence_enabled ? "event log on" : "in-memory only"}
        </Badge>
      </Row>

      {stages.length > 0 && (
        <div className="mt-3">
          <Text className="text-xs uppercase tracking-wide text-gray-400 mb-1.5">
            Last run · {h.last_pipeline_run?.signals_ingested} signals →{" "}
            {h.last_pipeline_run?.incidents_formed} incident(s)
          </Text>
          {stages.map(([stage, ms]) => (
            <div key={stage} className="flex items-center gap-2 py-0.5">
              <span className="w-32 shrink-0 text-xs text-gray-600">
                {stage.replace(/_/g, " ")}
              </span>
              <div className="flex-1 h-1.5 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-green-500"
                  style={{ width: `${Math.max(3, (ms / slowest) * 100)}%` }}
                />
              </div>
              <span className="w-14 shrink-0 text-right font-mono text-xs text-gray-700">
                {ms.toFixed(1)} ms
              </span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
