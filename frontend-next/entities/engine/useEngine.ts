import type { Reviewer } from "./reviewer";
import { useCallback } from "react";
import useSWR, { useSWRConfig, SWRConfiguration } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type {
  AblationRow,
  AuditEntry,
  DemoRunRequest,
  DraftDetail,
  EngineBenchmark,
  EngineHealth,
  Evidence,
  FeedbackState,
  LateSignalResult,
  PipelineReport,
  QueueSummary,
  ReliabilityBucket,
  Topology,
  StreamStatus,
  StreamMetrics,
  CanonicalSignal,
  ValidationRejection,
  ServiceGraph,
} from "./types";

export const REPORT_KEY = "/engine/report";
export const QUEUE_KEY = "/engine/queue";
export const AUDIT_KEY = "/engine/audit";
export const TOPOLOGIES_KEY = "/engine/topologies";

/** Live data refreshes on this cadence; the backend ticks every 2 s. */
export const LIVE_REFRESH_MS = 3000;

/** The sign-off fields every decision sends: the backend records both in the
 * incident archive, and a live run refuses a decision without the email. */
const signer = (who: Reviewer) => ({ actor: who.name.trim(), actor_email: who.email.trim() || undefined });

/** GET /engine/report — the last scenario run's pipeline stats + measured
 * evaluation against its own injected ground truth (see pipeline.evaluate). */
export const useEngineReport = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<PipelineReport>(
    api.isReady() ? REPORT_KEY : null,
    (url: string) => api.get(url),
    { refreshInterval: LIVE_REFRESH_MS, ...options }
  );
};

/** GET /engine/stream/status - connection state of the three SSE streams. */
export const useStreamStatus = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<StreamStatus>(
    api.isReady() ? "/engine/stream/status" : null,
    (url: string) => api.get(url),
    { refreshInterval: LIVE_REFRESH_MS, ...options }
  );
};

/** GET /engine/stream/metrics - per-minute volume, score histogram, dedup. */
export const useStreamMetrics = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<StreamMetrics>(
    api.isReady() ? "/engine/stream/metrics" : null,
    (url: string) => api.get(url),
    { refreshInterval: LIVE_REFRESH_MS, ...options }
  );
};

/** GET /engine/stream/signals - recent canonical (redacted) signals.
 * `anomalousOnly` keeps only the signals the detector flagged. */
export const useStreamSignals = (
  source: string | null = null,
  limit = 200,
  options: SWRConfiguration = {},
  anomalousOnly = false
) => {
  const api = useApi();
  const qs = new URLSearchParams({
    limit: String(limit),
    ...(source ? { source } : {}),
    ...(anomalousOnly ? { anomalous: "true" } : {}),
  });
  return useSWR<{ total: number; signals: CanonicalSignal[] }>(
    api.isReady() ? `/engine/stream/signals?${qs}` : null,
    (url: string) => api.get(url),
    { refreshInterval: LIVE_REFRESH_MS, ...options }
  );
};

/** GET /engine/stream/rejections - candidate groups that failed validation. */
export const useValidationRejections = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<ValidationRejection[]>(
    api.isReady() ? "/engine/stream/rejections" : null,
    (url: string) => api.get(url),
    { refreshInterval: LIVE_REFRESH_MS, ...options }
  );
};

/** GET /engine/graph - the reference dependency graph with criticality. */
export const useServiceGraph = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<ServiceGraph>(
    api.isReady() ? "/engine/graph" : null,
    (url: string) => api.get(url),
    { refreshInterval: 5000, ...options }
  );
};

/** GET /engine/queue — every draft, any status. Filtered client-side so the
 * page can show pending/published/rejected/merged as tabs without refetching. */
export const useEngineQueue = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<QueueSummary[]>(
    api.isReady() ? QUEUE_KEY : null,
    (url: string) => api.get(url),
    { refreshInterval: LIVE_REFRESH_MS, ...options }
  );
};

/** GET /engine/health — polled so the Settings panel reflects the live queue. */
export const useEngineHealth = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<EngineHealth>(
    api.isReady() ? "/engine/health" : null,
    (url: string) => api.get(url),
    { refreshInterval: 10_000, ...options }
  );
};

/** GET /engine/benchmark — deterministic, so fetched once and never revalidated. */
export const useEngineBenchmark = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<EngineBenchmark>(
    api.isReady() ? "/engine/benchmark" : null,
    (url: string) => api.get(url),
    { revalidateOnFocus: false, revalidateIfStale: false, ...options }
  );
};

/** GET /engine/benchmark/ablation — deterministic, fetched once. */
export const useEngineAblation = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<AblationRow[]>(
    api.isReady() ? "/engine/benchmark/ablation" : null,
    (url: string) => api.get(url),
    { revalidateOnFocus: false, revalidateIfStale: false, ...options }
  );
};

