import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { AblationRow, ReliabilityBucket } from "@/entities/engine/types";
import { CorrelationsClient } from "../CorrelationsClient";
import { ablationFindings } from "../ProofPanels";
import { CHECKS, GATES, gateColor } from "../rules";
import fixture from "../../_overview/__tests__/live-fixture.json";

const fx = fixture as unknown as Record<string, unknown>;

// Measured on the held-out seeds (backend/app/engine/benchmark.py ablation()).
const ABLATION: AblationRow[] = [
  { variant: "baseline (all five dimensions)", pair_f1: 0.686, delta: 0 },
  { variant: "without temporal proximity (T)", pair_f1: 0.303, delta: -0.383 },
  { variant: "without service affinity (S)", pair_f1: 0.735, delta: 0.049 },
  { variant: "without dependency closeness (D)", pair_f1: 0.595, delta: -0.091 },
  { variant: "without evidence similarity (E)", pair_f1: 0.675, delta: -0.011 },
  { variant: "without component match (C)", pair_f1: 0.686, delta: 0 },
  { variant: "time proximity only, structural gate removed", pair_f1: 0.532, delta: null, note: "time alone" },
];
const RELIABILITY: ReliabilityBucket[] = [
  { bucket: "0.5-0.6", predicted: 0.553, actual: 0.639, n: 6 },
  { bucket: "0.7-0.8", predicted: 0.754, actual: 0.816, n: 126 },
  { bucket: "0.9-1.0", predicted: 0.959, actual: 0.952, n: 14 },
];

class HttpError extends Error { constructor(public statusCode: number) { super(`HTTP ${statusCode}`); } }

function mockApi(routes: Record<string, unknown>) {
  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(),
    get: jest.fn((url: string) => {
      if (!(url in routes)) return Promise.reject(new Error(`unmocked GET ${url}`));
      const v = routes[url];
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
    }),
    post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(), isReady: () => true,
  });
}

const renderPage = () =>
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0, shouldRetryOnError: false }}><CorrelationsClient /></SWRConfig>);

const routes = () => ({
  ...fx,
  "/engine/benchmark/ablation": ABLATION,
  "/engine/benchmark/reliability": RELIABILITY,
});

describe("correlation spec", () => {
  it("lists the five validation checks the engine runs", () => {
    expect(CHECKS.map((c) => c.name)).toEqual([
      "Environment consistency", "Weak bridge", "Coherence", "Anomaly support", "Independent evidence",
    ]);
  });

  it("allows only a direct dependency edge through the gate, as correlate.py does", () => {
    const edge = GATES.find((g) => g.name === "direct dependency edge")!;
    expect(edge.rule).toMatch(/one hop, not two/);
    expect(gateColor("same component, 2 hop(s) apart")).toBe(GATES.find((g) => g.name === "same component")!.color);
  });

  it("reads the ablation findings off the numbers", () => {
    const f = ablationFindings(ABLATION);
    expect(f.gateGain).toBeCloseTo(0.154, 3);
    expect(f.mostNeeded).toEqual({ code: "T", delta: -0.383 });
    expect(f.hurting).toEqual([{ code: "S", delta: 0.049 }]);
    expect(f.idle).toEqual(["C"]);
  });
});

describe("CorrelationsClient", () => {
  beforeAll(() => { window.scrollTo = jest.fn() as unknown as typeof window.scrollTo; });

  it("shows that time alone can never link two signals", async () => {
    mockApi(routes());
    renderPage();
    const formula = await screen.findByRole("region", { name: "Similarity formula" });
    const verdict = within(formula).getByRole("status", { name: "Verdict" });
    expect(verdict).toHaveTextContent("sim 0.37");
    expect(verdict).toHaveTextContent("fails the gate");
    expect(verdict).toHaveTextContent("Time alone cannot link two signals");

    fireEvent.click(within(formula).getByRole("button", { name: "Caller and callee, 10 s apart" }));
    expect(verdict).toHaveTextContent("sim 0.57");
    expect(verdict).toHaveTextContent("over the line: same incident");

    fireEvent.click(within(formula).getByRole("button", { name: "Neighbours, 12 min apart" }));
    expect(verdict).toHaveTextContent("under the line: kept apart");
  });

  it("draws a real incident's joins and its five validation checks", async () => {
    mockApi(routes());
    renderPage();
    const explorer = await screen.findByRole("region", { name: "Live incident explorer" });
    expect(await within(explorer).findByRole("img", { name: /5 signals on 3 services, with \d+ joins/ })).toBeInTheDocument();
    expect(within(explorer).getByText(/What held this incident together/)).toBeInTheDocument();
    expect(within(explorer).getByText(/Validation: \d\/\d passed/)).toBeInTheDocument();
  });

  it("states the ablation and calibration findings", async () => {
    mockApi(routes());
    renderPage();
    const ablation = await screen.findByRole("region", { name: "Ablation: does every part earn its place?" });
    expect(await within(ablation).findByText(/add \+0\.154 F1/)).toBeInTheDocument();
    expect(within(ablation).getByText(/raises/).closest("li")).toHaveTextContent("Switching off S raises F1 by 0.049");

    const calibration = screen.getByRole("region", { name: "Calibration: can you trust the confidence score?" });
    expect(await within(calibration).findByText("Conservative.")).toBeInTheDocument();
  });

  it("says the benchmark is computing, not failing, while the backend answers 503", async () => {
    mockApi({ ...routes(), "/engine/benchmark/ablation": new HttpError(503), "/engine/benchmark/reliability": new HttpError(503) });
    renderPage();
    const ablation = await screen.findByRole("region", { name: "Ablation: does every part earn its place?" });
    expect(await within(ablation).findByText(/runs once per variant in the background/)).toBeInTheDocument();
    expect(within(ablation).queryByText(/Could not run/)).not.toBeInTheDocument();
  });

  it("shows the rules with all five validation checks", async () => {
    mockApi(routes());
    renderPage();
    const rules = await screen.findByRole("region", { name: "The rules" });
    fireEvent.click(within(rules).getByRole("button", { name: /Validation \(C4\): a candidate must pass all 5/ }));
    expect(await within(rules).findByText("Independent evidence")).toBeInTheDocument();
  });
});
