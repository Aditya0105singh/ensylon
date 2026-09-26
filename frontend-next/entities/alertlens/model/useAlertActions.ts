import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import { PIPELINE_KEY } from "./usePipeline";
import { patchAlertInState } from "../lib/patchAlert";
import type { Alert, PipelineRunSummary, PipelineState } from "./types";

/**
 * Per-alert actions. These persist to the backend's actions table and then
 * replay the current batch through the pipeline, so they can change cluster
 * membership and risk — not just a badge.
 *
 * Each action therefore does two things: patch the affected alert locally so
 * the UI responds immediately, then revalidate the whole pipeline so the
 * engine's authoritative result wins. If the request fails the optimistic
 * patch is rolled back.
 */
export const useAlertActions = () => {
  const api = useApi();
  const { mutate } = useSWRConfig();

  const runAction = useCallback(
    async (
      alertId: string,
      path: string,
      body: Record<string, unknown>,
      patch: Partial<Alert>
    ) => {
      const request = api.post<PipelineRunSummary>(
        `/alerts/${encodeURIComponent(alertId)}/${path}`,
        body
      );

      await mutate(
        PIPELINE_KEY,
        async () => {
          await request;
          // Returning undefined makes SWR refetch, so the replayed batch —
          // not the local guess — is what finally renders.
          return undefined;
        },
        {
          optimisticData: (current?: PipelineState) =>
            patchAlertInState(current, alertId, patch) as PipelineState,
          rollbackOnError: true,
          revalidate: true,
          populateCache: false,
        }
      );

      return request;
    },
    [api, mutate]
  );

  /** POST /alerts/{id}/ack */
  const ackAlert = useCallback(
    (alertId: string, value: boolean) =>
      runAction(alertId, "ack", { value }, { acked: value }),
    [runAction]
  );

  /** POST /alerts/{id}/assign — pass null to unassign. */
  const assignAlert = useCallback(
    (alertId: string, assignee: string | null) =>
      runAction(
        alertId,
        "assign",
        { assignee },
        { assignee: assignee ?? "n/a" }
      ),
    [runAction]
  );

  /**
   * POST /alerts/{id}/dismiss — status override.
   * "suppressed" | "resolved" | null (null clears the override).
   */
  const dismissAlert = useCallback(
    (alertId: string, status: "suppressed" | "resolved" | null) =>
      runAction(
        alertId,
        "dismiss",
        { status },
        status ? { status } : {}
      ),
    [runAction]
  );

  /** POST /alerts/{id}/escalate */
  const escalateAlert = useCallback(
    (alertId: string, value: boolean) =>
      runAction(alertId, "escalate", { value }, { escalated: value }),
    [runAction]
  );

  return { ackAlert, assignAlert, dismissAlert, escalateAlert };
};
