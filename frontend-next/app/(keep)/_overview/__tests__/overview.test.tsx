import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { CanonicalSignal, Evidence, QueueSummary } from "@/entities/engine/types";
import { LiveOverviewClient } from "../../LiveOverviewClient";
import {
  anomalyFate,
  canonicalSource,
  classifySignal,
  formatDuration,
  cleanTitle,
  correlationBreakdown,
  offset,
  propagationPath,
  quietReason,
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
// The Overview asks the backend for anomalies only.
const ANOMALIES_URL = "/engine/stream/signals?limit=12&anomalous=true";
const routes: Record<string, unknown> = { ...fx, [ANOMALIES_URL]: fx["/engine/stream/signals?limit=14"] };

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

  it("tells what became of an anomaly: incident, waiting, or expired", () => {
    const base: CanonicalSignal = {
      signal_id: "s", timestamp: "2026-09-26T10:00:00Z", source: "application_logs", environment: "prod", region: "ap-south-1",
      service: "batch-report", component: null, signal_type: "error_log_burst", anomaly_score: 0.8, evidence: "", metadata: {},
    };
    expect(anomalyFate(base, queue, "2026-09-26T10:04:00Z")).toEqual({ kind: "waiting", minutesLeft: 11 });
    expect(anomalyFate(base, queue, "2026-09-26T10:15:00Z")).toEqual({ kind: "expired" });
    const joined = anomalyFate({ ...base, timestamp: p1.started_at, service: "payments-service" }, queue, p1.started_at);
    expect(joined.kind).toBe("incident");
  });

  it("explains a quiet engine from its own counters", () => {
    expect(quietReason({ signals_received: 0, anomalous: 0, pending: 0 })).toMatch(/only keepalives/);
    expect(quietReason({ signals_received: 900, anomalous: 0, pending: 0 })).toMatch(/within its baseline/);
    const r = quietReason({ signals_received: 900, anomalous: 5, pending: 2 });
    expect(r).toMatch(/^5 anomalies found/);
    expect(r).toMatch(/Time alone never links two signals\. 2 are still waiting/);
  });

  it("formats how long the engine has been watching", () => {
    expect(formatDuration(30)).toBe("under a minute");
    expect(formatDuration(3240)).toBe("54 min");
    expect(formatDuration(7500)).toBe("2 h 05 min");
  });

  it("formats offsets between timestamps", () => {
    expect(offset("2026-09-26T10:00:00Z", "2026-09-26T10:00:07Z")).toBe("+7s");
    expect(offset("2026-09-26T10:00:00Z", "2026-09-26T10:02:05Z")).toBe("+2m 05s");
  });
});

describe("LiveOverviewClient", () => {
  beforeEach(() => mockApi(routes));

  it("leads with the decision a human owes, and one button to make it", async () => {
    renderPage();
    const hero = await screen.findByRole("region", { name: "Needs a decision" });
    expect(within(hero).getByText(/2 incidents need your decision/)).toBeInTheDocument();
    expect(within(hero).getByRole("link", { name: /Review P1 now/ })).toHaveAttribute("href", `/review/${p1.draft_id}`);
    expect(within(hero).getByText("+1 more waiting")).toBeInTheDocument();
    expect(within(hero).getByText(/Nothing is written to output\/tickets\//)).toBeInTheDocument();
  });

  it("shows the five components once each, with live counts", async () => {
    renderPage();
    const strip = await screen.findByRole("region", { name: "Pipeline" });
    ["C1", "C2", "C3", "C4", "C5"].forEach((c) => expect(within(strip).getByText(c)).toBeInTheDocument());
    // A Grafana `ok` event is counted as an ignored recovery, not as a lost signal.
    expect(within(strip).getByText("1 recovery ignored (state OK)")).toBeInTheDocument();
    expect(within(strip).getByText("awaiting a reviewer")).toBeInTheDocument();
    // Claude is off in the fixture: shown as a template fallback, not as broken.
    expect(within(strip).getByText("template drafts (Claude off)")).toBeInTheDocument();
  });

  it("puts the P1 incident in focus with separate impact and confidence gauges", async () => {
    renderPage();
    const story = await screen.findByRole("region", { name: "Incident in focus" });
    expect(within(story).getByText("agency-db: DBConnectionCount cascading to 2 service(s)")).toBeInTheDocument();
    expect(within(story).getByLabelText(/Impact severity · 0–100: \d+/)).toBeInTheDocument();
    expect(within(story).getByLabelText(/Correlation confidence · 0–1: \d\.\d\d/)).toBeInTheDocument();
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

  it("lists only anomalies, each with what happened to it", async () => {
    renderPage();
    const ledger = await screen.findByRole("region", { name: "Every anomaly, and what happened to it" });
    const list = await within(ledger).findByRole("list", { name: "Anomalies" });
    const rows = within(list).getAllByRole("button", { expanded: false });
    expect(rows.length).toBeGreaterThan(0);
    expect(within(list).queryByText("0.00")).not.toBeInTheDocument();
    expect(within(list).getAllByText(/in P1 incident/).length).toBeGreaterThan(0);
    fireEvent.click(rows[0]);
    expect(within(ledger).getByText("What happened:")).toBeInTheDocument();
  });

  it("reads as all clear, with a reason, when nothing needs a human", async () => {
    const status = fx["/engine/stream/status"] as { engine: Record<string, unknown> };
    mockApi({
      ...routes,
      "/engine/queue": [],
      "/engine/stream/status": { ...status, engine: { ...status.engine, incidents: 0, anomalous: 5, pending: 2 } },
    });
    renderPage();
    const hero = await screen.findByRole("region", { name: "All clear" });
    expect(within(hero).getByText(/All clear · 20 signals checked, 0 incidents raised/)).toBeInTheDocument();
    expect(within(hero).getByText(/Time alone never links two signals/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Incident in focus" })).not.toBeInTheDocument();
  });
});
