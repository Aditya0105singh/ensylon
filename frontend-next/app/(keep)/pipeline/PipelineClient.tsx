"use client";

import { useMemo, useState } from "react";
import { Badge, Card, Text, Title } from "@tremor/react";
import {
  EmptyStateCard,
  KeepLoader,
  PageHero,
} from "@/shared/ui";
import { LuWorkflow, LuChevronDown } from "react-icons/lu";
import { usePipelineState } from "@/entities/alertlens";
import { buildStages, type Stage } from "@/entities/alertlens/lib/buildStages";
import { EnginePipelineSection } from "@/entities/engine/EngineCards";
import { DataSourceButtons } from "@/entities/alertlens/ui/DataSourceMenu";

function StageCard({
  stage,
  index,
  isOpen,
  onToggle,
}: {
  stage: Stage;
  index: number;
  isOpen: boolean;
  onToggle: () => void;
}) {
  return (
    <Card
      className={`p-4 h-full flex flex-col cursor-pointer transition-shadow ${
        isOpen ? "ring-2 ring-green-400" : "hover:shadow-md"
      }`}
      onClick={onToggle}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-full bg-green-100 text-green-600 text-xs font-semibold flex items-center justify-center shrink-0">
              {index + 1}
            </span>
            <span className="font-medium truncate">{stage.label}</span>
          </div>
          <div className="mt-2 text-2xl font-semibold">{stage.metric}</div>
          <Text className="text-xs text-gray-500">{stage.metricLabel}</Text>
          {/* Always reserve this row: stages without a badge otherwise start
              their detail sections higher than their neighbours'. */}
          <div className="mt-1 h-[22px]">
            {stage.subMetric && (
              <Badge size="xs" color="emerald">
                {stage.subMetric}
              </Badge>
            )}
          </div>
        </div>
        <LuChevronDown
          className={`w-4 h-4 text-gray-400 shrink-0 mt-1 transition-transform ${
            isOpen ? "rotate-180" : ""
          }`}
        />
      </div>

      {isOpen && (
        <div className="mt-3 pt-3 border-t border-gray-200 flex flex-col gap-2 text-sm flex-1">
          <div>
            <Text className="text-xs uppercase tracking-wide text-gray-500">
              Purpose
            </Text>
            <div>{stage.detail.purpose}</div>
          </div>
          <div>
            <Text className="text-xs uppercase tracking-wide text-gray-500">
              Algorithm
            </Text>
            <div>{stage.detail.algorithm}</div>
          </div>
          {stage.detail.parameters && (
            <div>
              <Text className="text-xs uppercase tracking-wide text-gray-500">
                Parameters
              </Text>
              <div className="font-mono text-xs">{stage.detail.parameters}</div>
            </div>
          )}
          {/* mt-auto pins Inputs/Outputs to the card bottom so they line up
              across a row of equal-height cards. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-auto pt-2">
            <div>
              <Text className="text-xs uppercase tracking-wide text-gray-500">
                Inputs
              </Text>
              <div className="text-xs">{stage.detail.inputs}</div>
            </div>
            <div>
              <Text className="text-xs uppercase tracking-wide text-gray-500">
                Outputs
              </Text>
              <div className="text-xs">{stage.detail.outputs}</div>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}

export function PipelineClient() {
  const { state, isLoading, error } = usePipelineState();
  // A Set, not a single id - each stage toggles independently instead of
  // opening one and silently closing whichever was open before.
  const [openStages, setOpenStages] = useState<Set<string>>(new Set());

  const stages = useMemo(() => buildStages(state), [state]);

  if (isLoading) {
    return <KeepLoader loadingText="Loading pipeline state..." />;
  }

  if (error) {
    return (
      <div className="p-4">
        <EmptyStateCard
          icon={LuWorkflow}
          title="Could not load pipeline"
          description={String(error)}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <PageHero
        icon={LuWorkflow}
        title="Pipeline"
        subtitle="How raw alerts become actionable incidents. Select a stage to see its algorithm and parameters."
      >
        <div className="flex flex-col items-end gap-1">
          <Text className="text-xs text-gray-600">Load a dataset</Text>
          <DataSourceButtons />
        </div>
      </PageHero>

      <EnginePipelineSection />

      <h2 className="text-sm font-bold text-gray-900 -mb-2">Loaded dataset pipeline</h2>

      {stages.length === 0 ? (
        <Card>
          <EmptyStateCard
            noCard
            icon={LuWorkflow}
            title="No alert batch loaded"
            description="Load one of the datasets above to run the pipeline."
          />
        </Card>
      ) : (
        <>
          <div className="flex items-center justify-between -mb-1">
            <Text className="text-xs text-gray-600">
              {openStages.size} of {stages.length} stages expanded
            </Text>
            <button
              onClick={() =>
                setOpenStages(
                  openStages.size === stages.length
                    ? new Set()
                    : new Set(stages.map((s) => s.id))
                )
              }
              className="rounded-full border border-green-200 bg-white px-3 py-1 text-xs font-semibold text-green-700 hover:bg-green-50 transition-colors"
            >
              {openStages.size === stages.length ? "Collapse all" : "Expand all"}
            </button>
          </div>

          {/* Equal-height cards per row (the default grid stretch) so rows
              read as a table, not a ragged masonry. Expand all to see the
              aligned layout; a single expanded card stretches its row-mates. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
            {stages.map((stage, i) => (
              <StageCard
                key={stage.id}
                stage={stage}
                index={i}
                isOpen={openStages.has(stage.id)}
                onToggle={() =>
                  setOpenStages((prev) => {
                    const next = new Set(prev);
                    if (next.has(stage.id)) next.delete(stage.id);
                    else next.add(stage.id);
                    return next;
                  })
                }
              />
            ))}
          </div>

          <Card className="p-4">
            <Title className="text-base mb-2">Run log</Title>
            <div className="flex flex-col gap-1 font-mono text-xs">
              {stages.map((s, i) => (
                <div key={s.id} className="flex gap-2">
                  <span className="text-gray-400 shrink-0">
                    [{String(i + 1).padStart(2, "0")}]
                  </span>
                  <span>{s.logLine}</span>
                </div>
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
