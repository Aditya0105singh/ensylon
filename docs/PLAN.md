# Team SpaceX — plan and hand-off

See `docs/WORKPLAN.md` for the detailed task list and owners.

Read this first if you are picking the work up (a teammate, or a fresh Claude session).
It says what the challenge needs, what is done, what is left, and how to run and check everything.
The full brief is `problem-statement.html` in the repo root.

## 1. What we are building

Ensylon AIOps Challenge 2026. The system reads three live SSE signal streams and turns them into
reviewed incident tickets:

```
SSE streams → parse + redact PII → canonical schema → dedup → anomaly score
  → structural gate + 5-dimension similarity → DBSCAN → causal refinement → validation
  → impact severity (0-100) + correlation confidence (0-1)
  → Claude drafts the ticket → human approves / edits / rejects → output/tickets/
```

Hard rules from the organisers (do not break them):

1. **Redact PII before anything is processed or stored.** No raw PII in storage, logs or tickets.
2. **Time proximity alone does not prove correlation.** Group only on structural evidence.
3. **A ticket file is written only after explicit human approval.**
4. **The three streams are the only input.** The dependency graph endpoint is allowed. No synthetic,
   BGL or mock data at runtime.
5. **The Claude API key never goes in the repo.** Environment variable or a gitignored `.env`. A committed
   key counts as leaked.

Streams (`https://logs.nonprod.nexus.ensylon.com/sim/stream/`): `aiops-logs`, `aiops-cloudwatch`,
`aiops-grafana`. Graph: `/sim/reference/service-dependency-graph`. Everything else on that host is
password-protected — do not try to get around it.

## 2. Components and where they live

| | Requirement | Code |
|---|---|---|
| C1 | Parse, redact, normalise to the canonical schema | `backend/app/engine/live.py`, `nexus.py`, `redaction.py` |
| C2 | Anomaly score (0-1) with a documented threshold | `backend/app/engine/detect.py` |
| C3 | Correlation on ≥3 of T,S,D,E,C with formula, weights, window, merge threshold | `correlate.py`, `causal.py` |
| C4 | ≥2 validation checks; severity (0-100) and confidence (0-1) computed separately | `validate.py`, `severity.py` |
| C5 | Claude-drafted ticket, human review, write on approval | `drafting.py`, `claude_drafting.py`, `review.py`, `tickets.py` |

The exact formula, weights and thresholds are in the top-level `README.md` and on the in-app
"Correlation & Validation" page. **If you change a constant, change it in all three places.**

## 3. Status

**Done and tested (375 backend tests and 330 frontend tests pass; frontend typechecks):**

- Streaming runtime: one reader per stream, `Last-Event-ID` resume, reconnect with backoff, keepalives
  ignored, silence raises nothing. Micro-batch engine with a pending pool, cross-batch dedup, joins to
  open incidents, expiry of unmatched signals.
- Parsers for the three payload formats, PII redaction, canonical records, stream clock for Grafana
  (its payload has no timestamp).
- Five-dimension correlation with a structural gate, DBSCAN, causal refinement, four validation checks.
- Impact severity and correlation confidence, each shown with its parts.
- Ticket drafting: facts (computed) kept apart from the suspected root cause (Claude, worded as a
  hypothesis). Claude output is schema-constrained and grounding-checked; falls back to a template.
- Human review: Approve / Edit & approve / Reject. Files written to `output/tickets/` only after approval.
- UI: Overview (stream health, counters, charts), Signal Feed, Incidents & Review, Incident detail,
  Time Machine (replay of how an incident formed), Deduplication, Correlation & Validation, Service
  Topology, Evaluation, Settings.
- Past-incident library (`history_library.json`) is disabled at runtime: it described a synthetic estate and
  the streams are the only allowed input. It is consulted only when `AIOPS_OFFLINE_DEMO=1`.
- `tools/fake_nexus.py`: a local stand-in for the Nexus host, so the UI and pipeline can be exercised
  when the real streams are quiet.

**Not verified yet — do these first:**

1. **The real streams have only ever sent `:keepalive` so far.** Our parsers were written from the
   examples in the problem statement, not from real events. The moment real events arrive, compare them
   with `backend/app/engine/nexus.py` (log regex, CloudWatch and Grafana field names) and fix any
   mismatch. Check `GET /engine/stream/status` for `parse_errors`: it must stay 0.
2. **Claude drafting has never run against the real API** (no key was available). Set
   `ANTHROPIC_API_KEY`, approve nothing, and confirm the drafts on the Incident page say "written by
   Claude". Watch `Settings → Drafts written by Claude` versus `Fell back to template`.
3. **Thresholds are tuned on generated data**, not on the real streams. Once real signals flow, look at
   the score histogram and the incidents formed, and re-tune `EPS` (correlate.py) and detector
   thresholds if it over- or under-groups. Re-run the benchmark after any change.

