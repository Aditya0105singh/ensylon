import { LiveOverviewClient } from "./LiveOverviewClient";

export const metadata = {
  title: "Overview | Nexus AIOps",
  description: "Live correlation of the Nexus signal streams into reviewed incident tickets.",
};

export default function HomePage() {
  return <LiveOverviewClient />;
}
