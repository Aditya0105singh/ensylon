import React from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { Evidence, QueueSummary } from "@/entities/engine/types";
import { TimeMachineClient } from "../TimeMachineClient";
import { arrivedIndex, buildSteps, sinceOnset } from "../model";
import fixture from "../../_overview/__tests__/live-fixture.json";

// Captured from the backend on tools/fake_nexus.py: agency-db -> payments ->
// enrollment (P1), with agency-db's alarm arriving first.
const fx = fixture as unknown as Record<string, unknown>;
const queue = fx["/engine/queue"] as QueueSummary[];
const p1 = queue.find((q) => q.priority === "P1")!;
const evKey = `/engine/queue/${p1.draft_id}/evidence`;
const p1Evidence = fx[evKey] as Evidence;

/** The same incident, but payments-service complains before agency-db. */
function paymentsFirst(): Evidence {
  const ev: Evidence = JSON.parse(JSON.stringify(p1Evidence));
  const db = ev.signals.find((s) => s.service === "agency-db")!;
  db.at = "2026-09-26T06:12:50Z";
  return ev;
}

function mockApi(routes: Record<string, unknown>) {
  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(),
    get: jest.fn((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`unmocked GET ${url}`)))),
    post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(), isReady: () => true,
  });
}

const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}>
      <TimeMachineClient />
    </SWRConfig>
  );

describe("time machine model", () => {
  it("orders signals by arrival and measures each from the first", () => {
    const { steps, span } = buildSteps(p1Evidence);
    const at = (i: number) => Date.parse(steps[i].at);
    expect(steps.map((s) => s.service)).toEqual([
      "agency-db", "payments-service", "payments-service", "enrollment-service", "enrollment-service",
    ]);
    expect(steps[0].t).toBe(0);
    expect(span).toBe(at(4) - at(0));
    expect(span).toBeGreaterThan(19_000);
    expect(steps.map((s) => s.lane)).toEqual([
      "cloudwatch_metrics", "application_logs", "cloudwatch_metrics", "application_logs", "grafana_alerts",
    ]);
  });

  it("finds the last signal to have arrived at any moment", () => {
    const { steps, span } = buildSteps(p1Evidence);
    expect(arrivedIndex(steps, -1)).toBe(-1);
    expect(arrivedIndex(steps, 0)).toBe(0);
    expect(arrivedIndex(steps, steps[1].t - 1)).toBe(0);
    expect(arrivedIndex(steps, steps[1].t)).toBe(1);
    expect(arrivedIndex(steps, span)).toBe(4);
  });

  it("formats time since the first signal", () => {
    expect(sinceOnset(4_000)).toBe("+4s");
    expect(sinceOnset(125_000)).toBe("+2m 05s");
  });
});

describe("TimeMachineClient", () => {
  const routes = { ...fx };
  beforeAll(() => { window.scrollTo = jest.fn() as unknown as typeof window.scrollTo; });

  it("offers every incident to replay and opens the newest", async () => {
    mockApi(routes);
    renderPage();
    const reel = await screen.findByRole("listbox", { name: "Incident to replay" });
    expect(within(reel).getAllByRole("option")).toHaveLength(queue.length);
    expect(await screen.findByRole("region", { name: "Replay timeline" })).toBeInTheDocument();
  });

  it("keeps the verdict locked until the last signal is in, then names the origin", async () => {
    mockApi(routes);
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: /agency-db/ }));
    const verdict = await screen.findByRole("region", { name: "Verdict" });
    expect(within(verdict).getByText("The verdict waits for the last signal")).toBeInTheDocument();

    fireEvent.click(within(verdict).getByText("Skip to the verdict →"));
    const origin = (await within(verdict).findByText("Probable origin")).parentElement!;
    expect(origin).toHaveTextContent(/^Probable originagency-db/);
    // 0.93 is a fraction: shown as 93%, not "1%"
    expect(within(verdict).getByText("93%")).toBeInTheDocument();
    expect(within(verdict).getByText(/symptom of agency-db/)).toBeInTheDocument();
    // agency-db also spoke first here, so there is no "first is not the cause" note
    expect(within(verdict).queryByText(/complained first/)).not.toBeInTheDocument();
    expect(within(verdict).getByRole("link", { name: /Review this incident/ })).toHaveAttribute("href", `/review/${p1.draft_id}`);
  });

  it("says so when the first service to complain is not the cause", async () => {
    mockApi({ ...routes, [evKey]: paymentsFirst() });
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: /agency-db/ }));
    const verdict = await screen.findByRole("region", { name: "Verdict" });
    fireEvent.click(within(verdict).getByText("Skip to the verdict →"));
    const note = await within(verdict).findByText(/complained first/);
    expect(note.closest("div")).toHaveTextContent(/payments-service complained first.*not the cause/);
  });

  it("explains why a signal joined, against the merge threshold", async () => {
    mockApi(routes);
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: /agency-db/ }));
    await screen.findByRole("region", { name: "Replay timeline" });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const explain = screen.getByRole("region", { name: "Why this signal joined" });
    expect(within(explain).getByText(/Opens the candidate incident/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next signal" }));
    expect(await within(explain).findByText(/Passed the gate/)).toBeInTheDocument();
    expect(within(explain).getByText("merge ≥ 0.45")).toBeInTheDocument();
    expect(within(explain).getByText(/cleared by \+/)).toBeInTheDocument();
  });

  it("steps with the keyboard", async () => {
    mockApi(routes);
    renderPage();
    fireEvent.click(await screen.findByRole("option", { name: /agency-db/ }));
    const timeline = await screen.findByRole("region", { name: "Replay timeline" });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    const before = within(timeline).getByText(/\/ 5 signals/).parentElement!.textContent;
    act(() => { fireEvent.keyDown(window, { key: "ArrowRight" }); });
    const after = within(timeline).getByText(/\/ 5 signals/).parentElement!.textContent;
    expect(after).not.toBe(before);
  });
});
