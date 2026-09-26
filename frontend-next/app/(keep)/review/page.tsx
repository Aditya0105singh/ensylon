import ReviewPage from "./page.client";

export default function Page() {
  return <ReviewPage />;
}

export const metadata = {
  title: "Review Queue | AlertLens",
  description:
    "Ingest -> Detect -> Correlate -> Causal Engine -> Score -> Draft -> Human Review Gate, running for real.",
};
