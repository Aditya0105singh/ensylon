import { NexusTopologyClient } from "./NexusTopologyClient";

export const metadata = {
  title: "Service Topology | Nexus AIOps",
  description: "The reference service dependency graph with criticality and open incidents",
};

export default function Page() {
  return <NexusTopologyClient />;
}
