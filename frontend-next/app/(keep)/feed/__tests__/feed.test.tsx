import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { CanonicalSignal } from "@/entities/engine/types";
import { SignalFeedClient } from "../SignalFeedClient";
import fixture from "../../_overview/__tests__/live-fixture.json";

const fx = fixture as unknown as Record<string, unknown>;

const signal = (id: string, over: Partial<CanonicalSignal>, meta: Record<string, unknown>): CanonicalSignal => ({
  signal_id: id, timestamp: "2026-09-26T08:41:08Z", source: "application_logs", environment: "prod",
  region: "ap-south-1", service: "enrollment-service", component: "api-handler", signal_type: "error_log_burst",
  anomaly_score: 0, evidence: "Enrollment submitted — plan SILVER-HMO in 318ms — template#4", metadata: meta, ...over,
});

const info = signal("info-1", {}, { severity: "info", is_anomaly: false });
const error = signal("err-1", { service: "payments-service", anomaly_score: 0.8, evidence: "Connection pool exhausted — template#2" },
  { severity: "high", is_anomaly: true, detection_reason: "novel error template T2 not seen in baseline" });

function mockApi(routes: Record<string, unknown>) {
  const get = jest.fn((url: string) =>
    url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`unmocked GET ${url}`)));
  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(), get, post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(), isReady: () => true,
  });
  return get;
}

const renderFeed = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}>
      <SignalFeedClient />
    </SWRConfig>
  );

describe("SignalFeedClient", () => {
  const routes = {
    "/engine/stream/status": fx["/engine/stream/status"],
    "/engine/stream/signals?limit=300": { total: 2, signals: [info, error] },
    "/engine/stream/signals?limit=300&anomalous=true": { total: 1, signals: [error] },
  };

  it("shows the source's level, so an INFO line never reads as an error", async () => {
    mockApi(routes);
    renderFeed();
    const infoRow = (await screen.findByText("enrollment-service")).closest("tr")!;
    expect(within(infoRow).getByText("INFO")).toBeInTheDocument();
    expect(within(infoRow).getByText("error_log_burst")).toBeInTheDocument();   // canonical schema value kept
    const errRow = screen.getByText("payments-service").closest("tr")!;
    expect(within(errRow).getByText("ERROR")).toBeInTheDocument();
  });

  it("says it is live and how fresh the newest signal is", async () => {
    mockApi(routes);
    renderFeed();
    const bar = await screen.findByRole("status", { name: "Feed status" });
    expect(within(bar).getByText(/Live · 3\/3 streams/)).toBeInTheDocument();
    expect(within(bar).getByText(/newest signal/)).toBeInTheDocument();
    expect(await within(bar).findByText("1 of the newest 2 anomalous")).toBeInTheDocument();
  });

  it("opens the canonical record under the clicked row, with why it is anomalous", async () => {
    mockApi(routes);
    renderFeed();
    const row = (await screen.findByText("payments-service")).closest("tr")!;
    fireEvent.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Why it is anomalous:").parentElement).toHaveTextContent("novel error template T2 not seen in baseline");
    expect(screen.getByText("Canonical record")).toBeInTheDocument();
  });

  it("asks the backend for anomalies only when the toggle is on", async () => {
    const get = mockApi(routes);
    renderFeed();
    await screen.findByText("enrollment-service");
    fireEvent.click(screen.getByLabelText("Anomalies only"));
    expect(await screen.findByText("payments-service")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/engine/stream/signals?limit=300&anomalous=true");
  });
});
