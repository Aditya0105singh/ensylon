"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@tremor/react";
import { LuZap } from "react-icons/lu";
import { showErrorToast } from "@/shared/ui";
import { useEngineActions } from "./useEngine";

/**
 * Injects the fixed golden failure into the real engine and opens the incident
 * it produced. Nothing is published: the draft waits in the review queue.
 */
export function InjectFailureButton() {
  const { injectGolden } = useEngineActions();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [scenario, setScenario] = useState("golden");

  const inject = async () => {
    setBusy(true);
    try {
      const { queue } = await injectGolden(scenario);
      const first = queue[0];
      router.push(first ? `/review/${encodeURIComponent(first.draft_id)}` : "/review");
    } catch (e) {
      showErrorToast(e, "Could not inject failure");
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="inline-flex items-center gap-1.5">
      <select
        value={scenario}
        onChange={(e) => setScenario(e.target.value)}
        aria-label="Failure scenario"
        className="rounded-lg border border-green-300 bg-white text-xs text-green-900 font-medium px-2 py-1.5 focus:outline-none focus:border-green-500"
      >
        <option value="golden">Connection-pool failure</option>
        <option value="maintenance">Same failure, in a maintenance window</option>
        <option value="flapping">Flapping service</option>
      </select>
      <Button size="xs" color="emerald" icon={LuZap} loading={busy} disabled={busy} onClick={inject} className="whitespace-nowrap">
        {busy ? "Running pipeline…" : "Inject failure"}
      </Button>
    </span>
  );
}
