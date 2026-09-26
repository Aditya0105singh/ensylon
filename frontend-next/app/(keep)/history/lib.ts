import type { ArchivedIncident, DraftStatus } from "@/entities/engine/types";

export const STATUS_META: Record<DraftStatus, { label: string; cls: string }> = {
  awaiting_review: { label: "Awaiting sign-off", cls: "bg-amber-100 text-amber-800 border-amber-200" },
  published: { label: "Approved", cls: "bg-green-100 text-green-800 border-green-200" },
  rejected: { label: "Rejected", cls: "bg-gray-100 text-gray-700 border-gray-200" },
  merged: { label: "Merged", cls: "bg-blue-50 text-blue-800 border-blue-200" },
};

export const ACTION_LABEL: Record<string, string> = {
  raised: "Raised by the engine",
  updated: "Grew",
  approve: "Approved",
  edit_and_approve: "Edited and approved",
  reject: "Rejected",
  resolve: "Marked resolved",
  merge: "Merged",
};

const DAY = 86_400_000;
const utcDay = (iso: string) => Date.UTC(new Date(iso).getUTCFullYear(), new Date(iso).getUTCMonth(), new Date(iso).getUTCDate());

/** "Today · Sat 26 Sep", "Yesterday · Fri 25 Sep", "Thu 24 Sep" - by UTC day, like every clock in the app. */
export function dayLabel(iso: string, now = Date.now()): string {
  const date = new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const diff = Math.round((utcDay(new Date(now).toISOString()) - utcDay(iso)) / DAY);
  if (diff === 0) return `Today · ${date}`;
  if (diff === 1) return `Yesterday · ${date}`;
  return date;
}

export const hhmm = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** 95 s -> "2 min", 5400 s -> "1 h 30 min", 2 days -> "2 d 3 h". */
export function duration(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return "under a minute";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

/** Time from the engine raising the incident to a human deciding it. */
export const timeToDecision = (i: ArchivedIncident) =>
  i.decided_at ? Date.parse(i.decided_at) - Date.parse(i.raised_at) : null;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Incidents grouped by the UTC day they started, newest day first. */
export function groupByDay(items: ArchivedIncident[], now = Date.now()): { day: string; items: ArchivedIncident[] }[] {
  const groups = new Map<string, ArchivedIncident[]>();
  [...items]
    .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
    .forEach((i) => {
      const key = dayLabel(i.started_at, now);
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
  return Array.from(groups, ([day, items]) => ({ day, items }));
}
