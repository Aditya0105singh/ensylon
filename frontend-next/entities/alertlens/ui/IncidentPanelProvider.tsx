"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { useClusters } from "../model/usePipeline";
import { IncidentSidePanel } from "./IncidentSidePanel";

type IncidentPanelApi = {
  /** Open the incident side panel for this cluster id, from anywhere. */
  openIncident: (clusterId: number) => void;
  closeIncident: () => void;
  openIncidentId: number | null;
};

const IncidentPanelContext = createContext<IncidentPanelApi>({
  openIncident: () => {},
  closeIncident: () => {},
  openIncidentId: null,
});

export const useIncidentPanel = () => useContext(IncidentPanelContext);

/**
 * Mounts the single incident side panel once, app-wide, so every entry point
 * (Home, Incidents, Correlations, Topology, the alert drawer) opens the same
 * view instead of each page growing its own copy.
 */
export function IncidentPanelProvider({ children }: { children: React.ReactNode }) {
  const [openIncidentId, setOpenIncidentId] = useState<number | null>(null);
  const { clusters } = useClusters();

  const closeIncident = useCallback(() => setOpenIncidentId(null), []);
  const openIncident = useCallback((clusterId: number) => setOpenIncidentId(clusterId), []);

  const cluster = useMemo(
    () => clusters.find((c) => c.cluster_id === openIncidentId) ?? null,
    [clusters, openIncidentId]
  );

  const api = useMemo(
    () => ({ openIncident, closeIncident, openIncidentId }),
    [openIncident, closeIncident, openIncidentId]
  );

  return (
    <IncidentPanelContext.Provider value={api}>
      {children}
      <IncidentSidePanel cluster={cluster} onClose={closeIncident} />
    </IncidentPanelContext.Provider>
  );
}
