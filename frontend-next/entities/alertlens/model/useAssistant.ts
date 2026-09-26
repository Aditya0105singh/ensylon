import { useCallback, useState } from "react";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { AssistantRequest, AssistantResponse } from "./types";

/**
 * AI assistant. Imperative rather than SWR — these are chat turns, not
 * cacheable resources.
 *
 * The backend can answer 200 with an `error` field instead of an HTTP error,
 * so both paths are normalised into a thrown Error here.
 */
export const useAssistant = () => {
  const api = useApi();
  const [isAsking, setIsAsking] = useState(false);

  const ask = useCallback(
    async (endpoint: string, payload: AssistantRequest) => {
      setIsAsking(true);
      try {
        const data = await api.post<AssistantResponse>(endpoint, payload);
        if (data?.error) {
          throw new Error(String(data.error));
        }
        return data;
      } finally {
        setIsAsking(false);
      }
    },
    [api]
  );

  /** POST /assistant — incident-scoped question. */
  const askIncidentAssistant = useCallback(
    (payload: AssistantRequest) => ask("/assistant", payload),
    [ask]
  );

  /**
   * POST /assistant/workspace — workspace-aware question. When incident_id is
   * supplied the backend delegates to incident mode; otherwise it builds a
   * live pipeline snapshot as context.
   */
  const askWorkspaceAssistant = useCallback(
    (payload: AssistantRequest) => ask("/assistant/workspace", payload),
    [ask]
  );

  return { askIncidentAssistant, askWorkspaceAssistant, isAsking };
};
