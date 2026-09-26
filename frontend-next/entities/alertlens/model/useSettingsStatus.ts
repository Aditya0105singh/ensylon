import useSWR, { SWRConfiguration } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { SettingsStatus } from "./types";

export const SETTINGS_STATUS_KEY = "/settings/status";

/** GET /settings/status — real system facts (dataset loaded, persisted alert
 * count, LLM provider reachability), not a settings form. */
export const useSettingsStatus = (options: SWRConfiguration = {}) => {
  const api = useApi();

  return useSWR<SettingsStatus>(
    api.isReady() ? SETTINGS_STATUS_KEY : null,
    (url: string) => api.get(url),
    options
  );
};
