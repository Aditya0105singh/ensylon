import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { CanonicalSignal, Evidence, QueueSummary } from "@/entities/engine/types";
import { LiveOverviewClient } from "../../LiveOverviewClient";
import {
  canonicalSource,
  classifySignal,
  cleanTitle,
  correlationBreakdown,
  offset,
  propagationPath,
  rankIncidents,
  sourceMix,
} from "../lib";
import fixture from "./live-fixture.json";

// Captured from the backend running against tools/fake_nexus.py: a cascade
// agency-db -> payments-service -> enrollment-service (P1) and an unrelated
// comms-service incident (P2).
const fx = fixture as unknown as Record<string, unknown>;
const queue = fx["/engine/queue"] as QueueSummary[];
const p1 = queue.find((q) => q.priority === "P1")!;
const p2 = queue.find((q) => q.priority === "P2")!;
const p1Evidence = fx[`/engine/queue/${p1.draft_id}/evidence`] as Evidence;

function mockApi(routes: Record<string, unknown>) {
  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(),
    get: jest.fn((url: string) =>
      url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`unmocked GET ${url}`))
    ),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    isReady: () => true,
  });
}

const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}>
      <LiveOverviewClient />
    </SWRConfig>
  );

describe("overview helpers", () => {
  it("maps engine source names onto the canonical stream names", () => {
    expect(canonicalSource("app_log")).toBe("application_logs");
    expect(canonicalSource("cloudwatch_log")).toBe("application_logs");
    expect(canonicalSource("cloudwatch_metric")).toBe("cloudwatch_metrics");
    expect(canonicalSource("grafana_alert")).toBe("grafana_alerts");
  });

  it("strips the draft marker from titles", () => {
    expect(cleanTitle("[DRAFT] agency-db: x")).toBe("agency-db: x");
  });

  it("puts incidents awaiting review first, then by priority", () => {
    const ranked = rankIncidents([{ ...p1, status: "published" }, p2]);
    expect(ranked.map((q) => q.draft_id)).toEqual([p2.draft_id, p1.draft_id]);
  });

  it("breaks the mean join similarity into weighted dimension contributions", () => {
    const { dims, total, joins } = correlationBreakdown(p1Evidence);
    expect(joins).toBeGreaterThan(0);
    expect(dims.map((d) => d.code)).toEqual(["T", "S", "D", "E", "C"]);
    const weights = dims.reduce((a, d) => a + d.weight, 0);
    expect(weights).toBeCloseTo(1, 5);
    const meanTotal =
      p1Evidence.signals.filter((s) => s.join.joined).reduce((a, s) => a + (s.join.components?.total ?? 0), 0) / joins;
    expect(total).toBeCloseTo(meanTotal, 1);
  });

  it("orders the propagation path from the probable origin along symptom links", () => {
    const path = propagationPath(p1Evidence);
    expect(path.map((p) => p.service)).toEqual(["agency-db", "payments-service", "enrollment-service"]);
    expect(path[0]).toMatchObject({ isRoot: true, from: null });
    expect(path[1].from).toBe("agency-db");
    expect(path[2].from).toBe("payments-service");
  });

  it("counts raw signals per stream, including collapsed repeats", () => {
    const mix = sourceMix(p1Evidence.signals);
    const total = Object.values(mix).reduce((a, v) => a + v, 0);
    expect(total).toBe(p1Evidence.raw_signals);
  });

  it("classifies signals as in-incident, anomaly or baseline", () => {
    const base: CanonicalSignal = {
      signal_id: "s", timestamp: p1.started_at, source: "application_logs", environment: "prod", region: "ap-south-1",
      service: "payments-service", component: null, signal_type: "error_log_burst", anomaly_score: 0.8, evidence: "", metadata: {},
    };
    expect(classifySignal(base, queue).kind).toBe("correlated");
    expect(classifySignal({ ...base, service: "batch-report" }, queue).kind).toBe("anomaly");
    expect(classifySignal({ ...base, anomaly_score: 0.1 }, queue).kind).toBe("normal");
  });

  it("formats offsets between timestamps", () => {
    expect(offset("2026-09-26T10:00:00Z", "2026-09-26T10:00:07Z")).toBe("+7s");
    expect(offset("2026-09-26T10:00:00Z", "2026-09-26T10:02:05Z")).toBe("+2m 05s");
  });
});

describe("LiveOverviewClient", () => {
  beforeEach(() => mockApi(fx));

  it("tells the raw signals → anomalies → incidents story and asks for review", async () => {
    renderPage();
    expect(await screen.findByText("Nexus AIOps Intelligence Engine")).toBeInTheDocument();
    expect(screen.getByText(/3\/3 streams connected/)).toBeInTheDocument();
    expect(screen.getByText("Human review required")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Review P1 now/ })).toHaveAttribute("href", `/review/${p1.draft_id}`);
    // Claude is off in the fixture: shown as a template fallback, not as broken.
    expect(screen.getByText("AI drafting (template fallback)")).toBeInTheDocument();
    expect(screen.queryByText(/Claude: off/)).not.toBeInTheDocument();
  });

  it("puts the P1 incident in focus with its origin, propagation and correlation evidence", async () => {
    renderPage();
    const story = await screen.findByRole("region", { name: "Incident in focus" });
    expect(within(story).getByText("agency-db: DBConnectionCount cascading to 2 service(s)")).toBeInTheDocument();
    expect(await within(story).findByText("Why these signals belong together")).toBeInTheDocument();
    expect(within(story).getByText(/Probable origin · 93% causal confidence/)).toBeInTheDocument();
    expect(within(story).getByText("symptom of agency-db")).toBeInTheDocument();
    expect(within(story).getByText("Temporal proximity")).toBeInTheDocument();
    expect(within(story).getByText(/4\/4 checks passed/)).toBeInTheDocument();
    expect(within(story).getByRole("link", { name: /Review incident/ })).toHaveAttribute("href", `/review/${p1.draft_id}`);
    expect(await within(story).findByText("Deterministic template draft (Claude drafting off)")).toBeInTheDocument();
  });

  it("switches focus when another incident is selected", async () => {
    renderPage();
    const other = await screen.findByRole("button", { name: /comms-service: smtp_error_rate[\s\S]*impact/ });
    fireEvent.click(other);
    const story = screen.getByRole("region", { name: "Incident in focus" });
    await waitFor(() => expect(within(story).getByText("comms-service: smtp_error_rate")).toBeInTheDocument());
  });

  it("explains a feed signal when it is clicked", async () => {
    renderPage();
    const feed = (await screen.findByText("Live intelligence feed")).closest("section")!;
    const first = within(feed).getAllByRole("button", { expanded: false })[0];
    fireEvent.click(first);
    expect(within(feed).getByText("Why this signal matters")).toBeInTheDocument();
  });
});
