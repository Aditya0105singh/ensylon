"""Trust boundary for the HTTP surface — authentication, rate limiting, size caps.

Everything deciding *whether a request may run at all* lives here, so the
boundary can be audited in one file instead of inferred from forty route
decorators.

**Authentication** is a shared key in `X-API-Key`, compared in constant time.
Deliberately not a user login: the engine has no user model, and inventing one
would be a larger claim than the system can back. What the key does is make the
write surface — ingest, approve, reject, maintenance windows — unreachable by
anyone who was not given it.

The default is the part that matters. With no key configured, requests are
served only from the loopback interface: a laptop demo works with zero setup,
while the same build deployed to a public host refuses every remote request
until an operator sets a key. Insecure-by-default is how a demo becomes an
incident, so the unconfigured state fails closed for anyone who is not local.

**Rate limiting** is in-process and per-client — enough to stop an anonymous
caller draining an LLM quota or hammering the pipeline, not a distributed quota
system. Local clients are exempt unless `ALERTLENS_RATE_LIMIT_FORCE` is set,
because the target is remote abuse; a limiter that fires midway through a test
suite or a live demo click-through is a liability rather than a control.

**Body size** is capped from `Content-Length`. A client omitting it (chunked
encoding) is caught instead by the per-handler item caps in `main.py` and
`engine_api.py`. A byte-exact streaming cap belongs in the reverse proxy
(nginx `client_max_body_size`), not in application code.

Every limit reads its environment variable at request time rather than import
time, so a deployment can be reconfigured — and a test can set one — without
reimporting the app.
"""

from __future__ import annotations

import hmac
import ipaddress
import os
import threading
import time

from fastapi import HTTPException, Request, status
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

# Non-address hostnames treated as "the machine running the demo".
# `testclient` is what Starlette's TestClient reports; it is not a routable
# address, so it cannot arrive from a network. Real loopback addresses are
# recognised by parsing, not by listing — see is_local.
_LOCAL_NAMES = frozenset({"localhost", "testclient"})

# Reachable without a key so an orchestrator can health-check a locked-down
# deployment. Returns no incident data — see main.py:health.
_PUBLIC_PATHS = frozenset({"/health"})

# The LLM-backed routes. Each one spends money per call on an upstream provider,
# so they get a much tighter budget than the rest of the API.
_EXPENSIVE_PATHS = frozenset({"/assistant", "/assistant/workspace", "/debug/summarizer-check"})

DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024   # 2 MiB
DEFAULT_RATE_LIMIT = 300                   # requests per window, per client
DEFAULT_EXPENSIVE_RATE_LIMIT = 15          # LLM-backed routes, per client
RATE_LIMIT_WINDOW_SECONDS = 60


# --------------------------------------------------------------------------
# configuration
# --------------------------------------------------------------------------


def api_key() -> str:
    """The configured shared key, or "" when authentication is unconfigured."""
    return os.environ.get("ALERTLENS_API_KEY", "").strip()


def max_body_bytes() -> int:
    raw = os.environ.get("ALERTLENS_MAX_BODY_BYTES", "").strip()
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    return DEFAULT_MAX_BODY_BYTES


def _rate_limit_for(path: str) -> int:
    if path in _EXPENSIVE_PATHS:
        raw = os.environ.get("ALERTLENS_EXPENSIVE_RATE_LIMIT", "").strip()
        default = DEFAULT_EXPENSIVE_RATE_LIMIT
    else:
        raw = os.environ.get("ALERTLENS_RATE_LIMIT", "").strip()
        default = DEFAULT_RATE_LIMIT
    if raw.isdigit() and int(raw) > 0:
        return int(raw)
    return default


def allowed_origins() -> list[str]:
    """Browser origins permitted to call the API cross-origin.

    Empty by default in a deployment, because the frontend talks to this API
    from its own server (Next.js rewrites `/backend/*` server-side), so no
    browser ever needs a cross-origin grant. The localhost defaults exist only
    so someone poking at the API from a dev tool on their own machine is not
    mystified by a CORS failure.
    """
    configured = os.environ.get("ALERTLENS_ALLOWED_ORIGINS", "").strip()
    if configured:
        return [origin.strip() for origin in configured.split(",") if origin.strip()]
    return [
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://localhost:3001",
        "http://127.0.0.1:3001",
    ]


