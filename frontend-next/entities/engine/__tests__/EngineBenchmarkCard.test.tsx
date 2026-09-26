import React from "react";
import { render, screen } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import { EngineBenchmarkCard } from "../EngineBenchmarkCard";
import type { BenchmarkRow, EngineBenchmark } from "../types";

const row = (o: Partial<BenchmarkRow>): BenchmarkRow => ({
  key: "staggered_3", label: "3 incidents, staggered", concurrent: false, runs: 20, avg_signals: 83,
  pair_precision: 0.87, pair_recall: 0.79, pair_f1: 0.81, worst_pair_f1: 0.5, cluster_purity: 0.96,
  noise_precision: 0.95, root_cause_correct: 55, root_cause_total: 55, root_cause_accuracy: 1,
  exact_incident_count_runs: 4, median_runtime_ms: 12, ...o,
});

const bench: EngineBenchmark = {
  seeds: Array.from({ length: 20 }, (_, i) => i + 21),
  held_out: true,
  configs: [
    row({}),
    row({ key: "concurrent_3", label: "3 incidents, concurrent", concurrent: true, pair_precision: 0.48, pair_f1: 0.59 }),
  ],
  overall: { runs: 40, pair_f1: 0.7, pair_precision: 0.68, pair_recall: 0.82, root_cause_accuracy: 0.97 },
};

function renderCard(get: () => Promise<unknown>) {
  (useApi as jest.Mock).mockReturnValue({ get: jest.fn(get), post: jest.fn(), isReady: () => true });
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <EngineBenchmarkCard />
    </SWRConfig>
  );
}

describe("EngineBenchmarkCard", () => {
  it("says the seeds are held out and shows the headline numbers", async () => {
    renderCard(() => Promise.resolve(bench));
    expect(await screen.findByText(/Seeds 21–40 are held out/)).toBeInTheDocument();
    expect(screen.getByText("97%")).toBeInTheDocument();
    expect(screen.getByText("0.70")).toBeInTheDocument();
  });

  it("flags concurrent incidents as the hard case and states the known limitation", async () => {
    renderCard(() => Promise.resolve(bench));
    expect(await screen.findByText("hard case")).toBeInTheDocument();
    expect(screen.getByText(/Known limitation/)).toBeInTheDocument();
    expect(screen.getByText("0.48")).toBeInTheDocument();
  });

  it("reports a failed benchmark instead of rendering nothing", async () => {
    renderCard(() => Promise.reject(new Error("down")));
    expect(await screen.findByText(/Benchmark unavailable/)).toBeInTheDocument();
  });
});
