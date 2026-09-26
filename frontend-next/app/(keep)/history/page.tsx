import { HistoryClient } from "./HistoryClient";

export const metadata = {
  title: "Incident History | Nexus AIOps",
  description: "Every incident, how it was scored, and who signed off",
};

export default function Page() {
  return <HistoryClient />;
}
