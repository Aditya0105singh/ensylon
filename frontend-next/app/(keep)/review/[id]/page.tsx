import InvestigationClient from "./InvestigationClient";

export default async function Page(props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  return <InvestigationClient draftId={decodeURIComponent(id)} />;
}

export const metadata = {
  title: "Incident investigation | AlertLens",
};
