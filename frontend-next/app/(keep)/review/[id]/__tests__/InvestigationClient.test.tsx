import React from "react";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useSession } from "next-auth/react";
import { toast } from "react-toastify";
import { useApi } from "@/shared/lib/hooks/useApi";
import InvestigationClient from "../InvestigationClient";
import { draftDetail, evidence } from "@/entities/engine/__fixtures__/engine";

// This file's own session mock takes over from shared/tests/next-auth-mock.ts
// (loaded globally in jest.setup.ts) so the "missing reviewer" validation
// path — unreachable under the global mock's fixed "Test User" — is testable.
jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
}));

// react-toastify renders into a portal that needs a mounted <ToastContainer/>
// to appear in the DOM at all; asserting on the mock call is what every
// caller here actually controls, and is what other suites in this repo do
// for library-rendered UI they don't own.
jest.mock("react-toastify", () => ({
  toast: { error: jest.fn(), success: jest.fn(), info: jest.fn() },
}));

const DRAFT_ID = "draft-0-123";

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

function baseRoutes(overrides: { draft?: Partial<Parameters<typeof draftDetail>[0]>; evidenceOverrides?: Parameters<typeof evidence>[0] } = {}) {
  return {
    [`/engine/queue/${DRAFT_ID}/evidence`]: evidence(overrides.evidenceOverrides),
    [`/engine/queue/${DRAFT_ID}`]: draftDetail(overrides.draft),
    "/engine/audit": [],
    "/engine/feedback": { decisions: [], patterns: [] },
  };
}

function renderPage(
  routes: Record<string, unknown>,
  opts: { sessionName?: string | null; sessionEmail?: string | null; post?: jest.Mock } = {}
) {
  (useSession as jest.Mock).mockReturnValue({
    data: opts.sessionName === null ? null : {
      user: { name: opts.sessionName ?? "Test User", email: opts.sessionEmail === null ? undefined : opts.sessionEmail ?? "test.user@ensylon.com" },
    },
  });
  mockApi(routes, opts.post);
  return render(withFreshSWR(<InvestigationClient draftId={DRAFT_ID} />));
}

// The reviewer is remembered in localStorage between pages; each test starts clean.
beforeEach(() => localStorage.clear());

describe("InvestigationClient — empty and loading states", () => {
  it("shows a way back to Overview when there is no incident to investigate", async () => {
    // No route registered for the evidence GET, so mockApi's fetcher rejects,
    // exercising the same "no evidence" path a fresh/empty engine state hits.
    renderPage({});

    expect(await screen.findByText("No incident to investigate")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /go to overview/i })).toHaveAttribute("href", "/");
  });
});

describe("InvestigationClient — funnel and header", () => {
  it("shows the raw -> unique -> incident funnel and the rejected count from real evidence numbers", async () => {
    renderPage(baseRoutes());
    // raw_signals=17, unique_signals=6 -> 11 repeats collapsed; excluded.length=1
    expect(await screen.findByText("11 repeats collapsed")).toBeInTheDocument();
    expect(screen.getByText("root cause postgres-primary")).toBeInTheDocument();
    expect(screen.getByText("shared no context")).toBeInTheDocument();

    const rejectedLabel = screen.getByText("rejected");
    const rejectedBlock = rejectedLabel.parentElement as HTMLElement;
    expect(within(rejectedBlock).getByText("1")).toBeInTheDocument();
  });

  it("puts priority, status, scores and the decision in the bar at the top", async () => {
    renderPage(baseRoutes({ draft: { priority: "P1", status: "awaiting_review" } }));
    const bar = await screen.findByRole("region", { name: "Decision" });
    expect(within(bar).getByText("P1")).toBeInTheDocument();
    expect(within(bar).getByText("Awaiting human review")).toBeInTheDocument();
    expect(within(bar).getByLabelText(/^Impact: \d+/)).toBeInTheDocument();
    expect(within(bar).getByLabelText(/^Confidence: \d\.\d\d/)).toBeInTheDocument();
    for (const name of [/^approve$/i, /edit & approve/i, /^reject$/i]) {
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    }
    expect(within(bar).queryByText(/\[DRAFT\]/)).not.toBeInTheDocument();
  });
});

