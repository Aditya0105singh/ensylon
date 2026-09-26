"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Badge,
  Card,
  ProgressBar,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
  Text,
  Title,
} from "@tremor/react";
import {
  EmptyStateCard,
  KeepLoader,
  PageHero,
  SeverityLabel,
} from "@/shared/ui";
import type { UISeverity } from "@/shared/ui";
import { MdOutlineNotificationsActive } from "react-icons/md";
import { HiOutlineExclamationTriangle } from "react-icons/hi2";
import {
  useForecast,
  useIncident,
  useIncidentComparison,
  usePlaybook,
  useRootCauseConfidence,
} from "@/entities/alertlens";
import type { Alert } from "@/entities/alertlens";
import { AlertDetailDrawer } from "@/entities/alertlens/ui/AlertDetailDrawer";
import { AlertIcon, ServiceChip } from "@/entities/alertlens/ui/AlertIcon";
import { StatCard } from "@/entities/alertlens/ui/StatCard";
import { riskColor, timeAgo } from "@/entities/alertlens/lib/format";
import { InteractiveTerminalModal } from "@/components/remediation/InteractiveTerminalModal";
import { Button as TremorButton } from "@tremor/react";
import { IoTerminal } from "react-icons/io5";

const Panel = ({
  isLoading,
  error,
  isEmpty,
  emptyText,
  children,
}: {
  isLoading: boolean;
  error?: unknown;
  isEmpty?: boolean;
  emptyText: string;
  children: React.ReactNode;
}) => {
  if (isLoading) return <KeepLoader loadingText="Loading..." />;
  if (error)
    return (
      <EmptyStateCard title="Could not load" description={String(error)} />
    );
  if (isEmpty) return <EmptyStateCard title={emptyText} />;
  return <>{children}</>;
};