## 4. Remaining work

Order = priority.

1. Verify against real events (section 3). Fix parsers if needed.
2. Put the Claude key in `.env` and check the drafting path end to end.
3. **Maintenance windows** on the live stream (engine supports them; not wired to the UI). Optional.
4. Rename leftovers: a few pages/tests/docs still say "AlertLens". `docs/DEMO_SCRIPT.md`,
   `docs/DEPLOY.md`, `render.yaml` describe the old app and are out of date. Rewrite or delete them.
5. Legacy code that is no longer reachable from the UI but still in the tree: `backend/app/main.py`
   batch routes (`/pipeline`, `/demo/*`, `/ingest`), `frontend-next/entities/alertlens`, the mock route
   `frontend-next/app/api/mock`. They are disabled unless `AIOPS_OFFLINE_DEMO=1`. Remove them if time
   allows; do not re-enable them for the evaluated run.
6. **Deck (Day 2).** Must cover: correlation formula, dimension weights, validation approach, scoring
   model, plus a live or recorded demo. Outline: problem → architecture → C1 redaction → C2 scoring →
   C3 formula and weights (with why) → C4 checks and the two scores → C5 human-in-the-loop → results
   (benchmark + live run) → limits and what we would do next. All numbers are in `README.md`.
7. Final check before submitting: fresh clone, follow the README from scratch, `pytest` green,
   `git grep -i "sk-ant"` returns nothing, `.env` not tracked.

## 5. Run it

See `README.md` for full setup. Short version:

```bash
# backend (real streams)
cd backend && pip install -r requirements.txt
python -m uvicorn app.main:app --port 8002

# frontend
cd frontend-next && npm ci && cp .env.local.example .env.local   # API_URL=http://127.0.0.1:8002, AUTH_TYPE=NO_AUTH
npm run dev -- -p 3002
```

Demo without the real streams (fake host on 9100, second backend on 8003):

```bash
python tools/fake_nexus.py --port 9100
cd backend && NEXUS_BASE_URL=http://127.0.0.1:9100 python -m uvicorn app.main:app --port 8003
# frontend: API_URL=http://127.0.0.1:8003
```

The fake plays a ~75 s scenario: a cascade (agency-db → payments → enrollment), repeated log lines, a
second unrelated incident (comms-service), a lone noise alarm on a service outside the graph (it stays pending, then expires as noise after 15 min of
stream time), and a late signal. Verified: 19 signals, 0 parse errors, 2 incidents.

Tests: `cd backend && python -m pytest -q` (offline, never calls the network or Claude) and
`cd frontend-next && npx jest`.

Windows notes: on this machine a stray `h2.py` in `%TEMP%` can shadow the `h2` package if you run Python
scripts from the temp folder; run from the repo. Next.js dev needs `NODE_OPTIONS=--max-old-space-size=6144`
with `--turbopack`, and a real `node_modules` (not a symlink/junction).

## 6. Working agreements

- Never commit `.env`, `.env.local`, keys, or `output/`. Check `git status` before every commit.
- Do not push to the organisers' repo (`ensylon/aiops_2026_spacex`) until the team agrees the submission
  is ready. This repo (`Aditya0105singh/ensylon`) is the working copy.
- Small commits, one topic each. Run `pytest` before pushing.
- Nothing may add synthetic or sample data to the runtime path. Generated data is for the offline
  benchmark and tests only.
- If you change the correlation formula or weights, re-run `GET /engine/benchmark` (Evaluation page)
  and update README + the Correlation page + the deck.

## 7. Key design decisions (for the deck)

- **Structural gate before scoring.** Two signals are only compared if they share a service, a graph edge
  within 2 hops, a component within 2 hops, or one names the other's service in its evidence.
  This is how we obey "time alone is not correlation".
- **Five dimensions, explicit weights** (T .25, S .20, D .20, E .20, C .15), merge threshold 0.34.
  Weights were tuned on seeds 1-20 and reported on held-out seeds 21-40 (F1 0.658, root cause 0.965).
- **Causal refinement** splits two independent roots whose evidence disagrees, keeps a cascade whole.
- **Validation is separate from scoring.** Four checks decide whether a candidate is raised at all.
- **Severity and confidence are two numbers, never blended.** Severity = blast radius, service criticality,
  anomaly magnitude. Confidence = density, topology support, evidence agreement.
- **Facts vs hypothesis in the ticket.** Facts are computed. Claude writes the summary, the suspected root
  cause (as a hypothesis) and steps, and is discarded if it names anything outside the incident.
- **Human gate is structural.** Approval mints a single-use token that the file writer requires; there is
  no other write path.
