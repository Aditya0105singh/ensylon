import React from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { ArchivedIncident, ArchivedIncidentDetail, Evidence, QueueSummary } from "@/entities/engine/types";
import { HistoryClient } from "../HistoryClient";
import { ArchivedIncidentClient } from "../[id]/ArchivedIncidentClient";
import { TimeMachineClient } from "../../timemachine/TimeMachineClient";
import { dayLabel, duration, groupByDay, median } from "../lib";
import fixture from "../../_overview/__tests__/live-fixture.json";

const fx = fixture as unknown as Record<string, unknown>;
const p1 = (fx["/engine/queue"] as QueueSummary[]).find((q) => q.priority === "P1")!;
const p1Detail = fx[`/engine/queue/${p1.draft_id}`] as ArchivedIncidentDetail["detail"];
const p1Evidence = fx[`/engine/queue/${p1.draft_id}/evidence`] as Evidence;

const NOW = Date.parse("2026-09-26T12:00:00Z");

function incident(over: Partial<ArchivedIncident>): ArchivedIncident {
  return {
    draft_id: "d-1", title: "[DRAFT] agency-db: DBConnectionCount cascading to 2 service(s)", priority: "P1",
    status: "published", severity_score: 0.87, correlation_confidence: 0.83, root_cause_service: "agency-db",
    affected_services: ["agency-db", "payments-service", "enrollment-service"], signal_count: 12,
    started_at: "2026-09-25T23:10:00Z", raised_at: "2026-09-25T23:11:00Z", updated_at: "2026-09-25T23:40:00Z",
    decided_at: "2026-09-25T23:49:00Z", decided_by: { name: "Neha Joshi", email: "neha.joshi@ensylon.com" },
    ticket_key: "TKT-0007", source: "https://logs.nonprod.nexus.ensylon.com", ...over,
  };
}

const lastNight = incident({});
const thisMorning = incident({
  draft_id: "d-2", title: "[DRAFT] comms-service: QueueDepth", priority: "P2", status: "awaiting_review",
  root_cause_service: "comms-service", affected_services: ["comms-service"], started_at: "2026-09-26T08:05:00Z",
  raised_at: "2026-09-26T08:06:00Z", decided_at: null, decided_by: null, ticket_key: null,
});

const record: ArchivedIncidentDetail = {
  ...lastNight,
  detail: { ...p1Detail, title: "DB pool exhausted on agency-db" },
  evidence: { ...p1Evidence, draft_id: "d-1" },
  audit: [
    { seq: 1, at: "2026-09-25T23:11:00Z", action: "raised", actor: { name: "engine", email: null }, note: "P1 raised with 5 signals", changes: null },
    { seq: 2, at: "2026-09-25T23:20:00Z", action: "updated", actor: { name: "engine", email: null }, note: "now 12 signals; P1", changes: null },
    {
      seq: 3, at: "2026-09-25T23:49:00Z", action: "edit_and_approve", actor: { name: "Neha Joshi", email: "neha.joshi@ensylon.com" },
      note: "ticket TKT-0007 written",
      changes: { title: { before: "agency-db: DBConnectionCount cascading to 2 service(s)", after: "DB pool exhausted on agency-db" } },
    },
  ],
};

function mockApi(routes: Record<string, unknown>) {
  const get = jest.fn((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`unmocked GET ${url}`))));
  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(), get, post: jest.fn(), put: jest.fn(), patch: jest.fn(), delete: jest.fn(), isReady: () => true,
  });
  return get;
}

const withSWR = (ui: React.ReactNode) =>
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0, shouldRetryOnError: false }}>{ui}</SWRConfig>);

beforeAll(() => { window.scrollTo = jest.fn() as unknown as typeof window.scrollTo; });

describe("history helpers", () => {
  it("names days the way a reviewer asks about them", () => {
    expect(dayLabel("2026-09-26T08:05:00Z", NOW)).toBe("Today · Sat 26 Sept");
    expect(dayLabel("2026-09-25T23:10:00Z", NOW)).toBe("Yesterday · Fri 25 Sept");
    expect(dayLabel("2026-09-23T10:00:00Z", NOW)).toBe("Wed 23 Sept");
  });

  it("groups by day, newest first", () => {
    const groups = groupByDay([lastNight, thisMorning], NOW);
    expect(groups.map((g) => [g.day.split(" · ")[0], g.items.map((i) => i.draft_id)])).toEqual([["Today", ["d-2"]], ["Yesterday", ["d-1"]]]);
  });

  it("formats durations and medians for time to sign-off", () => {
    expect(duration(38 * 60_000)).toBe("38 min");
    expect(duration(90 * 60_000)).toBe("1 h 30 min");
    expect(duration(51 * 3_600_000)).toBe("2 d 3 h");
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });
});