export function IncidentDetailClient({ incidentId }: { incidentId: string }) {
  const { incident, isLoading, error, notFound } = useIncident(incidentId);
  const [selected, setSelected] = useState<Alert | null>(null);
  const [terminalState, setTerminalState] = useState<{
    open: boolean;
    title: string;
    command: string;
  }>({ open: false, title: "", command: "" });

  const forecast = useForecast(incidentId);
  const rootCause = useRootCauseConfidence(incidentId);
  const comparison = useIncidentComparison(incidentId);
  const playbook = usePlaybook(incidentId);

  if (isLoading) return <KeepLoader loadingText="Loading incident..." />;

  if (error || notFound || !incident) {
    return (
      <div className="p-4">
        <EmptyStateCard
          icon={MdOutlineNotificationsActive}
          title={notFound ? "Incident not found" : "Could not load incident"}
          description={
            notFound
              ? `No incident with id ${incidentId} in the current batch.`
              : String(error)
          }
        >
          <Link href="/incidents" className="text-green-500 text-sm">
            Back to incidents
          </Link>
        </EmptyStateCard>
      </div>
    );
  }

  const color = riskColor(incident.risk.level);

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <PageHero
        icon={HiOutlineExclamationTriangle}
        eyebrow={
          <Link href="/incidents" className="hover:text-green-700 font-medium">
            ← Incidents
          </Link>
        }
        title={incident.root_cause.alertname}
        subtitle={<>Root cause on {incident.root_cause.service} · {timeAgo(incident.root_cause.timestamp)}</>}
      >
        <SeverityLabel severity={incident.root_cause.severity as UISeverity} />
        <Badge color={color}>{incident.risk.level} risk</Badge>
      </PageHero>

      <Card className="p-4">
        <Text>{incident.summary}</Text>
        <div className="mt-3">
          <div className="flex justify-between text-xs text-gray-500 mb-1">
            <span>Escalation risk</span>
            <span>{Math.round(incident.risk.score * 100)}%</span>
          </div>
          <ProgressBar value={incident.risk.score * 100} color={color} />
        </div>
      </Card>

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Alerts in incident" value={incident.size} />
        <StatCard label="Raw alerts collapsed" value={incident.raw_alert_count} />
        <StatCard
          label="Services affected"
          value={incident.risk.services_affected}
        />
        <StatCard
          label="Triage time saved"
          value={`${incident.est_triage_minutes_saved}m`}
        />
      </div>

      <TabGroup className="flex-1">
        {/* On a phone-width screen 6 tabs used to squeeze into equal flex
            shares and clip their own labels ("Root cause" -> "Root ca").
            Letting the row scroll horizontally instead keeps every label
            fully readable - swipe to reach Playbook rather than guess at a
            half-cut word. */}
        <div className="overflow-x-auto">
          <TabList className="flex-nowrap w-max min-w-full">
            <Tab className="whitespace-nowrap">Overview</Tab>
            <Tab className="whitespace-nowrap">Alerts ({incident.size})</Tab>
            <Tab className="whitespace-nowrap">Root cause</Tab>
            <Tab className="whitespace-nowrap">Forecast</Tab>
            <Tab className="whitespace-nowrap">History</Tab>
            <Tab className="whitespace-nowrap">Playbook</Tab>
          </TabList>
        </div>
        <TabPanels>
          {/* Overview — the at-a-glance answer before drilling in */}
          <TabPanel>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
              <Card className="p-4">
                <Title className="text-base mb-2">Root cause</Title>
                <div className="flex items-center gap-2.5">
                  <AlertIcon
                    alertname={incident.root_cause.alertname}
                    severity={incident.root_cause.severity}
                    service={incident.root_cause.service}
                  />
                  <div className="min-w-0">
                    <div className="font-medium truncate">
                      {incident.root_cause.alertname}
                    </div>
                    <Text className="text-xs text-gray-500">
                      <ServiceChip service={incident.root_cause.service} />
                    </Text>
                  </div>
                </div>
                <Text className="mt-2 text-sm">
                  {incident.root_cause.message}
                </Text>
              </Card>

              <Card className="p-4">
                <Title className="text-base mb-2">Risk factors</Title>
                <div className="flex flex-col gap-2">
                  {Object.entries(incident.risk.factors).map(([k, v]) => (
                    <div key={k} className="flex items-center gap-3">
                      <div className="w-32 text-xs text-gray-500 capitalize shrink-0">
                        {k.replace(/_/g, " ")}
                      </div>
                      <div className="flex-1">
                        <ProgressBar value={Number(v) * 100} color={color} />
                      </div>
                      <div className="w-10 text-xs text-right shrink-0">
                        {Math.round(Number(v) * 100)}%
                      </div>
                    </div>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <Title className="text-base mb-2">Affected services</Title>
                <div className="flex flex-wrap gap-1">
                  {Array.from(
                    new Set(incident.alerts.map((a) => a.service))
                  ).map((s) => (
                    <Badge key={s} size="xs" color="gray">
                      {s}
                    </Badge>
                  ))}
                </div>
              </Card>

              <Card className="p-4">
                <Title className="text-base mb-2">Known history</Title>
                {incident.dna_match ? (
                  <>
                    <Text className="text-sm font-medium">
                      {incident.dna_match.incident_id} —{" "}
                      {incident.dna_match.title}
                    </Text>
                    <Text className="text-xs text-gray-500 mt-1">
                      {incident.dna_match.similarity_pct}% similar ·{" "}
                      {incident.dna_match.date}
                    </Text>
                    {incident.dna_match.resolution && (
                      <Text className="text-sm mt-2">
                        <span className="font-medium">Previous fix: </span>
                        {incident.dna_match.resolution}
                      </Text>
                    )}
                  </>
                ) : (
                  <Text className="text-sm text-gray-500">
                    Novel signature — nothing comparable in the Alert DNA
                    library.
                  </Text>
                )}
              </Card>
            </div>
          </TabPanel>

          {/* Alerts */}
          <TabPanel>
            <div className="flex flex-col gap-2 mt-3">
              {incident.alerts.map((a) => (
                <Card
                  key={a.id}
                  className="p-3 cursor-pointer hover:bg-gray-50"
                  onClick={() => setSelected(a)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{a.alertname}</div>
                      <div className="text-xs text-gray-500 truncate">
                        {a.message}
                      </div>
                      <div className="text-xs text-gray-400 mt-1">
                        {a.service} · {a.source} · {timeAgo(a.timestamp)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {(a.duplicate_count ?? 1) > 1 && (
                        <Badge size="xs" color="emerald">
                          ×{a.duplicate_count}
                        </Badge>
                      )}
                      <SeverityLabel severity={a.severity as UISeverity} />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </TabPanel>

          {/* Root cause XAI */}
          <TabPanel>
            <div className="mt-3">
              <Panel
                isLoading={rootCause.isLoading}
                error={rootCause.error}
                isEmpty={!rootCause.data}
                emptyText="No root-cause analysis available"
              >
                <div className="flex flex-col gap-2">
                  {rootCause.data?.candidates?.map((c, i) => (
                    <Card
                      key={`${c.service}-${i}`}
                      className={c.is_selected ? "p-3 ring-2 ring-green-400" : "p-3"}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-medium truncate">
                            {c.alertname}{" "}
                            <span className="text-gray-500">on {c.service}</span>
                          </div>
                          {c.is_selected && (
                            <Badge size="xs" color="emerald" className="mt-1">
                              selected root cause
                            </Badge>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-lg font-semibold">
                            {c.confidence}%
                          </div>
                          <Text className="text-xs text-gray-500">
                            confidence
                          </Text>
                        </div>
                      </div>
                      {c.explanation?.length > 0 && (
                        <ul className="mt-2 text-xs text-gray-600 list-none space-y-0.5">
                          {c.explanation.map((e, j) => (
                            <li key={j}>{e}</li>
                          ))}
                        </ul>
                      )}
                    </Card>
                  ))}
                </div>
              </Panel>
            </div>
          </TabPanel>

          {/* Forecast */}
          <TabPanel>
            <div className="mt-3">
              <Panel
                isLoading={forecast.isLoading}
                error={forecast.error}
                isEmpty={!forecast.data}
                emptyText="No forecast available"
              >
                <div className="flex flex-col gap-3">
                  <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                    <StatCard
                      label="Current risk"
                      value={`${forecast.data?.currentRisk ?? 0}%`}
                    />
                    <StatCard
                      label="Predicted blast radius"
                      value={`${forecast.data?.predictedBlastRadius ?? 0} services`}
                    />
                    <StatCard
                      label="Confidence"
                      value={`${Math.round((forecast.data?.confidence ?? 0) * 100)}%`}
                    />
                  </div>
                  <Card className="p-4">
                    <Title className="text-base">Recommended action</Title>
                    <Text className="mt-1">
                      {forecast.data?.recommendedImmediateAction}
                    </Text>
                  </Card>
                  <Card className="p-4">
                    <Title className="text-base mb-2">Projection</Title>
                    <div className="flex flex-col gap-2">
                      {forecast.data?.forecast?.map((p) => (
                        <div key={p.minutes} className="flex items-center gap-3">
                          <div className="w-16 text-xs text-gray-500 shrink-0">
                            +{p.minutes}m
                          </div>
                          <div className="flex-1">
                            <ProgressBar value={p.risk} color="red" />
                          </div>
                          <div className="w-32 text-xs text-gray-500 text-right shrink-0">
                            {p.alerts} alerts · {p.risk}%
                          </div>
                        </div>
                      ))}
                    </div>
                  </Card>
                </div>
              </Panel>
            </div>
          </TabPanel>

          {/* Historical comparison */}
          <TabPanel>
            <div className="mt-3">
              <Panel
                isLoading={comparison.isLoading}
                error={comparison.error}
                isEmpty={!comparison.data}
                emptyText="No historical comparison available"
              >
                {comparison.data?.has_match === false ? (
                  <EmptyStateCard
                    title="Novel incident signature"
                    description="No similar incident found in the Alert DNA history."
                  />
                ) : (
                  <div className="flex flex-col gap-3">
                    <div className="grid grid-cols-2 xl:grid-cols-3 gap-3">
                      <StatCard
                        label="Similarity"
                        value={`${comparison.data?.similarity ?? 0}%`}
                      />
                      <StatCard
                        label="Confidence"
                        value={`${Math.round((comparison.data?.confidence ?? 0) * 100)}%`}
                      />
                      <StatCard
                        label="Historical resolution"
                        value={
                          comparison.data?.resolution_minutes
                            ? `${comparison.data.resolution_minutes}m`
                            : "n/a"
                        }
                      />
                    </div>
                    {comparison.data?.similarity_breakdown && (
                      <Card className="p-4">
                        <Title className="text-base mb-2">
                          Similarity breakdown
                        </Title>
                        <div className="flex flex-col gap-2">
                          {Object.entries(
                            comparison.data.similarity_breakdown
                          ).map(([k, v]) => (
                            <div key={k} className="flex items-center gap-3">
                              <div className="w-40 text-xs text-gray-500 capitalize shrink-0">
                                {k.replace(/_/g, " ")}
                              </div>
                              <div className="flex-1">
                                <ProgressBar value={Number(v)} color="emerald" />
                              </div>
                              <div className="w-10 text-xs text-right shrink-0">
                                {String(v)}%
                              </div>
                            </div>
                          ))}
                        </div>
                      </Card>
                    )}
                    {incident.dna_match && (
                      <Card className="p-4">
                        <Title className="text-base">
                          {incident.dna_match.incident_id} —{" "}
                          {incident.dna_match.title}
                        </Title>
                        <Text className="mt-1 text-xs text-gray-500">
                          {incident.dna_match.date}
                        </Text>
                        <Text className="mt-2">
                          <span className="font-medium">Root cause: </span>
                          {incident.dna_match.root_cause}
                        </Text>
                        <Text className="mt-1">
                          <span className="font-medium">Symptoms: </span>
                          {incident.dna_match.symptom_pattern}
                        </Text>
                      </Card>
                    )}
                    {(comparison.data?.suggested_actions?.length ?? 0) > 0 && (
                      <Card className="p-4">
                        <Title className="text-base mb-2">
                          Suggested actions
                        </Title>
                        <ul className="list-disc pl-5 text-sm space-y-1">
                          {comparison.data?.suggested_actions.map((a, i) => (
                            <li key={i}>{a}</li>
                          ))}
                        </ul>
                      </Card>
                    )}
                  </div>
                )}
              </Panel>
            </div>
          </TabPanel>

          {/* Playbook */}
          <TabPanel>
            <div className="mt-3">
              <Panel
                isLoading={playbook.isLoading}
                error={playbook.error}
                isEmpty={!playbook.data}
                emptyText="No playbook available"
              >
                <div className="flex flex-col gap-3">
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <Title className="text-base">
                        {playbook.data?.title}
                      </Title>
                      <div className="flex gap-2">
                        <Badge color="red" size="xs">
                          {playbook.data?.priority}
                        </Badge>
                        {playbook.data?.failure_family && (
                          <Badge color="gray" size="xs">
                            {playbook.data.failure_family}
                          </Badge>
                        )}
                        <Badge color="gray" size="xs">
                          {playbook.data?.estimated_resolution
                            ? `Est. ${playbook.data.estimated_resolution}`
                            : "No time estimate"}
                        </Badge>
                      </div>
                    </div>
                  </Card>
                  {playbook.data?.steps?.map((s) => (
                    <Card key={s.step_number} className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3 min-w-0">
                          <div className="w-7 h-7 rounded-full bg-green-100 text-green-600 flex items-center justify-center text-sm font-semibold shrink-0">
                            {s.step_number}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium">{s.title}</div>
                            <Text className="mt-1 text-sm">{s.description}</Text>
                          </div>
                        </div>
                        <TremorButton
                          size="xs"
                          color="emerald"
                          variant="secondary"
                          icon={IoTerminal}
                          onClick={() =>
                            setTerminalState({
                              open: true,
                              title: s.title,
                              command: `kubectl exec -n production deploy/${incident.root_cause.service} -- ${s.title.toLowerCase().replace(/ /g, "_")}.sh`,
                            })
                          }
                          className="shrink-0"
                        >
                          Run in Terminal
                        </TremorButton>
                      </div>
                    </Card>
                  ))}
                </div>
              </Panel>
            </div>
          </TabPanel>
        </TabPanels>
      </TabGroup>

      <AlertDetailDrawer alert={selected} onClose={() => setSelected(null)} />

      <InteractiveTerminalModal
        isOpen={terminalState.open}
        onClose={() => setTerminalState({ open: false, title: "", command: "" })}
        actionTitle={terminalState.title}
        commandText={terminalState.command}
        targetService={incident.root_cause.service}
      />
    </div>
  );
}

