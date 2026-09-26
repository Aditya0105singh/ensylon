"use client";

import { useState } from "react";
import { Button } from "@tremor/react";
import { DropdownMenu, showErrorToast, showSuccessToast } from "@/shared/ui";
import { HiOutlineCircleStack } from "react-icons/hi2";
import { LuActivity, LuDatabase, LuCheck } from "react-icons/lu";
import { usePipelineActions, useSettingsStatus } from "@/entities/alertlens";

export type DataSourceKey = "bgl" | "synthetic";

export const DATA_SOURCES: {
  key: DataSourceKey;
  label: string;
  sub: string;
  icon: React.ElementType;
}[] = [
  {
    key: "bgl",
    label: "Loghub BGL",
    sub: "Real supercomputer log, 10k alerts",
    icon: LuActivity,
  },
  {
    key: "synthetic",
    label: "Synthetic Demo",
    sub: "Scripted incident scenarios",
    icon: LuDatabase,
  },
];

/** Maps the backend's real `dataset` status string to a DataSourceKey, so
 * the UI can highlight what's actually loaded instead of guessing. */
function keyForDataset(dataset: string | undefined): DataSourceKey | null {
  if (dataset === "loghub-bgl") return "bgl";
  if (dataset === "synthetic") return "synthetic";
  return null;
}

/**
 * Switches the loaded alert batch. Each option replaces the current batch
 * server-side and revalidates the pipeline, so the whole app follows.
 */
export function DataSourceMenu({
  onLoaded,
}: {
  onLoaded?: (key: DataSourceKey) => void;
}) {
  const { loadDemo, loadBgl } = usePipelineActions();
  const { data: status, mutate: refreshStatus } = useSettingsStatus();
  const [busy, setBusy] = useState<DataSourceKey | null>(null);
  const [active, setActive] = useState<DataSourceKey | null>(null);
  const resolvedActive = active ?? keyForDataset(status?.dataset);

  const select = async (key: DataSourceKey) => {
    setBusy(key);
    const label = DATA_SOURCES.find((d) => d.key === key)?.label ?? key;
    try {
      const result =
        key === "bgl"
          ? await loadBgl()
          : await loadDemo();

      showSuccessToast(
        `Loaded ${label} — ${result.raw_alerts} alerts, ${result.clusters_formed} incidents`
      );
      setActive(key);
      refreshStatus();
      onLoaded?.(key);
    } catch (e) {
      showErrorToast(e, `Could not load ${label}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <DropdownMenu.Menu
      icon={HiOutlineCircleStack}
      label={busy ? "Loading..." : "Load dataset"}
    >
      {DATA_SOURCES.map(({ key, label, sub, icon }) => (
        <DropdownMenu.Item
          key={key}
          icon={resolvedActive === key ? LuCheck : icon}
          label={`${label} — ${sub}`}
          onClick={() => select(key)}
        />
      ))}
    </DropdownMenu.Menu>
  );
}

/** Inline button row variant, for pages that want the choices visible. */
export function DataSourceButtons() {
  const { loadDemo, loadBgl } = usePipelineActions();
  const { data: status, mutate: refreshStatus } = useSettingsStatus();
  const [busy, setBusy] = useState<DataSourceKey | null>(null);
  const [active, setActive] = useState<DataSourceKey | null>(null);
  const resolvedActive = active ?? keyForDataset(status?.dataset);

  const loaders: Record<DataSourceKey, () => Promise<unknown>> = {
    bgl: loadBgl,
    synthetic: () => loadDemo(),
  };

  const run = async (key: DataSourceKey) => {
    setBusy(key);
    const label = DATA_SOURCES.find((d) => d.key === key)?.label ?? key;
    try {
      await loaders[key]();
      showSuccessToast(`Loaded ${label}`);
      setActive(key);
      refreshStatus();
    } catch (e) {
      showErrorToast(e, `Could not load ${label}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      {DATA_SOURCES.map(({ key, label }) => (
        <Button
          key={key}
          size="xs"
          color="emerald"
          variant={resolvedActive === key ? "primary" : "secondary"}
          loading={busy === key}
          disabled={busy !== null}
          onClick={() => run(key)}
        >
          {label}
        </Button>
      ))}
    </div>
  );
}
