import * as data from "./keepMockData";

type Resolver = (path: string, search: URLSearchParams) => unknown;

/**
 * Endpoints that belong to KeepHQ's own product surface and have no equivalent
 * in the AlertLens FastAPI backend. Requests to these are served from demo data
 * so KeepHQ's pages render their real UI instead of hanging on a 404.
 *
 * This table is the single source of truth: a path is treated as Keep-only if
 * and only if it resolves here. Everything else falls through to FastAPI.
 *
 * DANGER: never add a prefix that shadows a real AlertLens endpoint. The
 * backend owns `/ingest`, `/demo/*`, `/pipeline`, `/alerts/{id}/ack|assign|
 * dismiss|escalate`, `/forecast/{id}`, `/incidents/{id}/comparison|
 * root_cause_confidence|playbook`, `/evaluation`, `/debug/*`, `/assistant*`
 * (including `/assistant/workspace`), `/providers` (CRUD +
 * `/providers/{id}/test`), `/workflows` (CRUD), `/notifications`,
 * `/settings/status`, `/rules/config` and `/maintenance` (CRUD). Shadowing
 * any of those would silently replace engine output with demo data.
 */
const ROUTES: [string, Resolver][] = [
  // Keep's ApiClient probes this; a 404 makes every page show
  // "API server is not available".
  ["healthcheck", () => ({ status: "ok" })],

  // Provider logos live in Keep's own storage; no equivalent here. Real
  // provider CRUD (/providers, /providers/{id}/test) is served by FastAPI now.
  ["provider-images", () => []],

  ["deduplications", () => data.DEDUPLICATION_RULES],
  [
    "preset",
    (path) =>
      // /preset/{name}/alerts returns alerts, not presets. AlertLens's own
      // alert views read /pipeline, so an empty list is correct here.
      path.endsWith("/alerts") ? [] : data.PRESETS,
  ],
  ["tags", () => data.TAGS],

  // Still real: alert-assignee.tsx (a widget consumed by widgets/alerts-table)
  // resolves assignee emails to a display name/picture via this. Everything
  // else under auth/* and settings/* was fake RBAC with no real feature
  // behind it, and has been removed along with the Settings page's old
  // user/role/group/API-key management UI.
  ["auth/users", () => data.USERS],

  // Keep's own alert search. Safe as an exact path: it cannot match
  // AlertLens's /alerts/{id}/ack|assign|dismiss|escalate, which stay on
  // FastAPI. AlertLens's own alert views use /pipeline, not this.
  ["alerts/query", () => ({ count: 0, results: [], limit: 20, offset: 0 })],
  ["alerts/facets", () => []],
  ["incidents/meta", () => ({})],
];

const normalize = (path: string) => path.replace(/^\/+/, "");

/** Longest matching prefix, so `/workflows/executions` beats `/workflows`. */
const matchRoute = (path: string): [string, Resolver] | null => {
  const p = normalize(path);
  const matches = ROUTES.filter(
    ([prefix]) => p === prefix || p.startsWith(`${prefix}/`)
  );
  if (matches.length === 0) return null;
  return matches.sort((a, b) => b[0].length - a[0].length)[0];
};

export const isKeepOnlyPath = (path: string): boolean =>
  matchRoute(path) !== null;

export const resolveMock = (
  path: string,
  search: URLSearchParams
): unknown | null => {
  const match = matchRoute(path);
  return match ? match[1](normalize(path), search) : null;
};
