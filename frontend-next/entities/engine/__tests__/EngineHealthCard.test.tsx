import React from "react";
import { render, screen, within } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import { EngineHealthCard } from "../EngineHealthCard";
import { engineHealth } from "../__fixtures__/engine";

function renderCard(getImpl: () => Promise<unknown>) {
  (useApi as jest.Mock).mockReturnValue({
    get: jest.fn(getImpl),
    post: jest.fn(),
    isReady: () => true,
  });
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <EngineHealthCard />
    </SWRConfig>
  );
}

const rowOf = (label: string) => screen.getByText(label).parentElement as HTMLElement;

describe("EngineHealthCard", () => {
  it("shows queue depth and highlights P1 drafts awaiting review", async () => {
    renderCard(() => Promise.resolve(engineHealth()));
    await screen.findByText("Awaiting human review");
    const row = rowOf("Awaiting human review");
    expect(within(row).getByText("1")).toBeInTheDocument();
    expect(within(row).getByText("(1 P1)")).toBeInTheDocument();
  });

  it("labels mock integrations as mock, never as live", async () => {
    renderCard(() => Promise.resolve(engineHealth()));
    await screen.findByText("Jira");
    expect(within(rowOf("Jira")).getByText("mock")).toBeInTheDocument();
    expect(within(rowOf("P1 paging")).getByText("mock")).toBeInTheDocument();
    expect(within(rowOf("LLM narrative")).getByText("template fallback")).toBeInTheDocument();
  });

  it("labels a real transport as live and names it", async () => {
    renderCard(() =>
      Promise.resolve(
        engineHealth({
          notifications: { transport: "WebhookNotificationTransport", live: true, sent: 3, recent: [] },
          llm: { configured_providers: ["cerebras"], live: true },
        })
      )
    );
    await screen.findByText("P1 paging");
    expect(within(rowOf("P1 paging")).getByText("live · WebhookNotificationTransport")).toBeInTheDocument();
    expect(within(rowOf("P1 paging")).getByText("3 sent")).toBeInTheDocument();
    expect(within(rowOf("LLM narrative")).getByText("cerebras")).toBeInTheDocument();
  });

  it("shows the last run's per-stage timings", async () => {
    renderCard(() => Promise.resolve(engineHealth()));
    expect(await screen.findByText("4.6 ms")).toBeInTheDocument();
    expect(screen.getByText("correlate")).toBeInTheDocument();
  });

  it("reports an unreachable health endpoint instead of rendering stale numbers", async () => {
    renderCard(() => Promise.reject(new Error("down")));
    expect(await screen.findByText("Health endpoint unreachable.")).toBeInTheDocument();
  });
});
