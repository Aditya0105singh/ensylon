import { ArchivedIncidentClient } from "./ArchivedIncidentClient";

export const metadata = {
  title: "Incident Record | Nexus AIOps",
  description: "One incident's record and its sign-off trail",
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ArchivedIncidentClient draftId={id} />;
}
