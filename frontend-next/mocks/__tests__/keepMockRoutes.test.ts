import { isKeepOnlyPath, resolveMock } from "../keepMockRoutes";

const search = new URLSearchParams();

/**
 * Every endpoint the AlertLens FastAPI backend actually serves
 * (backend/app/main.py). None of these may ever resolve to demo data — if one
 * did, the affected page would silently show fabricated numbers instead of
 * real engine output, with nothing failing loudly to reveal it.
 */
const ALERTLENS_ENDPOINTS = [
  "ingest",
  "demo/load",
  "demo/load-bgl",
  "pipeline",
  "alerts/abc-123/ack",
  "alerts/abc-123/assign",
  "alerts/abc-123/dismiss",
  "alerts/abc-123/escalate",
  "forecast/3",
  "incidents/3/comparison",
  "incidents/3/correlation",
  "incidents/3/ticket",
  "incidents/3/root_cause_confidence",
  "incidents/3/playbook",
  "evaluation",
  "debug/summarizer-check",
  "assistant",
  "assistant/workspace",
  "providers",
  "providers/abc-123/test",
  "workflows",
  "workflows/abc-123",
  "notifications",
  "settings/status",
  "rules/config",
  "maintenance",
  "maintenance/abc-123",
];

/** KeepHQ's own surface, which AlertLens's backend does not implement. */
const KEEP_ONLY_ENDPOINTS = [
  "healthcheck",
  "deduplications",
  "preset",
  "tags",
  "auth/users",
  "alerts/query",
];

describe("keep mock routing", () => {
  describe("does not shadow the AlertLens backend", () => {
    it.each(ALERTLENS_ENDPOINTS)(
      "routes /%s to the real backend",
      (path) => {
        expect(isKeepOnlyPath(path)).toBe(false);
        expect(resolveMock(path, search)).toBeNull();
      }
    );

    it("keeps alert actions separate from Keep's alert search", () => {
      // Both live under /alerts. Only the exact query path is Keep's.
      expect(isKeepOnlyPath("alerts/query")).toBe(true);
      expect(isKeepOnlyPath("alerts/abc-123/ack")).toBe(false);
      // An id that happens to start with "query" must still reach the backend.
      expect(isKeepOnlyPath("alerts/query-1/ack")).toBe(false);
    });

    it("does not treat an incident insight path as Keep's incident meta", () => {
      expect(isKeepOnlyPath("incidents/meta")).toBe(true);
      expect(isKeepOnlyPath("incidents/3/playbook")).toBe(false);
    });

    it("matches only on a full path segment", () => {
      // "providers" is real (FastAPI) now; "provider-images" is still
      // Keep's own asset store, but a longer word starting with it is not.
      expect(isKeepOnlyPath("providers")).toBe(false);
      expect(isKeepOnlyPath("providers/oauth2")).toBe(false);
      expect(isKeepOnlyPath("provider-images")).toBe(true);
      expect(isKeepOnlyPath("provider-images-extra")).toBe(false);
    });
  });

  describe("serves Keep's own surface", () => {
    it.each(KEEP_ONLY_ENDPOINTS)("resolves /%s to demo data", (path) => {
      expect(isKeepOnlyPath(path)).toBe(true);
      expect(resolveMock(path, search)).not.toBeNull();
    });

    it("returns alerts, not presets, for /preset/{name}/alerts", () => {
      const presets = resolveMock("preset", search) as unknown[];
      const alerts = resolveMock("preset/feed/alerts", search) as unknown[];
      expect(presets.length).toBeGreaterThan(0);
      expect(alerts).toEqual([]);
    });
  });

  it("tolerates a leading slash", () => {
    expect(isKeepOnlyPath("/provider-images")).toBe(true);
    expect(isKeepOnlyPath("/pipeline")).toBe(false);
  });

  it("returns null for anything unknown", () => {
    expect(resolveMock("not/a/real/path", search)).toBeNull();
  });
});
