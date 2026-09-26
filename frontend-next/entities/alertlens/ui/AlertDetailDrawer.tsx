"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Badge, Button, ProgressBar, Text, Title } from "@tremor/react";
import { Drawer } from "@/shared/ui/Drawer";
import { SeverityLabel, showErrorToast, showSuccessToast } from "@/shared/ui";
import type { UISeverity } from "@/shared/ui";
import { useAlertActions, useClusters } from "@/entities/alertlens";
import type { Alert } from "@/entities/alertlens";
import { formatTimestamp, riskColor, timeAgo } from "@/entities/alertlens/lib/format";
import { AlertIcon, ServiceChip } from "./AlertIcon";
import { useIncidentPanel } from "./IncidentPanelProvider";
import { XMarkIcon } from "@heroicons/react/24/outline";
import { LuArrowRight } from "react-icons/lu";

const STATUS_COLOR: Record<string, "red" | "orange" | "emerald" | "gray" | "blue"> = {
  firing: "red",
  pending: "orange",
  resolved: "emerald",
  suppressed: "gray",
  acknowledged: "blue",
};

function getStatusColor(status: string): "red" | "orange" | "emerald" | "gray" | "blue" {
  return STATUS_COLOR[status?.toLowerCase()] ?? "gray";
}

const Field = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div className="flex flex-col gap-0.5">
    <Text className="text-xs uppercase tracking-wide text-gray-500">
      {label}
    </Text>
    <div className="text-sm">{children}</div>
  </div>
);