/** GET /engine/benchmark/reliability — deterministic, fetched once. */
export const useEngineReliability = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<ReliabilityBucket[]>(
    api.isReady() ? "/engine/benchmark/reliability" : null,
    (url: string) => api.get(url),
    { revalidateOnFocus: false, revalidateIfStale: false, ...options }
  );
};

export const useEngineAudit = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<AuditEntry[]>(
    api.isReady() ? AUDIT_KEY : null,
    (url: string) => api.get(url),
    { refreshInterval: 0, ...options }
  );
};

export const useEngineTopologies = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<Topology[]>(
    api.isReady() ? TOPOLOGIES_KEY : null,
    (url: string) => api.get(url),
    options
  );
};

/** GET /engine/queue/{id} — the full ticket, fetched on demand when a row
 * is expanded rather than bundled into the list response. */
export const useEngineDraft = (draftId: string | null, options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<DraftDetail>(
    api.isReady() && draftId ? `${QUEUE_KEY}/${draftId}` : null,
    (url: string) => api.get(url),
    options
  );
};

/** GET /engine/queue/{id}/evidence — why this incident: join evidence,
 * exclusions, root-cause candidates, severity + confidence breakdowns. */
export const useEngineEvidence = (draftId: string | null, options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<Evidence>(
    api.isReady() && draftId ? `${QUEUE_KEY}/${draftId}/evidence` : null,
    (url: string) => api.get(url),
    options
  );
};

/** GET /engine/feedback — what reviewer decisions taught the correlator. */
export const useEngineFeedback = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWR<FeedbackState>(
    api.isReady() ? "/engine/feedback" : null,
    (url: string) => api.get(url),
    options
  );
};

/** Mutations. Every write here maps to exactly one backend route in
 * engine_api.py, which is itself a thin wrapper over app/engine/review.py
 * — the actual approval-token gate lives there, not in this hook. */
export const useEngineActions = () => {
  const api = useApi();
  const { mutate } = useSWRConfig();

  const refreshAll = useCallback(
    // Every /engine/* cache entry: queue, report, audit, and each draft's
    // detail + evidence, so an open investigation page reflects the decision.
    () => mutate((key) => typeof key === "string" && key.startsWith("/engine/")),
    [mutate]
  );

  const runDemo = useCallback(
    async (body: DemoRunRequest) => {
      const result = await api.post<{ report: PipelineReport; queue: QueueSummary[] }>(
        "/engine/demo/run",
        body
      );
      await refreshAll();
      return result;
    },
    [api, refreshAll]
  );

  const approve = useCallback(
    async (draftId: string, who: Reviewer, edits?: Record<string, unknown>) => {
      const result = await api.post<DraftDetail>(`${QUEUE_KEY}/${draftId}/approve`, {
        ...signer(who),
        edits,
      });
      await refreshAll();
      return result;
    },
    [api, refreshAll]
  );

  const reject = useCallback(
    async (draftId: string, who: Reviewer, note = "") => {
      const result = await api.post<DraftDetail>(`${QUEUE_KEY}/${draftId}/reject`, {
        ...signer(who),
        note,
      });
      await refreshAll();
      return result;
    },
    [api, refreshAll]
  );

  const merge = useCallback(
    async (draftId: string, into: string, who: Reviewer, note = "") => {
      const result = await api.post<DraftDetail>(`${QUEUE_KEY}/${draftId}/merge`, {
        ...signer(who),
        into,
        note,
      });
      await refreshAll();
      return result;
    },
    [api, refreshAll]
  );

  /** POST /engine/golden — the fixed demo failure, run through the real engine.
   * Nothing reaches Jira: the draft lands in the review queue. */
  const injectGolden = useCallback(async (scenario: string = "golden") => {
    const result = await api.post<{ report: PipelineReport; queue: QueueSummary[] }>(`/engine/scenario/${scenario}`, {});
    await refreshAll();
    return result;
  }, [api, refreshAll]);

  /** Demo hook: a signal arrives after the incident exists. */
  const lateSignal = useCallback(
    async (draftId: string, kind: "matching" | "unrelated") => {
      const result = await api.post<LateSignalResult>(`${QUEUE_KEY}/${draftId}/late-signal`, { kind });
      await refreshAll();
      return result;
    },
    [api, refreshAll]
  );

  const resolve = useCallback(
    async (draftId: string, who: Reviewer) => {
      const result = await api.post<DraftDetail>(`${QUEUE_KEY}/${draftId}/resolve`, signer(who));
      await refreshAll();
      return result;
    },
    [api, refreshAll]
  );

  const resetFeedback = useCallback(async () => {
    await api.post("/engine/feedback/reset", {});
    await refreshAll();
  }, [api, refreshAll]);

  return { runDemo, injectGolden, approve, reject, merge, lateSignal, resolve, resetFeedback, refreshAll };
};
