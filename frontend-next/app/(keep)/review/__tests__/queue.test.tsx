import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";
import { useApi } from "@/shared/lib/hooks/useApi";
import type { QueueSummary } from "@/entities/engine/types";
import ReviewPage, { occurrences, orderQueue } from "../page.client";

jest.mock("next-auth/react", () => ({ useSession: jest.fn() }));
jest.mock("react-toastify", () => ({ toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() } }));

function q(over: Partial<QueueSummary>): QueueSummary {
  return {
    draft_id: "d", title: "[DRAFT] comms-service: QueueDepth", priority: "P2", severity_score: 0.52, correlation_confidence: 0.77,
    causal_confidence: 90, root_cause_service: "comms-service", affected_services: ["comms-service"], signal_count: 9,
    started_at: "2026-09-26T10:00:00Z", status: "awaiting_review", jira_key: null, merged_into: null, reviewer: null,
    suppressed: false, summary_source: "template", ...over,
  };
}

const queue = [
  q({ draft_id: "p2-old", started_at: "2026-09-26T08:00:00Z" }),
  q({ draft_id: "p1-new", priority: "P1", title: "[DRAFT] agency-db: DBConnectionCount cascading to 2 service(s)", root_cause_service: "agency-db",
    affected_services: ["agency-db", "payments-service"], started_at: "2026-09-26T11:00:00Z" }),
  q({ draft_id: "p2-new", started_at: "2026-09-26T09:30:00Z" }),
  q({ draft_id: "done", status: "published", jira_key: "TKT-0003", reviewer: "Neha Joshi <neha@ensylon.com>", started_at: "2026-09-26T07:00:00Z" }),
];

function mockApi(post = jest.fn()) {
  const routes: Record<string, unknown> = { "/engine/queue": queue, "/engine/audit": [] };
  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(),
    get: jest.fn((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`unmocked GET ${url}`)))),
    post, put: jest.fn(), patch: jest.fn(), delete: jest.fn(), isReady: () => true,
  });
  return post;
}

const renderPage = () =>
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, refreshInterval: 0 }}><ReviewPage /></SWRConfig>);

beforeEach(() => {
  localStorage.clear();
  (useSession as jest.Mock).mockReturnValue({ data: null });
  jest.clearAllMocks();
});

describe("queue ordering", () => {
  it("puts the most urgent first: priority, then whoever has waited longest", () => {
    expect(orderQueue(queue, "awaiting_review").map((i) => i.draft_id)).toEqual(["p1-new", "p2-old", "p2-new"]);
    expect(orderQueue(queue, "published").map((i) => i.draft_id)).toEqual(["done"]);
  });

  it("numbers the times the same failure has come back", () => {
    const occ = occurrences(queue);
    expect(occ.get("done")).toEqual({ nth: 1, of: 3 });
    expect(occ.get("p2-old")).toEqual({ nth: 2, of: 3 });
    expect(occ.get("p2-new")).toEqual({ nth: 3, of: 3 });
    expect(occ.get("p1-new")).toEqual({ nth: 1, of: 1 });
  });
});

describe("ReviewPage", () => {
  it("shows the queue first, most urgent on top, with no draft markers", async () => {
    mockApi();
    renderPage();
    const list = await screen.findByRole("region", { name: "Review queue" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("agency-db: DBConnectionCount cascading to 2 service(s)");
    expect(rows[1]).toHaveTextContent("2nd of 3 today");
    expect(list).not.toHaveTextContent("[DRAFT]");
    expect(within(rows[0]).getByRole("link", { name: /Review/ })).toHaveAttribute("href", "/review/p1-new");
    expect(screen.getByRole("button", { name: /Awaiting sign-off \(3\)/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("summarises what is waiting and for how long", async () => {
    mockApi();
    renderPage();
    const summary = await screen.findByLabelText("Queue summary");
    await waitFor(() => expect(summary).toHaveTextContent("3awaiting sign-off"));
    expect(summary).toHaveTextContent("1P1 waiting");
    expect(summary).toHaveTextContent("1approved");
  });

  it("will not approve from the queue until the reviewer has signed in with name and email", async () => {
    const post = mockApi();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "Approve p1-new" }));
    expect(toast.error).toHaveBeenCalledWith("Enter your name to sign off - every decision is signed with your name and email");
    expect(post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Neha Joshi" } });
    fireEvent.change(screen.getByLabelText("Reviewer email"), { target: { value: "neha@ensylon.com" } });
    post.mockResolvedValue({});
    fireEvent.click(screen.getByRole("button", { name: "Approve p1-new" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/engine/queue/p1-new/approve", { actor: "Neha Joshi", actor_email: "neha@ensylon.com" }));
  });

  it("shows who signed off decided incidents", async () => {
    mockApi();
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Approved \(1\)/ }));
    const list = screen.getByRole("region", { name: "Review queue" });
    expect(await within(list).findByText("TKT-0003")).toBeInTheDocument();
    expect(list).toHaveTextContent("by Neha Joshi <neha@ensylon.com>");
  });
});
