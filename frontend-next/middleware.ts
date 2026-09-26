import { NextResponse } from "next/server";
import { getApiURL } from "@/utils/apiUrl";
import { isKeepOnlyPath } from "@/mocks/keepMockRoutes";
import { config as authConfig } from "@/auth.config";
import { safeInternalPath } from "@/shared/lib/safeInternalPath";
import NextAuth from "next-auth";

const { auth } = NextAuth(authConfig);

// Helper function to detect mobile devices
function isMobileDevice(userAgent: string): boolean {
  return /Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/.test(
    userAgent
  );
}

/**
 * Read an env var without webpack's DefinePlugin inlining it.
 *
 * Same reason as auth.config.ts: this file runs in the Edge Runtime, where a
 * direct `process.env.X` is replaced with its build-time value — `undefined`
 * for anything supplied only at runtime.
 */
function runtimeEnv(key: string): string | undefined {
  return process.env[key];
}

export const middleware = auth(async (request) => {
  const { pathname, searchParams } = request.nextUrl;

  // go to temporary placeholder for mobile devices
  const userAgent = request.headers.get("user-agent") || "";
  if (
    isMobileDevice(userAgent) &&
    !pathname.startsWith("/mobile") &&
    process.env.KEEP_READ_ONLY === "true"
  ) {
    return NextResponse.redirect(new URL("/mobile", request.url));
  }

  const session = await auth();
  const role = session?.userRole;
  const isAuthenticated = !!request.auth;
  // Keep it on header so it can be used in server components
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-url", request.url);
  // Handle legacy /backend/ redirects (when API_URL is not set and frontend act as a proxy)
  if (pathname.startsWith("/backend/")) {
    const backendPath = pathname.slice("/backend/".length);
    const queryString = searchParams.toString();

    // KeepHQ-native endpoints AlertLens's backend doesn't implement are served
    // from demo data so those pages render instead of hanging. Everything else
    // — the whole AlertLens engine surface — proxies to FastAPI as before.
    if (isKeepOnlyPath(backendPath)) {
      const mockURL = new URL(`/api/mock/${backendPath}`, request.url);
      if (queryString) mockURL.search = queryString;
      return NextResponse.rewrite(mockURL);
    }

    const apiUrl = getApiURL();
    const newURL = pathname.replace("/backend/", apiUrl + "/");
    const urlWithQuery = queryString ? `${newURL}?${queryString}` : newURL;

    // The backend authenticates with a shared key. Attaching it here — on the
    // server side of this proxy — is what keeps it out of the browser: the key
    // is never sent to the client, so it cannot be read out of devtools or a
    // page bundle. Any client-supplied value is dropped first so a caller
    // cannot smuggle its own key through.
    const backendHeaders = new Headers(request.headers);
    backendHeaders.delete("x-api-key");
    const backendKey = runtimeEnv("ALERTLENS_API_KEY");
    if (backendKey) {
      backendHeaders.set("x-api-key", backendKey);
    }

    return NextResponse.rewrite(urlWithQuery, {
      request: { headers: backendHeaders },
    });
  }

  // Allow mobile route to pass through
  if (pathname.startsWith("/mobile")) {
    return NextResponse.next();
  }

  // If not authenticated and not on signin page, redirect to signin
  if (
    !isAuthenticated &&
    !pathname.startsWith("/signin") &&
    !pathname.startsWith("/error") &&
    !pathname.startsWith("/api/healthcheck")
  ) {
    // A relative path (not request.nextUrl.href) so it resolves against
    // whatever origin the browser actually used - Next's own host detection
    // is unreliable behind a reverse proxy (e.g. a cloudflared tunnel) that
    // doesn't forward the original Host header.
    const redirectTo =
      `${request.nextUrl.pathname}${request.nextUrl.search}` || "/incidents";
    console.log(
      `Redirecting ${pathname} to signin page because user is not authenticated`
    );
    // Encoded, so a path containing `&` or `#` cannot append extra parameters
    // to the sign-in URL we are building.
    return NextResponse.redirect(
      new URL(
        `/signin?callbackUrl=${encodeURIComponent(redirectTo)}`,
        request.url
      )
    );
  }

  // If authenticated and on signin page, redirect to incidents
  if (isAuthenticated && pathname.startsWith("/signin")) {
    const redirectTo = safeInternalPath(
      request.nextUrl.searchParams.get("callbackUrl"),
      "/incidents"
    );
    console.log(
      `Redirecting to ${redirectTo} because user try to get /signin but already authenticated`
    );
    return NextResponse.redirect(new URL(redirectTo, request.url));
  }

  // Role-based routing (NOC users)
  if (role === "noc" && !pathname.startsWith("/alerts")) {
    return NextResponse.redirect(new URL("/alerts/feed", request.url));
  }

  // Allow all other authenticated requests
  console.log("Allowing request to pass through", request.url);
  console.log("Request URL: ", request.url);

  return NextResponse.next({
    request: {
      // Apply new request headers
      headers: requestHeaders,
    },
  });
});

// Update the matcher to handle static files and public routes
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api (API routes)
     * - keep_big.svg (logo)
     * - keep.svg (logo)
     * - keep.png (logo)
     * - gnip.webp (logo)
     * - api/aws-marketplace (aws marketplace)
     * - api/auth (auth)
     * - monitoring (monitoring)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - icons (providers' logos)
     * - api/provider-images (provider icons)
     * - public static assets (png, jpg, jpeg, gif, webp, svg, ico)
     */
    "/((?!keep_big\\.svg$|keep\\.png$|gnip\\.webp|api/aws-marketplace$|api/auth|monitoring|_next/static|_next/image|sw\\.js|manifest\\.webmanifest|favicon\\.ico|icons|keep\\.svg|api/provider-images|.*\\.(?:png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
