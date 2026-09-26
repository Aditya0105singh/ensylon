"use client";

import { PageHero } from "@/shared/ui";
import { EngineBenchmarkCard } from "@/entities/engine/EngineBenchmarkCard";
import { HiOutlineShieldCheck } from "react-icons/hi2";

export function EvaluationClient() {
  return (
    <div className="flex flex-col gap-4 p-4 h-full">
      <PageHero
        icon={HiOutlineShieldCheck}
        title="Evaluation"
        subtitle="The live streams carry no answer key, so correlation quality is measured offline: the same engine code on generated estates with injected incidents, tuned on seeds 1-20 and reported on held-out seeds 21-40."
      />
      <EngineBenchmarkCard />
      <div className="rounded-2xl border border-gray-200 bg-white p-4 text-xs text-gray-700 space-y-1">
        <p><b>Pair precision / recall / F1:</b> for every pair of signals, did the engine decide correctly whether they belong to the same incident.</p>
        <p><b>Root-cause accuracy:</b> share of incidents whose suspected root-cause service is the injected fault.</p>
        <p>
          Generated data is used only here, to measure. It never enters the live engine: at runtime the three Nexus streams are the only
          input.
        </p>
      </div>
    </div>
  );
}
