import type { Color } from "@tremor/react";

/**
 * Backend timestamps are naive ISO strings with no timezone suffix
 * (e.g. "2026-07-16T10:35:32"). `new Date()` treats those as local time,
 * which is what the old AlertLens UI did too — keep that behaviour so
 * relative times stay consistent with the data the engine produced.
 */
export const parseTimestamp = (ts: string): Date => new Date(ts);

export const timeAgo = (ts: string): string => {
  const then = parseTimestamp(ts).getTime();
  if (Number.isNaN(then)) return "unknown";

  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
};

export const formatTimestamp = (ts: string): string => {
  const d = parseTimestamp(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
};

/** Risk level -> Tremor colour, shared by cluster/incident views. */
export const riskColor = (level: string): Color => {
  switch (level?.toLowerCase()) {
    case "high":
      return "red";
    case "medium":
      return "amber";
    case "low":
      return "emerald";
    default:
      return "gray";
  }
};
