"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "react-toastify";
import { Badge, Button, Card, ProgressBar, Text } from "@tremor/react";
import { showErrorToast } from "@/shared/ui";
import { LuZap, LuPause, LuPlay, LuX } from "react-icons/lu";
import { useApi } from "@/shared/lib/hooks/useApi";
import { usePipelineActions } from "@/entities/alertlens";
import type { PipelineState } from "@/entities/alertlens";
import {
  STORM_SCENARIOS,
  STORM_SECONDS,
  STORM_SPEEDS,
  useStormStore,
} from "@/entities/alertlens/model/useStormStore";
import { ChaosInjectorModal } from "@/components/chaos/ChaosInjectorModal";

const TICK_MS = 100;

/**
 * Drives the replay clock. Mounted once (in the app layout) so the animation
 * keeps running as the user moves between pages.
 */
export function StormEngine() {
  const isStorming = useStormStore((s) => s.full !== null);
  const tick = useStormStore((s) => s.tick);
  const full = useStormStore((s) => s.full);
  const schedule = useStormStore((s) => s.schedule);
  const elapsed = useStormStore((s) => s.elapsed);

  // Clusters already announced, so each milestone fires once per replay.
  const announced = useRef({
    formed: new Set<number>(),
    dna: new Set<number>(),
  });

  useEffect(() => {
    if (!isStorming) return;
    const iv = setInterval(tick, TICK_MS);
    return () => clearInterval(iv);
  }, [isStorming, tick]);

  useEffect(() => {
    if (!isStorming) {
      announced.current = { formed: new Set(), dna: new Set() };
    }
  }, [isStorming]);

  /**
   * Narrates the replay: calls out each incident as it forms, and again when
   * it completes with a match in the Alert DNA library. This is what makes a
   * replay read as a story rather than a progress bar.
   */
  useEffect(() => {
    if (!full || !schedule) return;

    for (const c of full.clusters) {
      const revealed = c.alerts.filter(
        (a) => (schedule.get(a.id) ?? Infinity) <= elapsed
      ).length;
      if (revealed === 0) continue;

      const formingAt = Math.max(2, Math.ceil(c.alerts.length / 2));

      if (revealed >= formingAt && !announced.current.formed.has(c.cluster_id)) {
        announced.current.formed.add(c.cluster_id);
        toast.info(
          `Correlating · ${c.root_cause.service} — ${revealed} alerts grouped into ${c.root_cause.alertname}`,
          { position: "top-right", autoClose: 4000 }
        );
      }

      if (
        revealed === c.alerts.length &&
        c.dna_match &&
        !announced.current.dna.has(c.cluster_id)
      ) {
        announced.current.dna.add(c.cluster_id);
        const { similarity_pct, incident_id, resolution, resolution_minutes } =
          c.dna_match;
        const fix = resolution
          ? ` Known fix: ${resolution.slice(0, 70)}${resolution.length > 70 ? "…" : ""}`
          : "";
        const took = resolution_minutes ? ` (${resolution_minutes} min last time)` : "";
        toast.success(
          `Alert DNA · ${similarity_pct}% match to ${incident_id}.${fix}${took}`,
          { position: "top-right", autoClose: 7000 }
        );
      }
    }
  }, [full, schedule, elapsed]);

  return null;
}

/**
 * "Inject failure" — opens the Chaos Injector modal so the user picks a
 * scenario, then loads it and replays it progressively so you can watch
 * correlation happen in real time.
 */
export function StormMenu() {
  const api = useApi();
  const { loadDemo } = usePipelineActions();
  const start = useStormStore((s) => s.start);
  const isStorming = useStormStore((s) => s.full !== null);
  const [busy, setBusy] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  const injectAndReplay = async (scenario: string) => {
    setBusy(true);
    setModalOpen(false);
    try {
      await loadDemo({ scenario });
      const full = await api.get<PipelineState>("/pipeline");
      start(full, scenario);
    } catch (e) {
      showErrorToast(e, "Could not inject failure");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="xs"
        color="emerald"
        variant="secondary"
        icon={LuZap}
        loading={busy}
        disabled={busy || isStorming}
        onClick={() => setModalOpen(true)}
        className="whitespace-nowrap"
      >
        {busy ? "Storm incoming…" : "Inject failure"}
      </Button>

      <ChaosInjectorModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        onInject={injectAndReplay}
      />
    </>
  );
}

/** Floating transport controls, shown only while a replay is running. */
export function StormControls() {
  const { full, elapsed, speed, paused, scenario, setSpeed, togglePause, stop } =
    useStormStore();
  const lastCount = useRef(0);

  if (!full) {
    lastCount.current = 0;
    return null;
  }

  const progress = Math.min(elapsed / STORM_SECONDS, 1) * 100;
  const label =
    STORM_SCENARIOS.find((s) => s.key === scenario)?.label ?? "Live replay";

  return (
    <Card className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 w-[min(30rem,calc(100vw-2.5rem))] p-3 shadow-2xl">
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <LuZap className="w-4 h-4 text-green-500 shrink-0" />
          <Text className="font-medium truncate">{label}</Text>
          <Badge size="xs" color="emerald">
            replaying
          </Badge>
        </div>
        <button
          type="button"
          aria-label="Stop replay"
          onClick={stop}
          className="p-1 rounded hover:bg-gray-100 text-gray-500"
        >
          <LuX className="w-4 h-4" />
        </button>
      </div>

      <ProgressBar value={progress} color="emerald" />

      <div className="flex items-center justify-between gap-2 mt-2">
        <Button
          size="xs"
          variant="secondary"
          color="emerald"
          icon={paused ? LuPlay : LuPause}
          onClick={togglePause}
        >
          {paused ? "Resume" : "Pause"}
        </Button>
        <div className="flex items-center gap-1">
          {STORM_SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className={`text-xs px-2 py-1 rounded border ${
                speed === s
                  ? "border-green-400 text-green-600"
                  : "border-gray-200 text-gray-500"
              }`}
            >
              {s}×
            </button>
          ))}
        </div>
        <Text className="text-xs text-gray-500 tabular-nums">
          {Math.min(elapsed, STORM_SECONDS).toFixed(1)}s / {STORM_SECONDS}s
        </Text>
      </div>
    </Card>
  );
}
