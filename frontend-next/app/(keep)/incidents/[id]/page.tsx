import { IncidentDetailClient } from "./IncidentDetailClient";

export const metadata = {
  title: "Incident | Nexus AIOps",
};

export default async function IncidentDetailPage(props: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await props.params;
  return <IncidentDetailClient incidentId={id} />;
}
