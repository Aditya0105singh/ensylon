import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useApi } from "@/shared/lib/hooks/useApi";
import { AssistantChat } from "../AssistantChat";

// jsdom doesn't implement scrollIntoView (same gap ResizeObserver has in
// jest.setup.ts) — AssistantChat calls it on every message list update.
window.HTMLElement.prototype.scrollIntoView = jest.fn();

// jest.setup.ts mocks next/navigation's usePathname to a fixed "/alerts/feed"
// — each test that cares about page context overrides it locally.
const mockUsePathname = jest.fn(() => "/");
jest.mock("next/navigation", () => ({
  usePathname: () => mockUsePathname(),
}));

// react-markdown/remark-gfm are ESM-only and outside this repo's Jest
// transformIgnorePatterns allowlist — rendering the real thing isn't the
// point of these tests, so it's replaced with the raw text.
jest.mock("@/shared/ui/MarkdownHTML/MarkdownHTML", () => ({
  MarkdownHTML: ({ children }: { children: string }) => <>{children}</>,
}));

function mockApiPost(impl: (endpoint: string, payload: unknown) => unknown) {
  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(),
    get: jest.fn(),
    post: jest.fn(impl),
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    isReady: () => true,
  });
}

function openChat() {
  fireEvent.click(screen.getByRole("button", { name: /open alertlens assistant/i }));
}

/** Types into the composer and presses Enter, matching AssistantChat's
 * controlled Textarea (onValueChange) + onKeyDown("Enter") send path. */
function typeAndSend(text: string) {
  const box = screen.getByPlaceholderText("Ask a question...");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter", code: "Enter" });
}

describe("AssistantChat", () => {
  beforeEach(() => {
    mockUsePathname.mockReturnValue("/");
    mockApiPost(async () => ({ answer: "Default mocked answer." }));
  });

  it("is closed by default (panel cross-fades rather than unmounting) and opens on trigger click", () => {
    render(<AssistantChat />);
    // The panel stays mounted at all times so open/close can cross-fade
    // (see the component's own comment) — "closed" is a CSS state, not
    // DOM absence.
    const panel = screen.getByText("AlertLens Assistant").closest(".fixed");
    expect(panel).toHaveClass("pointer-events-none");

    openChat();
    expect(panel).not.toHaveClass("pointer-events-none");
  });

  it("shows home-page suggested questions on the home route", () => {
    mockUsePathname.mockReturnValue("/");
    render(<AssistantChat />);
    openChat();
    expect(screen.getByRole("button", { name: "Top Risks" })).toBeInTheDocument();
  });

  it("shows incident-scoped suggestions and labels the incident on an incident route", () => {
    mockUsePathname.mockReturnValue("/incidents/42");
    render(<AssistantChat />);
    openChat();
    expect(screen.getByText("Incident 42")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Root Cause" })).toBeInTheDocument();
  });

  it("sends a workspace question without incident_id on a non-incident route", async () => {
    const post = jest.fn(async (_endpoint: string, _payload?: unknown) => ({ answer: "Workspace answer." }));
    mockApiPost(post);
    mockUsePathname.mockReturnValue("/feed");

    render(<AssistantChat />);
    openChat();
    typeAndSend("how many alerts?");

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [endpoint, payload] = post.mock.calls[0];
    expect(endpoint).toBe("/assistant/workspace");
    expect(payload).toMatchObject({ question: "how many alerts?" });
    expect(payload).not.toHaveProperty("incident_id");
  });

  it("includes incident_id in the payload on an incident route", async () => {
    const post = jest.fn(async (_endpoint: string, _payload?: unknown) => ({ answer: "Incident answer." }));
    mockApiPost(post);
    mockUsePathname.mockReturnValue("/incidents/42");

    render(<AssistantChat />);
    openChat();
    typeAndSend("why?");

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, payload] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(payload.incident_id).toBe("42");
  });

  it("renders the user question and the assistant's answer as separate turns", async () => {
    mockApiPost(async () => ({ answer: "The answer." }));
    render(<AssistantChat />);
    openChat();
    typeAndSend("a question");

    expect(await screen.findByText("The answer.")).toBeInTheDocument();
    expect(screen.getByText("a question")).toBeInTheDocument();
  });

  it("sends conversation history on the second turn", async () => {
    const post = jest.fn(async (_endpoint: string, _payload?: unknown) => ({ answer: "Second answer." }));
    mockApiPost(post);
    render(<AssistantChat />);
    openChat();

    typeAndSend("first question");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    await screen.findByText("Second answer.");

    typeAndSend("second question");
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));

    const [, secondPayload] = post.mock.calls[1] as [string, { conversation: unknown[] }];
    expect(secondPayload.conversation).toHaveLength(2); // first user turn + first assistant reply
  });

  it("shows the returned error message", async () => {
    const post = jest.fn().mockRejectedValueOnce(new Error("backend unreachable"));
    mockApiPost(post);
    render(<AssistantChat />);
    openChat();
    typeAndSend("hello");

    expect(await screen.findByText("backend unreachable")).toBeInTheDocument();
  });

  it("falls back to a default message when the backend returns no answer field", async () => {
    mockApiPost(async () => ({}));
    render(<AssistantChat />);
    openChat();
    typeAndSend("hello");

    expect(await screen.findByText("No answer returned.")).toBeInTheDocument();
  });

  it("does not send an empty or whitespace-only question", () => {
    const post = jest.fn(async (_endpoint: string, _payload?: unknown) => ({ answer: "x" }));
    mockApiPost(post);
    render(<AssistantChat />);
    openChat();
    typeAndSend("   ");
    expect(post).not.toHaveBeenCalled();
  });

  it("clears the conversation and hides the clear button again once empty", async () => {
    mockApiPost(async () => ({ answer: "answer" }));
    render(<AssistantChat />);
    openChat();
    typeAndSend("hi");
    await screen.findByText("answer");

    const clearButton = screen.getByRole("button", { name: /clear conversation/i });
    fireEvent.click(clearButton);

    expect(screen.queryByText("hi")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear conversation/i })).not.toBeInTheDocument();
  });

  it("clicking a suggested question sends it directly", async () => {
    const post = jest.fn(async (_endpoint: string, _payload?: unknown) => ({ answer: "Top risk is X." }));
    mockApiPost(post);
    mockUsePathname.mockReturnValue("/");
    render(<AssistantChat />);
    openChat();
    fireEvent.click(screen.getByRole("button", { name: "Top Risks" }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [, payload] = post.mock.calls[0] as [string, { question: string }];
    expect(payload.question).toBe("What are the top risk incidents right now?");
  });
});
