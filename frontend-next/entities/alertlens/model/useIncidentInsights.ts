import useSWR, { SWRConfiguration } from "swr";
import useSWRImmutable from "swr/immutable";
import { useApi } from "@/shared/lib/hooks/useApi";
import type {
  CorrelationExplanation,
  IncidentTicket,
  Evaluation,
  Forecast,
  IncidentComparison,
  Playbook,
  RootCauseConfidence,
  SummarizerCheck,
} from "./types";

type IncidentId = string | number | null | undefined;

/**
 * These endpoints 404 for an unknown incident, so each hook stays null-keyed
 * (and therefore never fires) until it has an id.
 */
const incidentKey = (id: IncidentId, suffix: string, ready: boolean) =>
  ready && id !== null && id !== undefined
    ? `/incidents/${encodeURIComponent(String(id))}/${suffix}`
    : null;

/** GET /forecast/{incident_id} — predictive blast radius. */
export const useForecast = (
  incidentId: IncidentId,
  options: SWRConfiguration = {}
) => {
  const api = useApi();
  const key =
    api.isReady() && incidentId !== null && incidentId !== undefined
      ? `/forecast/${encodeURIComponent(String(incidentId))}`
      : null;

  return useSWR<Forecast>(key, (url: string) => api.get(url), {
    revalidateOnFocus: false,
    ...options,
  });
};

/** GET /incidents/{incident_id}/comparison — historical Alert DNA comparison. */
export const useIncidentComparison = (
  incidentId: IncidentId,
  options: SWRConfiguration = {}
) => {
  const api = useApi();
  return useSWR<IncidentComparison>(
    incidentKey(incidentId, "comparison", api.isReady()),
    (url: string) => api.get(url),
    { revalidateOnFocus: false, ...options }
  );
};

/** GET /incidents/{incident_id}/root_cause_confidence — XAI candidate ranking. */
export const useRootCauseConfidence = (
  incidentId: IncidentId,
  options: SWRConfiguration = {}
) => {
  const api = useApi();
  return useSWR<RootCauseConfidence>(
    incidentKey(incidentId, "root_cause_confidence", api.isReady()),
    (url: string) => api.get(url),
    { revalidateOnFocus: false, ...options }
  );
};

/** GET /incidents/{incident_id}/correlation — why these alerts were grouped. */
export const useCorrelationExplanation = (
  incidentId: IncidentId,
  options: SWRConfiguration = {}
) => {
  const api = useApi();
  return useSWR<CorrelationExplanation>(
    incidentKey(incidentId, "correlation", api.isReady()),
    (url: string) => api.get(url),
    { revalidateOnFocus: false, ...options }
  );
};

/** GET /incidents/{incident_id}/ticket — reviewable ticket draft + state. */
export const useIncidentTicket = (
  incidentId: IncidentId,
  options: SWRConfiguration = {}
) => {
  const api = useApi();
  return useSWR<IncidentTicket>(
    incidentKey(incidentId, "ticket", api.isReady()),
    (url: string) => api.get(url),
    { revalidateOnFocus: false, ...options }
  );
};

/**
 * GET /incidents/{incident_id}/playbook — AI-generated remediation plan.
 * Immutable: this is an LLM-backed call, so don't re-fire it on focus.
 */
export const usePlaybook = (
  incidentId: IncidentId,
  options: SWRConfiguration = {}
) => {
  const api = useApi();
  return useSWRImmutable<Playbook>(
    incidentKey(incidentId, "playbook", api.isReady()),
    (url: string) => api.get(url),
    options
  );
};

/**
 * GET /evaluation — accuracy across a fixed seed set.
 * Immutable and deliberately not revalidated: the backend runs the full
 * pipeline over 8 seeds on the first call, which takes a while.
 */
export const useEvaluation = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWRImmutable<Evaluation>(
    api.isReady() ? "/evaluation" : null,
    (url: string) => api.get(url),
    options
  );
};

/** GET /debug/summarizer-check — LLM provider connectivity. */
export const useSummarizerCheck = (options: SWRConfiguration = {}) => {
  const api = useApi();
  return useSWRImmutable<SummarizerCheck>(
    api.isReady() ? "/debug/summarizer-check" : null,
    (url: string) => api.get(url),
    options
  );
};
