import { NextRequest, NextResponse } from "next/server";
import { resolveMock } from "@/mocks/keepMockRoutes";

/**
 * Serves demo data for KeepHQ-native endpoints AlertLens's backend does not
 * implement. Middleware rewrites those `/backend/*` calls here; everything
 * else still proxies to FastAPI.
 */
async function handle(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  const joined = (path ?? []).join("/");
  const data = resolveMock(joined, request.nextUrl.searchParams);

  if (data === null) {
    return NextResponse.json(
      { detail: `No demo data for /${joined}` },
      { status: 404 }
    );
  }

  return NextResponse.json(data);
}

export const GET = handle;

/**
 * Some Keep list views POST a query and expect a result envelope back
 * (e.g. /workflows/query). Those still resolve to demo data.
 */
const isQueryEndpoint = (path: string) =>
  path.endsWith("/query") ||
  path.endsWith("/search") ||
  path.endsWith("/facets/options");

/**
 * Other writes are accepted but not persisted — these pages are demo surfaces,
 * so a mutation echoes back rather than 500-ing and breaking the UI flow.
 */
async function accept(
  request: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
) {
  const { path } = await ctx.params;
  const joined = (path ?? []).join("/");

  if (isQueryEndpoint(joined)) {
    const data = resolveMock(joined, request.nextUrl.searchParams);
    if (data !== null) return NextResponse.json(data);
  }

  let body: unknown = null;
  try {
    body = await request.json();
  } catch {
    // no body, fine
  }
  return NextResponse.json({
    ok: true,
    demo: true,
    path: joined,
    received: body,
  });
}

export const POST = accept;
export const PUT = accept;
export const PATCH = accept;
export const DELETE = accept;
