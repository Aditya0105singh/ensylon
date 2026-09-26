/**
 * Constrain a redirect target to a path on this origin.
 *
 * `new URL(candidate, base)` resolves an absolute URL to itself, so passing a
 * caller-supplied `?callbackUrl=` straight into it turns a sign-in route into an
 * open redirect: `/signin?callbackUrl=https://evil.example` sends the visitor
 * off-site, from a link on our own domain. Only a rooted path is accepted, and
 * `//host` (protocol-relative) plus the backslash variants some browsers
 * normalise to slashes are rejected along with it.
 *
 * Lives here rather than in middleware.ts so it is testable: importing the
 * middleware pulls in `next/server`, which needs Edge Runtime globals.
 */
export function safeInternalPath(
  candidate: string | null | undefined,
  fallback: string
): string {
  if (!candidate || !candidate.startsWith("/")) return fallback;
  if (candidate.includes("\\")) return fallback;
  if (candidate.startsWith("//")) return fallback;
  return candidate;
}
