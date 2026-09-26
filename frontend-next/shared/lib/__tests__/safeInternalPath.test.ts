/**
 * Open-redirect guard for the sign-in callback.
 *
 * middleware.ts resolves `?callbackUrl=` with `new URL(candidate, request.url)`,
 * which returns an absolute candidate unchanged — so an unvalidated value let
 * `/signin?callbackUrl=https://evil.example` bounce a visitor off-site from a
 * link on our own domain. In NO_AUTH mode every visitor reaches that branch.
 */
import { safeInternalPath } from "@/shared/lib/safeInternalPath";

describe("safeInternalPath", () => {
  const FALLBACK = "/incidents";

  it("keeps an ordinary internal path", () => {
    expect(safeInternalPath("/alerts/feed", FALLBACK)).toBe("/alerts/feed");
  });

  it("keeps a path with a query string", () => {
    expect(safeInternalPath("/incidents?tab=open", FALLBACK)).toBe(
      "/incidents?tab=open"
    );
  });

  it.each([
    ["an absolute http URL", "http://evil.example"],
    ["an absolute https URL", "https://evil.example/path"],
    ["a protocol-relative URL", "//evil.example"],
    ["a backslash-smuggled host", "/\\evil.example"],
    ["a mixed slash-backslash host", "/\\/evil.example"],
    ["a javascript scheme", "javascript:alert(1)"],
    ["a data scheme", "data:text/html,<script>alert(1)</script>"],
    ["a scheme-relative host with credentials", "//user:pass@evil.example"],
  ])("rejects %s", (_label, candidate) => {
    expect(safeInternalPath(candidate, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for null, undefined and empty input", () => {
    expect(safeInternalPath(null, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath(undefined, FALLBACK)).toBe(FALLBACK);
    expect(safeInternalPath("", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects a bare relative path that is not rooted", () => {
    expect(safeInternalPath("incidents", FALLBACK)).toBe(FALLBACK);
  });
});
