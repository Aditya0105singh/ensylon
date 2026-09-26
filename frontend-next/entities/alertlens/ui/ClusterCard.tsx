"use client";

import { Badge, Card, ProgressBar, Text, Title } from "@tremor/react";
import { SeverityLabel } from "@/shared/ui";
import type { UISeverity } from "@/shared/ui";
import type { Cluster } from "../model/types";
import { useIncidentPanel } from "./IncidentPanelProvider";
import { riskColor, timeAgo } from "@/entities/alertlens/lib/format";

/**
 * One correlated incident. Used by both the Correlations and Incidents views —
 * they present the same cluster, so they share this card.
 */
export function ClusterCard({ cluster }: { cluster: Cluster }) {
  const { openIncident } = useIncidentPanel();
  const services = Array.from(
    new Set(cluster.alerts.map((a) => a.service).filter(Boolean))
  );
  const color = riskColor(cluster.risk.level);

  return (
    <Card className="p-4 flex flex-col gap-3 transition-shadow hover:shadow-md">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <button
            onClick={() => openIncident(cluster.cluster_id)}
            className="text-left hover:text-green-600"
          >
            <Title className="truncate">
              {cluster.root_cause.alertname}
            </Title>
          </button>
          <Text className="text-gray-500">
            Root cause on {cluster.root_cause.service} ·{" "}
            {timeAgo(cluster.root_cause.timestamp)}
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <SeverityLabel
            severity={cluster.root_cause.severity as UISeverity}
          />
          <Badge size="xs" color={color}>
            {cluster.risk.level} risk
          </Badge>
        </div>
      </div>

      <Text className="text-sm">{cluster.summary}</Text>

      <div className="flex flex-wrap gap-1">
        {services.map((s) => (
          <Badge key={s} size="xs" color="gray">
            {s}
          </Badge>
        ))}
      </div>

      <div>
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>Escalation risk</span>
          <span>{Math.round(cluster.risk.score * 100)}%</span>
        </div>
        <ProgressBar value={cluster.risk.score * 100} color={color} />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm border-t border-gray-200 pt-3">
        <div>
          <Text className="text-xs text-gray-500">Alerts</Text>
          <div className="font-medium">{cluster.size}</div>
        </div>
        <div>
          <Text className="text-xs text-gray-500">Raw collapsed</Text>
          <div className="font-medium">{cluster.raw_alert_count}</div>
        </div>
        <div>
          <Text className="text-xs text-gray-500">Services</Text>
          <div className="font-medium">{cluster.risk.services_affected}</div>
        </div>
        <div>
          <Text className="text-xs text-gray-500">Triage saved</Text>
          <div className="font-medium">
            {cluster.est_triage_minutes_saved}m
          </div>
        </div>
      </div>

      {cluster.dna_match && (
        <div className="border-t border-gray-200 pt-3">
          <Text className="text-xs text-gray-500">
            Alert DNA match · {cluster.dna_match.similarity_pct}% similar
          </Text>
          <div className="text-sm font-medium">
            {cluster.dna_match.incident_id} — {cluster.dna_match.title}
          </div>
        </div>
      )}
    </Card>
  );
}
