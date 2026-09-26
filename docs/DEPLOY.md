# Deploying AlertLens

Two processes: the FastAPI backend (holds the engine) and the Next.js frontend.
The frontend cannot run the engine on its own. A Vercel deployment without a
reachable backend only shows the mock/demo data paths, not Inject failure.

## Backend (any host that runs Python, e.g. Render, Railway, Fly, a VM)

```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

### Render (one-click via `render.yaml`)

The repo root has a `render.yaml` (Blueprint) that builds `backend/` as a Python web
service, health-checks `/pipeline`, and attaches a 1GB persistent disk at the backend's
working directory so `alertlens.db` — and with it the engine's event log — survives
restarts and deploys. In the Render dashboard: **New > Blueprint**, point it at this repo,
and it reads `render.yaml` automatically. Free-tier services sleep after inactivity; the
first request after a sleep takes a few seconds to wake up.

- Needs the repo's `data/` folder next to `backend/` (the synthetic generator and BGL loader import from it).
- State: the dataset pipeline and the engine event log persist to `backend/alertlens.db`
  (SQLite). On a host with an ephemeral disk the engine run is rebuilt from the log only if
  the file survives a restart; otherwise just click Inject failure again (it is deterministic).
- Optional environment variables: an LLM key for grounded narratives (see `backend/app/summarizer.py`
  for the provider variables). Without one, drafts use the deterministic template.

### Authentication (required for any networked deployment)

The backend authenticates with a shared key. **Set `ALERTLENS_API_KEY` on the backend
and the same value on the frontend**, which attaches it server-side when proxying
`/backend/*` so it never reaches the browser.

```bash
openssl rand -hex 32     # use the output for both sides
```

With no key set, the backend serves the loopback interface only and answers every
remote request with a 403 naming the variable to set. That is deliberate: a laptop
demo needs no configuration, and a deployment cannot end up quietly world-writable.
`render.yaml` generates a key automatically — copy it from the Render dashboard into
the frontend's `ALERTLENS_API_KEY`.

`/health` is the one unauthenticated route (liveness only, no incident data), so
health checks work against a locked-down instance.

Also configurable, with safe defaults: `ALERTLENS_ALLOWED_ORIGINS` (CORS, defaults to
localhost — the frontend needs no entry since it proxies server-side),
`ALERTLENS_MAX_BODY_BYTES` (2 MiB), `ALERTLENS_RATE_LIMIT` (300/min per client) and
`ALERTLENS_EXPENSIVE_RATE_LIMIT` (15/min on the LLM-backed routes). See `.env.example`.

## Frontend (Vercel or `next start`)

Set these environment variables:

| Variable | Value |
|---|---|
| `API_URL` | the backend's public URL, e.g. `https://alertlens-api.onrender.com` |
| `ALERTLENS_API_KEY` | the same value set on the backend. Never prefix it `NEXT_PUBLIC_` |
| `AUTH_TYPE` | `NO_AUTH` |
| `NEXTAUTH_SECRET` | a long random string — it signs session JWTs, so do not ship a placeholder |
| `PUSHER_DISABLED`, `POSTHOG_DISABLED`, `SENTRY_DISABLED` | `true` |

Then `npm run build` (Vercel does this) and start.

## Before showing it

1. Open the frontend, click **Inject failure**. If it errors, `API_URL` is wrong or the backend is asleep (free tiers sleep; hit it once first).
2. `GET <backend>/health` should return `{"status":"ok"}` without a key.
3. `GET <backend>/engine/queue` with `X-API-Key` should list one incident after the click —
   and the same call *without* the header should return 401. If it returns data, the key is
   not set on the backend.
4. Keep the Jira transport on the mock until you have real credentials (see the README's Mock vs real table).