export function AlertDetailDrawer({
  alert,
  onClose,
}: {
  alert: Alert | null;
  onClose: () => void;
}) {
  const { ackAlert, assignAlert, dismissAlert, escalateAlert } =
    useAlertActions();
  const { clusters } = useClusters();
  const { openIncident } = useIncidentPanel();
  const [busy, setBusy] = useState<string | null>(null);

  // Real cluster membership, not a placeholder - looked up from the same
  // pipeline state the Incidents/Correlations pages use, so a click through
  // to "View incident" lands on the actual correlated group this alert is
  // part of right now.
  const relatedCluster = useMemo(
    () => clusters.find((c) => c.alerts.some((a) => a.id === alert?.id)) ?? null,
    [clusters, alert]
  );

  if (!alert) return null;

  // Each action replays the batch server-side, so the drawer closes and the
  // whole pipeline revalidates rather than trying to patch this row locally.
  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await fn();
      showSuccessToast(`${name} applied`);
      onClose();
    } catch (e) {
      showErrorToast(e, `Could not ${name.toLowerCase()} this alert`);
    } finally {
      setBusy(null);
    }
  };

  const isAcked = Boolean(alert.acked);
  const isEscalated = Boolean(alert.escalated);
  const assignee =
    alert.assignee && alert.assignee !== "n/a" ? alert.assignee : null;

  return (
    <Drawer isOpen={!!alert} onClose={onClose}>
      <div className="flex flex-col gap-4">
        {/* Header row with close button */}
        <div className="flex items-start justify-between gap-3 pb-3 border-b border-gray-200">
          <div className="flex items-start gap-3 min-w-0">
            <AlertIcon
              alertname={alert.alertname}
              severity={alert.severity}
              service={alert.service}
              className="mt-0.5"
            />
            <div className="min-w-0">
              <Title className="truncate">{alert.alertname}</Title>
              <Text className="text-gray-500">
                <ServiceChip service={alert.service} />
              </Text>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <SeverityLabel severity={alert.severity as UISeverity} />
            <button
              onClick={onClose}
              className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
              aria-label="Close"
            >
              <XMarkIcon className="h-5 w-5" />
            </button>
          </div>
        </div>

        <Text>{alert.message}</Text>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Status">
            <Badge size="xs" color={getStatusColor(alert.status)}>
              {alert.status}
            </Badge>
          </Field>
          <Field label="Source">{alert.source}</Field>
          <Field label="Received">
            <span title={formatTimestamp(alert.timestamp)}>
              {timeAgo(alert.timestamp)}
            </span>
          </Field>
          {/* Only post-dedup alerts carry these; raw feed rows do not. */}
          {alert.duplicate_count != null && (
            <Field label="Duplicates collapsed">×{alert.duplicate_count}</Field>
          )}
          {alert.fingerprint && (
            <Field label="Fingerprint">
              <span className="font-mono text-xs">{alert.fingerprint}</span>
            </Field>
          )}
          <Field label="Assignee">{assignee ?? "Unassigned"}</Field>
          <Field label="Acknowledged">{isAcked ? "Yes" : "No"}</Field>
          <Field label="Escalated">{isEscalated ? "Yes" : "No"}</Field>
        </div>

        {/* Real cluster membership from the same pipeline state the
            Incidents page reads — not filler content. */}
        <div className="border-t border-gray-200 pt-3">
          <Text className="text-xs uppercase tracking-wide text-gray-500 mb-2">
            Related incident
          </Text>
          {relatedCluster ? (
            <button
              onClick={() => {
                onClose();
                openIncident(relatedCluster.cluster_id);
              }}
              className="w-full text-left flex flex-col gap-2 rounded-lg border border-gray-200 p-3 hover:border-green-300 hover:bg-green-50/50 transition-colors group"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-medium truncate group-hover:text-green-600">
                    {relatedCluster.root_cause.alertname}
                  </div>
                  <Text className="text-xs text-gray-500">
                    Root cause on {relatedCluster.root_cause.service} ·{" "}
                    {relatedCluster.size} alerts in this incident
                  </Text>
                </div>
                <Badge size="xs" color={riskColor(relatedCluster.risk.level)}>
                  {relatedCluster.risk.level} risk
                </Badge>
              </div>
              <ProgressBar
                value={relatedCluster.risk.score * 100}
                color={riskColor(relatedCluster.risk.level)}
              />
              {relatedCluster.dna_match && (
                <Text className="text-xs text-gray-500">
                  Alert DNA · {relatedCluster.dna_match.similarity_pct}%
                  similar to {relatedCluster.dna_match.incident_id}
                </Text>
              )}
              <span className="flex items-center gap-1 text-xs font-medium text-green-500">
                View incident <LuArrowRight className="w-3 h-3" />
              </span>
            </button>
          ) : (
            <Text className="text-sm text-gray-400">
              Not correlated into any incident — still background noise, or
              not yet clustered.
            </Text>
          )}
        </div>

        {/* Investigative actions — these change how the alert is tracked, not
            its outcome, so they share the brand colour. */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
          <Button
            size="xs"
            color="emerald"
            variant={isAcked ? "secondary" : "primary"}
            loading={busy === "Acknowledge"}
            onClick={() =>
              run("Acknowledge", () => ackAlert(alert.id, !isAcked))
            }
          >
            {isAcked ? "Un-acknowledge" : "Acknowledge"}
          </Button>
          <Button
            size="xs"
            color="emerald"
            variant="secondary"
            loading={busy === "Escalate"}
            onClick={() =>
              run("Escalate", () => escalateAlert(alert.id, !isEscalated))
            }
          >
            {isEscalated ? "De-escalate" : "Escalate"}
          </Button>
          <Button
            size="xs"
            color="emerald"
            variant="secondary"
            loading={busy === "Assign"}
            onClick={() =>
              run("Assign", () => assignAlert(alert.id, assignee ? null : "me"))
            }
          >
            {assignee ? "Unassign" : "Assign to me"}
          </Button>
        </div>

        {/* Outcome actions — these change the alert's disposition, so they get
            their own colours: gray to de-emphasise (suppress), emerald to
            signal it's handled (resolve), rather than matching the buttons
            above that don't change the outcome at all. */}
        <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-200">
          <Button
            size="xs"
            color="gray"
            variant="secondary"
            loading={busy === "Suppress"}
            onClick={() =>
              run("Suppress", () =>
                dismissAlert(
                  alert.id,
                  alert.status === "suppressed" ? null : "suppressed"
                )
              )
            }
          >
            {alert.status === "suppressed" ? "Un-suppress" : "Suppress"}
          </Button>
          <Button
            size="xs"
            color="emerald"
            variant="secondary"
            loading={busy === "Resolve"}
            onClick={() =>
              run("Resolve", () =>
                dismissAlert(
                  alert.id,
                  alert.status === "resolved" ? null : "resolved"
                )
              )
            }
          >
            {alert.status === "resolved" ? "Reopen" : "Resolve"}
          </Button>
        </div>
      </div>
    </Drawer>
  );
}
