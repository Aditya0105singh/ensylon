import { useCallback } from "react";
import useSWR, { useSWRConfig, SWRConfiguration } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { MaintenanceWindow } from "./types";

export const MAINTENANCE_KEY = "/maintenance";

/** GET /maintenance — real time-windowed suppression rules. Polled: unlike
 * most entities here, "active" can flip from true to false just by the
 * clock ticking past end_time, with no user action involved. */
export const useMaintenanceWindows = (options: SWRConfiguration = {}) => {
  const api = useApi();

  return useSWR<MaintenanceWindow[]>(
    api.isReady() ? MAINTENANCE_KEY : null,
    (url: string) => api.get(url),
    { refreshInterval: 30_000, ...options }
  );
};

export const useMaintenanceWindowActions = () => {
  const api = useApi();
  const { mutate } = useSWRConfig();

  const refresh = useCallback(() => mutate(MAINTENANCE_KEY), [mutate]);

  const createWindow = useCallback(
    async (
      name: string,
      service: string | null,
      startTime: string,
      endTime: string
    ) => {
      const result = await api.post<MaintenanceWindow>(MAINTENANCE_KEY, {
        name,
        service,
        start_time: startTime,
        end_time: endTime,
      });
      await refresh();
      return result;
    },
    [api, refresh]
  );

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      const result = await api.put<MaintenanceWindow>(`${MAINTENANCE_KEY}/${id}`, {
        enabled,
      });
      await refresh();
      return result;
    },
    [api, refresh]
  );

  const deleteWindow = useCallback(
    async (id: string) => {
      await api.delete(`${MAINTENANCE_KEY}/${id}`);
      await refresh();
    },
    [api, refresh]
  );

  return { createWindow, setEnabled, deleteWindow };
};
