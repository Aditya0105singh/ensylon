"use client";

import { HiOutlinePlayCircle } from "react-icons/hi2";
import { useStreamStatus } from "@/entities/engine/useEngine";

const when = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC"
    : "an earlier session";

/** Full-width, on every page, whenever a recording is playing instead of the
 * live streams. A demo must never pass a replay off as live. */
export function ReplayBanner() {
  const { data: status } = useStreamStatus();
  const replay = status?.replay;
  if (!replay?.active) return null;
  const pct = replay.total ? Math.round(((replay.played ?? 0) / replay.total) * 100) : 0;
  return (
    <div
      role="status"
      aria-label="Replay"
      className="mx-4 mb-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-2.5 text-amber-900"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <HiOutlinePlayCircle className="w-5 h-5 shrink-0" />
        <b className="tracking-wide">REPLAY · not live</b>
        <span className="text-xs">
          Recorded from the Nexus streams on {when(replay.recorded_at)} and played through the same pipeline
          {replay.speed && replay.speed !== 1 ? ` at ${replay.speed}×` : ""}. Signals were redacted before they were recorded.
        </span>
        <span className="ml-auto text-xs font-semibold tabular-nums">
          {replay.finished ? "finished" : `${(replay.played ?? 0).toLocaleString("en-US")} / ${(replay.total ?? 0).toLocaleString("en-US")} signals`}
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full rounded-full bg-amber-200 overflow-hidden" aria-hidden>
        <div className="h-full bg-amber-500 transition-[width] duration-700" style={{ width: `${replay.finished ? 100 : pct}%` }} />
      </div>
    </div>
  );
}