describe("HistoryClient", () => {
  it("lists incidents by day with who signed off and how quickly", async () => {
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    mockApi({ "/engine/history?hours=168": [thisMorning, lastNight] });
    withSWR(<HistoryClient />);
    const yesterday = await screen.findByRole("region", { name: /^Yesterday/ });
    const row = within(yesterday).getByRole("link");
    expect(row).toHaveAttribute("href", "/history/d-1");
    expect(row).toHaveTextContent("Neha Joshi");
    expect(row).toHaveTextContent("neha.joshi@ensylon.com");
    expect(row).toHaveTextContent("38 min after it was raised");
    expect(row).toHaveTextContent("Approved · TKT-0007");
    expect(within(screen.getByRole("region", { name: /^Today/ })).getByRole("link")).toHaveTextContent("Awaiting sign-off");

    const summary = screen.getByLabelText("Summary");
    expect(summary).toHaveTextContent("1/2signed off by a named reviewer");
    expect(summary).toHaveTextContent("38 minmedian time to sign-off");
    (Date.now as jest.Mock).mockRestore();
  });

  it("searches by reviewer and filters by status and range", async () => {
    const get = mockApi({
      "/engine/history?hours=168": [thisMorning, lastNight],
      "/engine/history?hours=168&status=rejected": [],
      "/engine/history?status=rejected": [],
      "/engine/history?status=rejected&q=neha": [],
    });
    withSWR(<HistoryClient />);
    await screen.findByRole("region", { name: /^Yesterday/ });
    fireEvent.click(within(screen.getByRole("group", { name: "Status" })).getByRole("button", { name: "Rejected" }));
    expect(await screen.findByText("No incidents in this range")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("group", { name: "Time range" })).getByRole("button", { name: "All" }));
    fireEvent.change(screen.getByLabelText("Search incident history"), { target: { value: "neha" } });
    await screen.findByText("No incidents in this range");
    expect(get).toHaveBeenCalledWith("/engine/history?status=rejected&q=neha");
  });
});

describe("ArchivedIncidentClient", () => {
  it("shows the sign-off trail: who, their email, when, and what they changed", async () => {
    mockApi({ "/engine/history/d-1": record });
    withSWR(<ArchivedIncidentClient draftId="d-1" />);
    const trail = await screen.findByRole("region", { name: "Sign-off trail" });
    expect(within(trail).getByText("Raised by the engine")).toBeInTheDocument();
    expect(within(trail).getByText("Edited and approved")).toBeInTheDocument();
    expect(within(trail).getByRole("link", { name: "neha.joshi@ensylon.com" })).toHaveAttribute("href", "mailto:neha.joshi@ensylon.com");
    expect(within(trail).getByText("DB pool exhausted on agency-db")).toBeInTheDocument();          // after
    expect(within(trail).getByText("agency-db: DBConnectionCount cascading to 2 service(s)")).toBeInTheDocument(); // before

    const head = screen.getByRole("region", { name: "Incident record" });
    expect(head).toHaveTextContent("Signed off by Neha Joshi (neha.joshi@ensylon.com)");
    expect(within(head).getByRole("link", { name: /Replay how it formed/ })).toHaveAttribute("href", "/timemachine?id=d-1");
  });
});

describe("TimeMachineClient with the archive", () => {
  it("replays an incident the live engine no longer holds", async () => {
    mockApi({
      "/engine/queue": [],
      "/engine/history": [lastNight],
      "/engine/history/d-1": record,
      "/engine/graph": fx["/engine/graph"],
    });
    withSWR(<TimeMachineClient />);
    expect(await screen.findByRole("option", { name: /agency-db/ })).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Replay timeline" })).toBeInTheDocument();
    expect(screen.getByText(/\/ 5 signals/)).toBeInTheDocument();
  });
});
