"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, ProgressBar, Text, Title } from "@tremor/react";
import clsx from "clsx";
import {
  LuCheck,
  LuChevronLeft,
  LuChevronRight,
  LuPause,
  LuPlay,
  LuRotateCcw,
} from "react-icons/lu";
import type { Cluster } from "@/entities/alertlens";
import {
  buildReplayTimeline,
  type TimelineCategory,
} from "@/entities/alertlens/lib/buildReplayTimeline";

const SPEEDS = [1, 2, 4] as const;
const STEP_MS = 2000;

const CATEGORY: Record<
  TimelineCategory,
  { label: string; dot: string; badge: string }
> = {
  alert: { label: "Alert", dot: "bg-gray-400", badge: "gray" },
  dedup: { label: "Dedup", dot: "bg-blue-500", badge: "blue" },
  root: { label: "Root cause", dot: "bg-red-500", badge: "red" },
  cluster: { label: "Correlation", dot: "bg-orange-500", badge: "orange" },
  spread: { label: "Cascade", dot: "bg-amber-500", badge: "amber" },
  dna: { label: "Alert DNA", dot: "bg-violet-500", badge: "violet" },
  final: { label: "Promoted", dot: "bg-emerald-500", badge: "emerald" },
};

/**
 * Steps through how the pipeline built this incident, one decision at a time.
 * Every event is derived from the incident itself — this replays the engine's
 * reasoning rather than simulating it.
 */
export function ReplayTimeline({ cluster }: { cluster: Cluster }) {
  const events = useMemo(() => buildReplayTimeline(cluster), [cluster]);

  const [stepIndex, setStepIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Restart whenever the incident changes.
  useEffect(() => {
    setStepIndex(0);
    setIsPlaying(false);
  }, [cluster.cluster_id]);

  useEffect(() => {
    if (!isPlaying || events.length === 0) return;
    const iv = setInterval(() => {
      setStepIndex((prev) => {
        if (prev >= events.length - 1) {
          setIsPlaying(false);
          return prev;
        }
        return prev + 1;
      });
    }, STEP_MS / speed);
    return () => clearInterval(iv);
  }, [isPlaying, speed, events.length]);

  // Keep the active step in view as playback advances.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [stepIndex]);

  if (events.length === 0) return null;

  const current = events[stepIndex] ?? events[0];
  const progress =
    events.length > 1 ? (stepIndex / (events.length - 1)) * 100 : 100;
  const atEnd = stepIndex >= events.length - 1;

  return (
    <Card className="p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Title className="text-base">Incident replay</Title>
          <Text className="text-xs text-gray-500">
            Step {stepIndex + 1} of {events.length} — how the pipeline built
            this incident.
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            color="emerald"
            variant={isPlaying ? "secondary" : "primary"}
            icon={atEnd ? LuRotateCcw : isPlaying ? LuPause : LuPlay}
            onClick={() => {
              if (atEnd) {
                setStepIndex(0);
                setIsPlaying(true);
              } else {
                setIsPlaying(!isPlaying);
              }
            }}
          >
            {atEnd ? "Replay" : isPlaying ? "Pause" : "Play"}
          </Button>
          <div className="flex items-center gap-1">
            {SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={clsx(
                  "text-xs px-2 py-1 rounded border",
                  speed === s
                    ? "border-green-400 text-green-600"
                    : "border-gray-200 text-gray-500"
                )}
              >
                {s}×
              </button>
            ))}
          </div>
        </div>
      </div>

      <ProgressBar value={progress} color="emerald" />

      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="light"
          color="gray"
          icon={LuChevronLeft}
          disabled={stepIndex === 0}
          onClick={() => {
            setIsPlaying(false);
            setStepIndex((i) => Math.max(0, i - 1));
          }}
        >
          Prev
        </Button>
        <Button
          size="xs"
          variant="light"
          color="gray"
          icon={LuChevronRight}
          iconPosition="right"
          disabled={atEnd}
          onClick={() => {
            setIsPlaying(false);
            setStepIndex((i) => Math.min(events.length - 1, i + 1));
          }}
        >
          Next
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* Step list */}
        <div className="lg:col-span-1 max-h-80 overflow-y-auto pr-1 flex flex-col gap-1">
          {events.map((e, i) => {
            const meta = CATEGORY[e.category];
            const isActive = i === stepIndex;
            const isPast = i < stepIndex;
            return (
              <button
                key={e.id}
                ref={isActive ? activeRef : undefined}
                type="button"
                onClick={() => {
                  setIsPlaying(false);
                  setStepIndex(i);
                }}
                className={clsx(
                  "flex items-start gap-2 text-left rounded px-2 py-1.5 border transition-colors",
                  isActive
                    ? "border-green-400 bg-green-50"
                    : "border-transparent hover:bg-gray-50",
                  !isActive && !isPast && "opacity-55"
                )}
              >
                {/* Past/active steps get a filled, checked marker; future
                    steps get a hollow outline — a glance down this column
                    should read as progress, not just a list of rows. */}
                <span
                  className={clsx(
                    "flex items-center justify-center w-4 h-4 rounded-full mt-0.5 shrink-0 transition-colors",
                    isActive || isPast
                      ? clsx(meta.dot, "text-white")
                      : "border-2 border-gray-300 bg-transparent"
                  )}
                >
                  {(isActive || isPast) && <LuCheck className="w-2.5 h-2.5" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-mono text-gray-400">
                    {e.time}
                  </span>
                  <span className="block text-sm truncate">{e.title}</span>
                </span>
              </button>
            );
          })}
        </div>

        {/* Current step detail */}
        <div className="lg:col-span-2">
          <Card className="p-4 h-full flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <Badge size="xs" color={CATEGORY[current.category].badge as never}>
                {CATEGORY[current.category].label}
              </Badge>
              <span className="text-xs font-mono text-gray-400">
                {current.time}
              </span>
            </div>

            <Title className="text-base">{current.title}</Title>

            <div>
              <Text className="text-xs uppercase tracking-wide text-gray-500">
                What happened
              </Text>
              <Text className="text-sm">{current.whatHappened}</Text>
            </div>

            <div>
              <Text className="text-xs uppercase tracking-wide text-gray-500">
                Why
              </Text>
              <Text className="text-sm">{current.whyItHappened}</Text>
            </div>

            <div className="mt-auto pt-2 border-t border-gray-200">
              <Text className="text-xs uppercase tracking-wide text-gray-500">
                Technique
              </Text>
              <Text className="text-xs font-mono">{current.algorithm}</Text>
            </div>
          </Card>
        </div>
      </div>
    </Card>
  );
}
