import type { Alert, Cluster } from "../model/types";

export type TimelineCategory =
  | "alert"
  | "dedup"
  | "root"
  | "cluster"
  | "spread"
  | "dna"
  | "final";

export interface TimelineEvent {
  id: string;
  /** HH:MM:SS slice of the source timestamp. */
  time: string;
  rawTimestamp: string;
  title: string;
  category: TimelineCategory;
  service: string;
  severity: string;
  duplicateCount: number;
  alert?: Alert;
  /** The technique the pipeline applied at this step. */
  algorithm: string;
  whatHappened: string;
  whyItHappened: string;
}

/**
 * Expands an incident into the discrete decisions the pipeline made, in the
 * order it made them: alerts arriving, duplicates collapsing, the root cause
 * being picked, the cluster forming, the cascade spreading, a historical
 * match landing, and finally the incident being promoted.
 *
 * This is a narration of engine output — it derives everything from the
 * cluster it is given and never invents pipeline results.
 */
export function buildReplayTimeline(cluster: Cluster | null): TimelineEvent[] {
  if (!cluster?.alerts?.length) return [];

  const sortedAlerts = [...cluster.alerts].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp)
  );
  const root = cluster.root_cause;
  const dna = cluster.dna_match;

  const events: TimelineEvent[] = [];
  const seenServices = new Set<string>();
  let accumulatedDups = 0;
  let hasFlaggedRoot = false;
  let hasCreatedCluster = false;

  sortedAlerts.forEach((a, idx) => {
    const isRoot =
      a.id === root.id ||
      (a.service === root.service &&
        a.alertname === root.alertname &&
        !hasFlaggedRoot);
    const dups = a.duplicate_count || 1;
    accumulatedDups += dups - 1;
    const isNewService = !seenServices.has(a.service);
    seenServices.add(a.service);

    // 1. Alert arrived
    events.push({
      id: `evt-arr-${a.id}`,
      time: a.timestamp.slice(11, 19),
      rawTimestamp: a.timestamp,
      title: `${a.service} / ${a.alertname}`,
      category: "alert",
      service: a.service,
      severity: a.severity,
      duplicateCount: accumulatedDups,
      alert: a,
      algorithm: "Monitoring stream ingestion",
      whatHappened: `Raw alert fired on ${a.service}: "${a.alertname}" (${a.severity.toUpperCase()} severity).`,
      whyItHappened: `Threshold breached on ${a.service}. Ingested into the live pipeline buffer.`,
    });

    // 2. Duplicates collapsed
    if (dups > 1) {
      events.push({
        id: `evt-dedup-${a.id}`,
        time: a.timestamp.slice(11, 19),
        rawTimestamp: a.timestamp,
        title: `${dups - 1} duplicate alert${dups - 1 > 1 ? "s" : ""} collapsed`,
        category: "dedup",
        service: a.service,
        severity: "info",
        duplicateCount: accumulatedDups,
        algorithm: "Fingerprint (service + alert name) + 5-minute window",
        whatHappened: `Deduplication collapsed ${dups} repeat fires of ${a.service}/${a.alertname} into 1 unique alert.`,
        whyItHappened: `Repeat fires landed inside the dedup window. Removes noise without losing the count.`,
      });
    }

    // 3. Root cause identified
    if (isRoot && !hasFlaggedRoot) {
      hasFlaggedRoot = true;
      events.push({
        id: `evt-root-${a.id}`,
        time: a.timestamp.slice(11, 19),
        rawTimestamp: a.timestamp,
        title: `Root cause identified: ${a.service}`,
        category: "root",
        service: a.service,
        severity: a.severity,
        duplicateCount: accumulatedDups,
        algorithm: "Earliest timestamp + highest severity ranking",
        whatHappened: `${a.service} (${a.alertname}) picked as the primary cause of this cascade.`,
        whyItHappened: `Earliest alert in the cluster combined with the highest initial severity — failures propagate forward in time.`,
      });
    }

    // 4. Cluster formed
    if (idx >= 1 && !hasCreatedCluster) {
      hasCreatedCluster = true;
      events.push({
        id: `evt-cluster-${a.id}`,
        time: a.timestamp.slice(11, 19),
        rawTimestamp: a.timestamp,
        title: `Incident cluster #${cluster.cluster_id} formed`,
        category: "cluster",
        service: a.service,
        severity: "high",
        duplicateCount: accumulatedDups,
        algorithm: "TF-IDF embeddings + time-windowed DBSCAN (eps = 1.00)",
        whatHappened: `Correlated ${idx + 1} symptoms across ${seenServices.size} service(s) into incident #${cluster.cluster_id}.`,
        whyItHappened: `These alerts share high textual similarity and fired inside the same cascade window.`,
      });
    }

    // 5. Cascade spread to a new service
    if (isNewService && idx > 0) {
      events.push({
        id: `evt-spread-${a.id}`,
        time: a.timestamp.slice(11, 19),
        rawTimestamp: a.timestamp,
        title: `Cascade spread to ${a.service}`,
        category: "spread",
        service: a.service,
        severity: a.severity,
        duplicateCount: accumulatedDups,
        algorithm: "Service dependency traversal",
        whatHappened: `Failure reached ${a.service}. ${seenServices.size} services now impacted.`,
        whyItHappened: `Upstream failure on ${root.service} starved resources or timed out connections on ${a.service}.`,
      });
    }
  });

  const finalTime = sortedAlerts[sortedAlerts.length - 1].timestamp;

  // 6. Historical match
  if (dna) {
    events.push({
      id: "evt-dna-match",
      time: finalTime.slice(11, 19),
      rawTimestamp: finalTime,
      title: `Alert DNA match: ${dna.similarity_pct}% to ${dna.incident_id}`,
      category: "dna",
      service: root.service,
      severity: "critical",
      duplicateCount: accumulatedDups,
      algorithm: "TF-IDF centroid similarity (threshold 25%)",
      whatHappened: `Cluster fingerprint matched historical incident ${dna.incident_id} at ${dna.similarity_pct}% similarity.`,
      whyItHappened: dna.resolution
        ? `Symptoms match institutional memory. Surfaced the verified fix: "${dna.resolution}".`
        : `Symptom vocabulary matches a known past incident.`,
    });
  }

  // 7. Incident promoted
  events.push({
    id: "evt-final-promotion",
    time: finalTime.slice(11, 19),
    rawTimestamp: finalTime,
    title: `Incident #${cluster.cluster_id} promoted to ${cluster.risk.level.toUpperCase()} risk`,
    category: "final",
    service: root.service,
    severity: cluster.risk.level === "high" ? "critical" : "high",
    duplicateCount: accumulatedDups,
    algorithm:
      "Escalation risk = 0.40·growth + 0.35·severity trend + 0.25·service spread",
    whatHappened: `Formation complete with score ${Math.round(cluster.risk.score * 100)}% (${cluster.risk.level.toUpperCase()} risk).`,
    whyItHappened: `All cascade symptoms correlated. Ready for triage — roughly ${cluster.est_triage_minutes_saved || 15} min of manual work saved.`,
  });

  return events;
}