describe("InvestigationClient — Correlation Explorer", () => {
  it("shows why each signal joined, including a repeated-signal badge", async () => {
    renderPage(baseRoutes());
    fireEvent.click(await screen.findByRole("tab", { name: /Signals & joins/ }));
    expect(await screen.findByText("×12 collapsed into 1")).toBeInTheDocument();
    expect(screen.getByText("root-cause signal")).toBeInTheDocument();
    expect(screen.getAllByText(/Same service|Dependency link/).length).toBeGreaterThan(0);
  });

  it("lists a rejected signal with its failed checks and the reason, under Considered and rejected", async () => {
    renderPage(baseRoutes());
    fireEvent.click(await screen.findByRole("tab", { name: /Rejected \(1\)/ }));
    const heading = await screen.findByText("Considered and rejected");
    const section = heading.parentElement as HTMLElement;
    expect(within(section).getByText("REJECTED FROM INCIDENT")).toBeInTheDocument();
    expect(within(section).getByText("log-archive")).toBeInTheDocument();
    expect(within(section).getByText(/no shared service, dependency edge, or trace id/)).toBeInTheDocument();
  });
});

describe("InvestigationClient — root cause, severity, confidence, history", () => {
  it("ranks the root cause above its rejected symptom, with the counterfactual note", async () => {
    renderPage(baseRoutes());
    expect(await screen.findByText("Counterfactual check (graph ablation)")).toBeInTheDocument();
    expect(screen.getByText("SYMPTOM")).toBeInTheDocument();
    expect(screen.getByText(/rejected by counterfactual/)).toBeInTheDocument();
  });

  it("shows the priority, score and every weighted factor's contribution", async () => {
    renderPage(baseRoutes());
    fireEvent.click(await screen.findByRole("tab", { name: "Severity" }));
    expect(await screen.findByText("Severity — why this priority")).toBeInTheDocument();
    expect(screen.getByText("0.846")).toBeInTheDocument();
    expect(screen.getByText("≥ 0.75 → P1")).toBeInTheDocument();
    // business criticality: weight 0.3 * value 1.0 = +0.30
    expect(screen.getByText("+0.30")).toBeInTheDocument();
    expect(screen.getByText(/blast radius/i)).toBeInTheDocument();
  });

  it("shows a historical match with its resolution when the draft has one", async () => {
    renderPage(
      baseRoutes({
        draft: {
          historical_match: {
            incident_id: "INC-0417", title: "Pool exhaustion", similarity_pct: 90,
            resolution: "Raised the pool size", resolution_minutes: 34, shared_terms: ["pool", "connection"], source: "seeded demo history",
          },
        },
      })
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Historical match" }));
    expect(await screen.findByText("INC-0417")).toBeInTheDocument();
    expect(screen.getByText("90% similar")).toBeInTheDocument();
    expect(screen.getByText(/Raised the pool size/)).toBeInTheDocument();
  });

  it("shows no history card when the backend has no past-incident library", async () => {
    renderPage(baseRoutes({ draft: { historical_match: null } }));
    await screen.findByText("AWAITING HUMAN REVIEW");
    expect(screen.queryByText(/Historical match/)).not.toBeInTheDocument();
  });
});

describe("InvestigationClient — the review gate", () => {
  it("shows AWAITING HUMAN REVIEW and that nothing is written before approval", async () => {
    renderPage(baseRoutes({ draft: { status: "awaiting_review", jira_key: null } }));
    expect(await screen.findByText("AWAITING HUMAN REVIEW")).toBeInTheDocument();
    expect(screen.getByText(/Nothing is written to output\/tickets\/ until a named reviewer approves/)).toBeInTheDocument();
  });

  it("shows the computed-facts / AI-generated split, and that Claude cannot add facts", async () => {
    renderPage(baseRoutes());
    const heading = await screen.findByText("Ticket draft - what the on-call engineer will receive");
    const ticketCard = heading.closest("section") as HTMLElement;
    expect(within(ticketCard).getByText("Computed")).toBeInTheDocument();
    expect(within(ticketCard).getByText("AI-generated")).toBeInTheDocument();
    expect(within(ticketCard).getByText(/Claude only writes prose from the facts on the left/)).toBeInTheDocument();
    expect(within(ticketCard).getByText(/hypothesis, not a fact/)).toBeInTheDocument();
  });

  it("refuses to approve without a reviewer name", async () => {
    const post = jest.fn();
    renderPage(baseRoutes(), { sessionName: null, post });
    await screen.findByText("AWAITING HUMAN REVIEW");

    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Enter your name to sign off - every decision is signed with your name and email")
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses to approve without the reviewer's email", async () => {
    const post = jest.fn();
    renderPage(baseRoutes(), { sessionEmail: null, post });
    await screen.findByText("AWAITING HUMAN REVIEW");

    fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Aditya Singh" } });
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Enter your email to sign off - every decision is signed with your name and email")
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("never signs off as the no-auth placeholder session", async () => {
    renderPage(baseRoutes(), { sessionName: "Reviewer", sessionEmail: "keep" });
    await screen.findByText("AWAITING HUMAN REVIEW");
    expect(screen.getByLabelText("Reviewer name")).toHaveValue("");
    expect(screen.getByLabelText("Reviewer email")).toHaveValue("");
  });

  it("approving posts the reviewer's name and email with the decision", async () => {
    const post = jest.fn().mockResolvedValue(draftDetail({ status: "published", jira_key: "TKT-0001" }));
    renderPage(baseRoutes(), { post });
    await screen.findByText("AWAITING HUMAN REVIEW");

    fireEvent.change(screen.getByLabelText("Reviewer name"), { target: { value: "Aditya Singh" } });
    fireEvent.change(screen.getByLabelText("Reviewer email"), { target: { value: "aditya@ensylon.com" } });
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/engine/queue/${DRAFT_ID}/approve`, { actor: "Aditya Singh", actor_email: "aditya@ensylon.com" })
    );
  });

  it("edit-and-approve sends only the changed fields", async () => {
    const post = jest.fn().mockResolvedValue(draftDetail({ status: "published", jira_key: "TKT-0001" }));
    renderPage(baseRoutes(), { post });
    await screen.findByText("AWAITING HUMAN REVIEW");

    fireEvent.click(screen.getByRole("button", { name: /edit & approve/i }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "DB pool exhausted" } });
    fireEvent.click(screen.getByRole("button", { name: /approve edited ticket/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/engine/queue/${DRAFT_ID}/approve`, {
        actor: "Test User",
        actor_email: "test.user@ensylon.com",
        edits: { title: "DB pool exhausted" },
      })
    );
  });

  it("shows the written ticket, its file and the approval guarantees once approved", async () => {
    renderPage(baseRoutes({ draft: { status: "published", jira_key: "TKT-0001", reviewer: "Aditya Singh" } }));
    expect(await screen.findByText("WRITTEN as TKT-0001")).toBeInTheDocument();
    expect(screen.getByText("output/tickets/TKT-0001.json + .md")).toBeInTheDocument();
    expect(screen.getByText(/Human approval recorded \(Aditya Singh\)/)).toBeInTheDocument();
    expect(screen.getByText(/Single-use approval token minted/)).toBeInTheDocument();
    expect(screen.getByText(/Ticket written once/)).toBeInTheDocument();
  });

  it("rejecting posts to the reject endpoint with the reviewer's reason", async () => {
    const post = jest.fn().mockResolvedValue(draftDetail({ status: "rejected" }));
    renderPage(baseRoutes(), { post });
    await screen.findByText("AWAITING HUMAN REVIEW");

    fireEvent.click(screen.getByRole("button", { name: /^reject$/i }));
    fireEvent.change(await screen.findByLabelText("Reject reason"), { target: { value: "known deploy" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm reject/i }));

    await waitFor(() =>
      expect(post).toHaveBeenCalledWith(`/engine/queue/${DRAFT_ID}/reject`, {
        actor: "Test User", actor_email: "test.user@ensylon.com", note: "known deploy",
      })
    );
  });
});

describe("InvestigationClient — stateful incident", () => {
  it("offers Mark resolved once the ticket is written", async () => {
    renderPage(baseRoutes({ draft: { status: "published", jira_key: "TKT-0001" } }));
    expect(await screen.findByRole("button", { name: /mark resolved/i })).toBeInTheDocument();
  });

  it("has no synthetic late-signal controls: late signals come only from the streams", async () => {
    renderPage(baseRoutes());
    await screen.findByText("AWAITING HUMAN REVIEW");
    expect(screen.queryByRole("button", { name: /late alert/i })).not.toBeInTheDocument();
  });
});
