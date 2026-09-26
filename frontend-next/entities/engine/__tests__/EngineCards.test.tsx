import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import { EngineEvaluationCard, EngineIncidentsCard, EnginePipelineSection } from "../EngineCards";
import { evaluation, pipelineReport, queueSummary } from "../__fixtures__/engine";

// A fresh, isolated SWR cache per render — the default global cache would
// otherwise leak a previous test's response across tests that share a key
// (e.g. every test here hits "/engine/queue"), since SWR dedupes identical
// keys within dedupingInterval regardless of which test triggered the fetch.
function withFreshSWR(children: React.ReactNode) {
  return <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>;
}

function mockApi(routes: Record<string, unknown>, post?: jest.Mock) {
  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(),
    get: jest.fn((url: string) => {
      if (url in routes) return Promise.resolve(routes[url]);
      return Promise.reject(new Error(`unmocked GET ${url}`));
    }),
    post: post ?? jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    isReady: () => true,
  });
}

describe("EngineIncidentsCard", () => {
  it("renders nothing while the queue is empty (no run has happened yet)", async () => {
    mockApi({ "/engine/queue": [] });
    const { container } = render(withFreshSWR(<EngineIncidentsCard />));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("lists each queue entry with its priority, status and a link to the investigation page", async () => {
    mockApi({
      "/engine/queue": [
        queueSummary({ draft_id: "d1", title: "postgres pool exhaustion", priority: "P1", status: "awaiting_review" }),
        queueSummary({ draft_id: "d2", title: "cache eviction storm", priority: "P3", status: "published", jira_key: "AIOPS-1" }),
      ],
    });
    render(withFreshSWR(<EngineIncidentsCard />));

    expect(await screen.findByText("postgres pool exhaustion")).toBeInTheDocument();
    expect(screen.getByText("cache eviction storm")).toBeInTheDocument();
    expect(screen.getByText("P1")).toBeInTheDocument();
    expect(screen.getByText("P3")).toBeInTheDocument();
    // Published shows its real Jira key rather than a generic status label.
    expect(screen.getByText("AIOPS-1")).toBeInTheDocument();
    expect(screen.getByText("Awaiting human review")).toBeInTheDocument();

    const link = screen.getByRole("link", { name: /postgres pool exhaustion/i });
    expect(link).toHaveAttribute("href", "/review/d1");
  });

  it("shows the default note, or the caller's override when given one", async () => {
    mockApi({ "/engine/queue": [queueSummary()] });
    const { rerender } = render(withFreshSWR(<EngineIncidentsCard />));
    expect(await screen.findByText(/From the latest injected run/i)).toBeInTheDocument();

    rerender(withFreshSWR(<EngineIncidentsCard note="Custom note for this page" />));
    expect(await screen.findByText("Custom note for this page")).toBeInTheDocument();
  });
});

describe("EngineEvaluationCard", () => {
  it("prompts to run the engine when there is no report yet", async () => {
    mockApi({ "/engine/report": {} });
    render(withFreshSWR(<EngineEvaluationCard />));
    expect(await screen.findByText(/No engine run yet/i)).toBeInTheDocument();
  });

  it("shows every metric as passing when the run matched ground truth exactly", async () => {
    mockApi({ "/engine/report": pipelineReport({ evaluation: evaluation() }) });
    render(withFreshSWR(<EngineEvaluationCard />));

    expect(await screen.findByText("1 of 1 expected")).toBeInTheDocument();
    expect(screen.getAllByText("100%").length).toBeGreaterThan(0);
    expect(screen.getByText("1 of 1")).toBeInTheDocument(); // root cause correct
    expect(screen.getByText(pipelineReport().scenario, { exact: false })).toBeInTheDocument();
  });

  it("flags a metric that misses ground truth instead of hiding it", async () => {
    mockApi({
      "/engine/report": pipelineReport({
        evaluation: evaluation({ incidents_formed: 2, incidents_expected: 1, pair_precision: 0.5 }),
      }),
    });
    render(withFreshSWR(<EngineEvaluationCard />));
    expect(await screen.findByText("2 of 1 expected")).toBeInTheDocument();
  });

  it("says a single run is a sanity check and shows the pair counts behind the ratios", async () => {
    mockApi({
      "/engine/report": pipelineReport({
        evaluation: evaluation({ true_pairs: 15, predicted_pairs: 15, correct_pairs: 15 }),
      }),
    });
    render(withFreshSWR(<EngineEvaluationCard />));
    expect(await screen.findByText(/One run is a sanity check/i)).toBeInTheDocument();
    expect(screen.getByText(/15 of 15 true pairs/)).toBeInTheDocument();
  });

  it("replaying the golden incident posts to the scenario endpoint", async () => {
    const post = jest.fn().mockResolvedValue({ report: pipelineReport(), queue: [] });
    mockApi({ "/engine/report": pipelineReport({ evaluation: evaluation() }) }, post);
    render(withFreshSWR(<EngineEvaluationCard />));

    fireEvent.click(await screen.findByRole("button", { name: /replay golden incident/i }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/engine/scenario/golden", {}));
  });
});

describe("EnginePipelineSection", () => {
  it("prompts to inject a failure when nothing has run yet", async () => {
    mockApi({ "/engine/report": {}, "/engine/queue": [] });
    render(withFreshSWR(<EnginePipelineSection />));
    expect(await screen.findByText(/No run yet/i)).toBeInTheDocument();
  });

  it("reports the review gate as healthy and Jira as a mock, and flags a missing LLM as degraded", async () => {
    mockApi({
      "/engine/report": pipelineReport(),
      "/engine/queue": [queueSummary({ summary_source: "template" })],
    });
    render(withFreshSWR(<EnginePipelineSection />));

    expect(await screen.findByText("Human review gate")).toBeInTheDocument();
    expect(screen.getByText(/0 auto-published, always/)).toBeInTheDocument();
    expect(screen.getByText(/not configured: drafts use the deterministic template/)).toBeInTheDocument();
    expect(screen.getByText(/mock transport/)).toBeInTheDocument();
  });

  it("shows a grounded-summary note instead of the degraded one once an LLM produced a real draft", async () => {
    mockApi({
      "/engine/report": pipelineReport(),
      "/engine/queue": [queueSummary({ summary_source: "llm" })],
    });
    render(withFreshSWR(<EnginePipelineSection />));
    expect(await screen.findByText(/grounded summaries active/)).toBeInTheDocument();
  });

  it("surfaces a calibration warning from the report when present", async () => {
    mockApi({
      "/engine/report": pipelineReport({ calibration_warning: "calibration warning: 60% of incidents scored P1 (ceiling 40%)" }),
      "/engine/queue": [],
    });
    render(withFreshSWR(<EnginePipelineSection />));
    expect(await screen.findByText("P1 calibration")).toBeInTheDocument();
  });
});