def is_local(request: Request) -> bool:
    """True when the request came from the machine running the backend.

    The host is parsed as an address rather than compared against a list,
    because one loopback connection arrives under several spellings: `127.0.0.1`
    from curl, `::1` from a client that resolved localhost to IPv6, and
    `::ffff:127.0.0.1` — IPv4-mapped IPv6 — from Node, which is what the
    frontend's server-side proxy uses. A hardcoded set covered the first two and
    silently rejected the third, so the zero-config local demo broke while every
    unit test still passed. Parsing is the version that is actually true.
    """
    host = (request.client.host if request.client else "") or ""
    if host in _LOCAL_NAMES:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    # An IPv4-mapped IPv6 address carries the real IPv4 address inside it, and
    # is_loopback on the wrapper does not look through the mapping.
    mapped = getattr(address, "ipv4_mapped", None)
    if mapped is not None:
        address = mapped
    return address.is_loopback


# --------------------------------------------------------------------------
# rate limiting
# --------------------------------------------------------------------------


class _FixedWindowCounter:
    """Per-key request counter over a fixed window.

    Fixed window rather than a sliding log because the failure mode being
    prevented is a flood, and a flood trips either design instantly. Entries
    are evicted lazily so an attacker rotating source addresses cannot grow
    the table without bound.
    """

    def __init__(self) -> None:
        self._hits: dict[str, tuple[float, int]] = {}
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_seconds: int) -> bool:
        now = time.monotonic()
        with self._lock:
            if len(self._hits) > 4096:
                cutoff = now - window_seconds
                self._hits = {
                    k: v for k, v in self._hits.items() if v[0] > cutoff
                }
            started, count = self._hits.get(key, (now, 0))
            if now - started >= window_seconds:
                started, count = now, 0
            count += 1
            self._hits[key] = (started, count)
            return count <= limit

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


_counter = _FixedWindowCounter()


def reset_rate_limits() -> None:
    """Clear all counters. Used between tests."""
    _counter.reset()


def _rate_limited(request: Request) -> bool:
    """True when this request should be rejected as too frequent."""
    if is_local(request) and not os.environ.get("ALERTLENS_RATE_LIMIT_FORCE", "").strip():
        return False
    host = (request.client.host if request.client else "unknown") or "unknown"
    path = request.url.path
    bucket = "expensive" if path in _EXPENSIVE_PATHS else "default"
    limit = _rate_limit_for(path)
    return not _counter.allow(f"{bucket}:{host}", limit, RATE_LIMIT_WINDOW_SECONDS)


# --------------------------------------------------------------------------
# middleware
# --------------------------------------------------------------------------


class SecurityMiddleware(BaseHTTPMiddleware):
    """Authenticate, rate limit and size-check before a route ever runs."""

    async def dispatch(self, request: Request, call_next):
        path = request.url.path

        # CORS preflight carries no credentials by design; the CORS middleware
        # answers it. Rejecting it here would break legitimate browser calls.
        if request.method == "OPTIONS":
            return await call_next(request)

        if path in _PUBLIC_PATHS:
            return await call_next(request)

        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > max_body_bytes():
            # Literal 413 rather than the named constant: Starlette renamed it
            # mid-range of the versions requirements.txt allows, so either name
            # is a deprecation warning on some supported install.
            return JSONResponse(
                status_code=413,
                content={"detail": f"request body exceeds {max_body_bytes()} bytes"},
            )

        key = api_key()
        if key:
            supplied = request.headers.get("x-api-key", "")
            # compare_digest over bytes, so a non-ASCII header cannot raise.
            if not hmac.compare_digest(supplied.encode("utf-8"), key.encode("utf-8")):
                return JSONResponse(
                    status_code=status.HTTP_401_UNAUTHORIZED,
                    content={"detail": "missing or invalid X-API-Key"},
                )
        elif not is_local(request):
            return JSONResponse(
                status_code=status.HTTP_403_FORBIDDEN,
                content={
                    "detail": (
                        "this deployment is reachable remotely but has no "
                        "ALERTLENS_API_KEY configured, so it refuses non-local "
                        "requests. Set ALERTLENS_API_KEY on the backend and send "
                        "it as X-API-Key."
                    )
                },
            )

        if _rate_limited(request):
            return JSONResponse(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                content={"detail": "rate limit exceeded; slow down"},
            )

        return await call_next(request)


# --------------------------------------------------------------------------
# handler-level guards
# --------------------------------------------------------------------------


def require_items(items: list, limit: int, what: str) -> None:
    """Reject an oversized collection before it reaches the pipeline or the DB.

    The body-size middleware stops the obvious flood; this stops the subtler
    one, where a small compressed payload expands into a large list, and it is
    the only cap that applies to a client that omits Content-Length.
    """
    if len(items) > limit:
        raise HTTPException(
            status_code=413,
            detail=f"too many {what}: {len(items)} exceeds the limit of {limit}",
        )
