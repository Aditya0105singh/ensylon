import React from "react";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useApi } from "@/shared/lib/hooks/useApi";
import { useAlertActions } from "../useAlertActions";
import { usePipeline } from "../usePipeline";
import { alert, cluster, pipelineState } from "../../lib/__fixtures__/alertlens";
import type { Alert } from "../types";

function wrapper({ children }: { children: React.ReactNode }) {
  // A fresh, isolated SWR cache per test — the default global cache would
  // leak state between tests since usePipeline always keys on PIPELINE_KEY.
  return React.createElement(
    SWRConfig,
    { value: { provider: () => new Map(), dedupingInterval: 0 } },
    children
  );
}

/**
 * A minimal stateful fake of the real backend: POST actions mutate an
 * in-memory alert, GET /pipeline reflects whatever the latest state is.
 * Using a static mock here would be unrealistic — useAlertActions' `mutate`
 * call sets an optimistic patch *and* triggers a real revalidation fetch
 * (revalidate: true), so a GET mock that always returns the same pristine
 * object would clobber the optimistic patch with stale data, the same way a
 * real backend that failed to persist the action would. This fake persists
 * it, like the real one does.
 */
function createMockBackend(initial: Alert) {
  let current = { ...initial };

  const get = jest.fn(async () =>
    pipelineState({
      raw_alerts: [current],
      clusters: [cluster({ alerts: [current], root_cause: current })],
    })
  );

  const post = jest.fn(async (url: string, body: Record<string, unknown>) => {
    if (url.endsWith("/ack")) current = { ...current, acked: body.value as boolean };
    else if (url.endsWith("/assign"))
      current = { ...current, assignee: (body.assignee as string | null) ?? "n/a" };
    else if (url.endsWith("/dismiss") && body.status)
      current = { ...current, status: body.status as Alert["status"] };
    else if (url.endsWith("/escalate"))
      current = { ...current, escalated: body.value as boolean };
    return {};
  });

  (useApi as jest.Mock).mockReturnValue({
    request: jest.fn(),
    get,
    post,
    put: jest.fn(),
    patch: jest.fn(),
    delete: jest.fn(),
    isReady: () => true,
  });

  return { get, post };
}

async function renderSeeded(initial: Alert) {
  const backend = createMockBackend(initial);
  const { result } = renderHook(
    () => ({ actions: useAlertActions(), pipeline: usePipeline() }),
    { wrapper }
  );
  await waitFor(() => expect(result.current.pipeline.data).toBeDefined());
  return { result, ...backend };
}

describe("useAlertActions", () => {
  it("ack posts the right endpoint and body", async () => {
    const { result, post } = await renderSeeded(alert({ id: "a1" }));

    await act(async () => {
      await result.current.actions.ackAlert("a1", true);
    });

    expect(post).toHaveBeenCalledWith("/alerts/a1/ack", { value: true });
  });

  it("ack optimistically patches the alert before the server responds", async () => {
    const initial = alert({ id: "a1" });
    let resolvePost: () => void;
    const backend = createMockBackend(initial);
    backend.post.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePost = () => resolve({})))
    );
    const { result } = renderHook(
      () => ({ actions: useAlertActions(), pipeline: usePipeline() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.pipeline.data).toBeDefined());

    act(() => {
      result.current.actions.ackAlert("a1", true);
    });

    await waitFor(() => {
      const patched = result.current.pipeline.data?.raw_alerts.find((a) => a.id === "a1");
      expect(patched?.acked).toBe(true);
    });

    await act(async () => resolvePost());
  });

  it("ack patches the alert everywhere it appears — raw_alerts, cluster.alerts, and root_cause", async () => {
    const { result } = await renderSeeded(alert({ id: "a1" }));

    await act(async () => {
      await result.current.actions.ackAlert("a1", true);
    });

    await waitFor(() => {
      const data = result.current.pipeline.data!;
      expect(data.raw_alerts[0].acked).toBe(true);
      expect(data.clusters[0].alerts[0].acked).toBe(true);
      expect(data.clusters[0].root_cause.acked).toBe(true);
    });
  });

  it("assign posts assignee and patches it, using 'n/a' for null (unassign)", async () => {
    const { result, post } = await renderSeeded(alert({ id: "a1", assignee: "Aditya" }));

    await act(async () => {
      await result.current.actions.assignAlert("a1", null);
    });

    expect(post).toHaveBeenCalledWith("/alerts/a1/assign", { assignee: null });
    await waitFor(() => {
      expect(result.current.pipeline.data?.raw_alerts[0].assignee).toBe("n/a");
    });
  });

  it("dismiss with a status posts and patches status", async () => {
    const { result, post } = await renderSeeded(alert({ id: "a1", status: "firing" }));

    await act(async () => {
      await result.current.actions.dismissAlert("a1", "suppressed");
    });

    expect(post).toHaveBeenCalledWith("/alerts/a1/dismiss", { status: "suppressed" });
    await waitFor(() => {
      expect(result.current.pipeline.data?.raw_alerts[0].status).toBe("suppressed");
    });
  });

  it("dismiss with null clears the override without guessing a status locally", async () => {
    const { result, post } = await renderSeeded(alert({ id: "a1", status: "firing" }));

    await act(async () => {
      await result.current.actions.dismissAlert("a1", null);
    });

    // Empty local patch ({}), per useAlertActions' `status ? {status} : {}` —
    // the real status comes from the server's replayed pipeline, not a
    // locally guessed value. The mock backend leaves `current` untouched for
    // a null status, so this also proves no accidental local mutation.
    expect(post).toHaveBeenCalledWith("/alerts/a1/dismiss", { status: null });
    await waitFor(() => {
      expect(result.current.pipeline.data?.raw_alerts[0].status).toBe("firing");
    });
  });

  it("escalate posts and patches escalated", async () => {
    const { result, post } = await renderSeeded(alert({ id: "a1" }));

    await act(async () => {
      await result.current.actions.escalateAlert("a1", true);
    });

    expect(post).toHaveBeenCalledWith("/alerts/a1/escalate", { value: true });
    await waitFor(() => {
      expect(result.current.pipeline.data?.raw_alerts[0].escalated).toBe(true);
    });
  });

  it("rolls back the optimistic patch when the request fails", async () => {
    const initial = alert({ id: "a1" });
    const backend = createMockBackend(initial);
    backend.post.mockRejectedValueOnce(new Error("network error"));
    const { result } = renderHook(
      () => ({ actions: useAlertActions(), pipeline: usePipeline() }),
      { wrapper }
    );
    await waitFor(() => expect(result.current.pipeline.data).toBeDefined());

    await act(async () => {
      await result.current.actions.ackAlert("a1", true).catch(() => {});
    });

    await waitFor(() => {
      expect(result.current.pipeline.data?.raw_alerts[0].acked).toBeFalsy();
    });
  });
});
