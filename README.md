# Nexus AIOps — Team SpaceX

Ensylon AIOps Challenge 2026. The system reads the three Nexus signal streams and turns them into
reviewed incident tickets:

```
SSE streams ─► parse + redact PII ─► normalise (canonical schema) ─► dedup ─► anomaly score
   ─► structural gate + 5-dimension similarity ─► DBSCAN ─► causal refinement ─► validation (C4)
   ─► impact severity (0-100) + correlation confidence (0-1) ─► Claude-drafted ticket
   ─► human review (approve / edit & approve / reject) ─► output/tickets/
```

**Rules we follow:**
- PII is redacted before any processing or storage.
- Time alone never links two signals.
- A ticket file is written only after a named human approves it.
- The three streams are the only runtime input. The dependency graph comes from the allowed reference endpoint.

---

## Run it

Requirements: Python 3.10+ (tested on 3.12) and Node 20+ (tested on 22).

### 1. Backend (FastAPI, port 8002)

```bash
cd backend
python -m venv .venv && . .venv/Scripts/activate      # Windows; on macOS/Linux: . .venv/bin/activate
pip install -r requirements.txt
cp ../.env.example ../.env                             # then set ANTHROPIC_API_KEY in ../.env
python -m uvicorn app.main:app --port 8002
```

On startup, the backend:
- loads the dependency graph from `/sim/reference/service-dependency-graph`;
- opens the three streams (`aiops-logs`, `aiops-cloudwatch`, `aiops-grafana`);
- processes arrivals in 2-second micro-batches.

`.env` is gitignored. **Never commit the Claude key.** Without a key, tickets use a deterministic template
and everything else works unchanged.

### 2. Frontend (Next.js, port 3002)

```bash
cd frontend-next
npm ci
cp .env.local.example .env.local      # set API_URL=http://127.0.0.1:8002, AUTH_TYPE=NO_AUTH, any NEXTAUTH_SECRET
npm run dev -- -p 3002
```

Open http://localhost:3002.

| Page | What it shows |
|---|---|
| Overview | The raw signals → anomalies → incidents funnel and alert compression; the top incident in focus with its probable origin, propagation path on the dependency graph, formation timeline, per-dimension correlation breakdown, validation checks and decision trail; a classified live signal feed; stream health (Last-Event-ID, keepalives, reconnects) and validation rejections. |
| Signal Feed | Every signal in the canonical schema, already redacted. |
| Incidents & Review | The review queue. Each incident's page shows the evidence, root-cause candidates, severity and confidence breakdowns, and the ticket with **Approve / Edit & approve / Reject**. |
| Correlation & Validation | The exact formula, weights, gate, validation checks and scoring models, plus live rejections. |
| Service Topology | The reference graph with criticality and open incidents. |
| Evaluation | The offline benchmark (see below). |

### 3. Tests

```bash
cd backend && python -m pytest -q        # 374 tests
cd frontend-next && npx jest              # UI tests
```

The suite runs in offline mode (`AIOPS_OFFLINE_DEMO=1`, `NEXUS_LIVE=0`, `CLAUDE_DRAFTING=0`, all set in
`tests/conftest.py`). It never touches the network or the Claude API.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ANTHROPIC_API_KEY` | unset | Claude drafting (C5). Unset means template drafts. |
| `CLAUDE_MODEL` / `CLAUDE_EFFORT` | `claude-opus-5` / `medium` | Model and effort used for drafting. |
| `NEXUS_BASE_URL` | `https://logs.nonprod.nexus.ensylon.com` | Base URL for the streams and the reference graph. |
| `NEXUS_LIVE` | `1` | `0` skips connecting to the streams. |
| `STREAM_TICK_SECONDS` | `2` | Micro-batch interval. |
| `TICKETS_DIR` | `output/tickets` | Where approved tickets are written. |
| `AIOPS_OFFLINE_DEMO` | `0` | Mounts the generated-scenario routes, for tests only. **Keep it off for the evaluated run.** |
| `NEXUS_RECORD` | `1` | Record every handled event, already redacted, to `recordings/` (gitignored). |
| `NEXUS_RESUME` | `1` | After a restart, rebuild state from this session's recording and resume each stream from its Last-Event-ID. |
| `NEXUS_REPLAY` | unset | Play a recording instead of connecting: a path, or `latest`. The UI shows a REPLAY banner. |
| `REPLAY_SPEED` / `REPLAY_FROM` | `1` / `busiest` | Playback speed, and where to start: `busiest` (just before the most errors and alarms), `start`, or an ISO time. |

### Recording, resume and replay

The live run keeps a recording of what the streams sent, as JSON lines in `recordings/session-*.jsonl`.

- **What is stored:** the stream, the SSE id, and the parsed signal. Parsers redact PII before a signal exists,
  so nothing un-redacted reaches disk (the brief: redaction "before any further processing or storage").
  Recoveries and unparsable events are stored by id only.
- **Resume.** Restart the backend and it rebuilds its incidents from the recording, then reconnects each stream
  with its recorded `Last-Event-ID`: nothing lost, nothing counted twice. An incident on screen survives a restart.
- **Replay.** For a demo while the simulator is quiet:

  ```bash
  NEXUS_REPLAY=latest REPLAY_SPEED=4 python -m uvicorn app.main:app --port 8002
  ```

  The recording plays through the same engine. Every page shows **REPLAY · not live**, and the top bar says
  so instead of "Streams live". It is what the streams sent earlier, never generated data.

---

## How each component is met

### C1 — Ingest, redact, normalise
`backend/app/engine/live.py`, `nexus.py`, `redaction.py`

- **Stream handling:**
  - One reader thread per stream, with SSE framing (`id` / `event` / `data`).
  - It remembers the last event id and sends it as `Last-Event-ID` on reconnect, with exponential backoff.
  - `:keepalive` comments only refresh the "last heard" time. Silence never produces anything.
- **Parsers for all three formats:**
  - Plain-text logs: `ts LEVEL service component [k:v …] message`.
  - CloudWatch alarms: only `ALARM` states become signals.
  - Grafana alerts: `alerting`/`pending` become signals; `ok`/`no_data` are skipped.
  - Grafana payloads carry no timestamp. They are stamped with a **stream clock**: the latest event time seen on
    logs and CloudWatch, advanced by wall time. This keeps the three sources aligned.
- **Redaction before anything is stored:**
  - Covers emails, IPv4/IPv6 (private too), `sess_…` sessions, `ACC-…` / account ids, 12-digit cloud
    account ids, service accounts, phone numbers, and personal names.
  - Names are caught three ways: cue words ("customer Priya Sharma"), a gazetteer of common first names for uncued
    pairs ("SMS fallback for Rohan Mehta"; also `PRIYA SHARMA`, `O'Brien`, `Sharma, Priya`), and names learned from
    `first.last@` emails. Learned names are stored only as SHA-256 hashes.
  - A reviewer's edit is redacted too before it is stored.
- **Redaction is tested, not assumed** (`backend/tests/`):
  - `test_pii_redaction.py`: a 75-case corpus of PII in realistic shapes with evidence that must survive. 100% recall on
    74 planted values; 0 of 39 evidence values (services, hosts, metrics, ids) wrongly redacted; 0 of 887 distinct real
    recorded evidence texts change under the rules.
  - `test_pii_leak_scan.py`: plants PII in all three stream formats, runs the production path (reader, parser, engine,
    draft, human edit, approval, ticket files, recording), then scans every artefact and the log output. Any survivor fails.
  - Known limit (a strict xfail): an uncommon name with no cue word and no earlier email is not caught.
  - Structured fields (`user:`, `ip:`, `acc:`, `accountId`, `serviceAccount`, …) are redacted by field
    meaning. Internal hostnames are kept because they carry the environment.
- **Canonical schema:** every signal is also emitted as a canonical record:
  - fields `signal_id`, `timestamp`, `source` (`application_logs` | `cloudwatch_metrics` | `grafana_alerts`),
    `environment`, `region`, `service`, `component`, `signal_type`, `anomaly_score`, `evidence`, `metadata`;
  - served at `GET /engine/stream/signals`.

### C2 — Anomaly score (`detect.py`)
- **CloudWatch / Grafana (already past their own threshold):** `score = min(1, 0.6 + 2 × |value − threshold| / |threshold|)`,
  raised further by an EWMA z-score when the metric has a baseline.
- **Metrics:** EWMA baseline (α = 0.3). The signal is anomalous at |z| ≥ 3, and `score = min(|z|/6, 1)`.
- **Logs:** Drain3 template mining, with the template miner kept across micro-batches.
  - A novel error template scores 0.8. A novel *warning* scores 0.55: it can join an incident but cannot anchor
    one, because right after a start every routine warning is "new".
  - A burst (≥ 3 repeats and ≥ 4× the template's historical rate) scores `min(count/20 + 0.4, 1)`.
  - Only WARN and ERROR lines can be novel or a burst. An INFO line repeating is a busy, healthy service, never an anomaly.
  - A lone ERROR/CRITICAL line scores 0.6.
- **Threshold:** an incident must contain at least one signal with **anomaly_score ≥ 0.60** (validation check).

### C3 — Correlation (`correlate.py`, `causal.py`)
1. **Structural gate.** A pair is only scored if one of these holds:
   - same service;
   - a direct dependency edge on the reference graph (one hop; two hops count only with a shared component, below);
   - one signal names the other's service in its evidence (for example "Circuit breaker OPEN for payments-service");
   - same component, at most 2 hops apart.
2. **Similarity:** `sim = 0.36·T + 0.06·S + 0.33·D + 0.19·E + 0.06·C`, where:
   - T = `exp(−Δt/1 min)`, and 0 beyond the 15-minute window;
   - S = same service (1.0 with the same component, 0.85 otherwise);
   - D = hop closeness (0→1.0, 1→0.75, 2→0.45, 3→0.15);
   - E = Drain3 template match, else token Jaccard on redacted text; at least 0.6 when one signal names the
     other's service ("Circuit breaker OPEN for payments-service");
   - C = same component.
3. **Merge threshold:** `sim ≥ 0.45`, via DBSCAN on `1 − sim` with eps = 0.55 and min_samples = 2.
   Time's largest possible contribution (0.36) is below the threshold, so time alone can never merge two signals
   (asserted in `test_engine_real_session.py`).
   **Tuned on the real simulator**, not on generated estates: on a hand-labelled recording, time is the best single
   separator (AUC 0.89), the 12-service graph is so dense that dependency closeness barely separates stories (0.68),
   and one service takes part in several concurrent stories (payments in four), so same-service is weighted low.
   See *Evaluation* and `docs/FINDINGS_incident_merging.md`.
4. **Causal refinement.** Counterfactual root-cause analysis on the graph. Two independent roots whose evidence
   disagrees are split into two incidents. A cascade keeps one root.
5. **Streaming behaviour** (`stream.py`, `lifecycle.py`):
   - A new anomalous signal first tries to join an **open** incident. It must pass the same gate **and** reach the
     merge threshold (sim ≥ 0.45) with a member, exactly as two signals must to merge. The gate alone is not
     enough: an open incident would grow one dependency hop at a time and absorb unrelated failures nearby.
   - Otherwise it waits in a pending pool.
   - Pending signals with no structural partner after 15 minutes of stream time expire as noise.
   - A tick holding more than 2 s of event time (the backlog a stream sends on first connect, or a resume) is
     processed in 2 s slices with the clock held at each slice, so a backlog forms the same incidents as live arrival.
   - Regression test on a real burst recorded from the simulator
     (`backend/tests/fixtures/live_burst_2026-09-26.jsonl`): an agency-db cascade, a rulesforge slowdown and an
     SMTP outage must stay three incidents.

### C4 — Validation and scoring (`validate.py`, `severity.py`)
- **Validation.** A candidate must pass all five checks, and failures are never raised:
  - **Environment consistency:** mixed environments are split.
  - **Weak bridge:** with 5 or more signals, a single signal whose best link scores below 0.50 is a split point.
  - **Coherence:** at least 25% of pairs must be directly linked.
  - **Anomaly support:** the strongest signal must reach anomaly_score ≥ 0.60.
  - **Independent evidence:** the signals must describe at least two distinct conditions (service + source + template or metric). One condition repeated is accepted only at error or alarm severity; repeats of a single warning are not corroboration. This is what keeps a cold start, when every warning is "novel", from raising routine repeats.
- **Impact severity (0–100):** `100 × (0.40·blast + 0.35·criticality + 0.25·magnitude)`, where:
  - blast = `0.7·min(services/5,1) + 0.3·min(further dependents of the root/5,1)`;
  - criticality = the highest criticality among the involved services, from the brief's map (unknown = 50);
  - magnitude = the maximum anomaly_score.
  - Priority bands: P1 ≥ 75, P2 ≥ 50, P3 ≥ 25, P4 below that.
- **Correlation confidence (0–1):** `0.40·density + 0.35·topology + 0.25·evidence`.
  - It is computed separately from severity and never blended with it.
  - Both scores appear on every ticket with their parts.

### C5 — Tickets with Claude and human approval (`drafting.py`, `claude_drafting.py`, `review.py`, `tickets.py`)
- **Computed by the engine, deterministically:**
  - title, severity, confidence and services;
  - the **timeline, labelled with its source stream**;
  - the **facts**;
  - the suspected root-cause service.
- **Written by Claude from those facts only**, as JSON constrained by a schema:
  - the summary;
  - the **suspected root cause, worded as a hypothesis**;
  - the investigation steps.
- **Grounding check:** a reply that names a service outside the incident, or doesn't name the selected root cause, is discarded and
  the template is kept. Claude runs in a background thread, so ingestion never waits on it.
- **Human review:** the reviewer can **Approve**, **Edit & approve**, or **Reject**.
  - Edit & approve can change the title, priority, summary, suspected root cause, steps and services.
    Computed evidence cannot be edited.
  - Approval mints a single-use token. Only that token lets `FileTicketTransport` write
    `output/tickets/TKT-NNNN.json` and `.md`.
  - A retried approval never writes a second ticket.
  - A signal that arrives after approval is appended to the same ticket as an update.

---

## Evaluation

The live streams carry no ground truth, so correlation quality is measured offline. The **same engine code** runs on
generated estates with injected incidents. Held-out seeds 21–40, 80 runs:

| | pair precision | pair recall | pair F1 | root-cause accuracy |
|---|---|---|---|---|
| overall | 0.731 | 0.796 | **0.713** | **0.974** |

(Before the real-data re-tuning: precision 0.636, recall 0.837, F1 0.686, root cause 0.969.)

Generated data is used only for this measurement (`GET /engine/benchmark`, the Evaluation page). It never
enters the live engine.

### On the real simulator

Generated estates are not the estate we are judged on, so correlation is also scored against **hand-labelled ground
truth from a recorded run of the real simulator** (1,307 signals, 17 true incidents, 74 decoy warnings):
`backend/tests/fixtures/live_session_2026-09-26.*`, labeller `tools/label_recording.py` (readable keyword rules per
scenario), scorer `tools/eval_recording.py`, regression test `test_engine_real_session.py`.
The simulator runs seven overlapping scenarios (carrier-service memory leak, payments config deploy, external CDN latency,
rulesforge batch job, agency-db pool exhaustion, rulesforge slow query, comms SMTP outage) plus decoys.

| | before re-tuning | now |
|---|---|---|
| pair F1 / precision / recall | 0.347 / 0.359 / 0.336 | **0.571 / 0.843 / 0.432** |
| purity (share of an incident's signals in its main story) | 0.59 | **0.90** |
| completeness (share of a story held by one incident) | 0.65 | 0.65 |
| incidents raised for 17 true stories | 9 | 14 |
| root cause correct, incidents dominated by one story | 6 of 6 | **13 of 13** |
| generated-benchmark F1 (held-out) | 0.686 | **0.713** |

Known limits: (1) Grafana evaluates all its rules at one instant, so alerts of unrelated stories arrive together with
no wording in common; that leaves one small mixed fragment (8 signals). (2) A story can be split into several incidents
(completeness 0.65). (3) The labels are our own reading of the wording, not the organisers' answer key; signals that were
genuinely ambiguous are left out of scoring.

## Repository layout

```
backend/app/engine/     live.py (SSE), recording.py (record/resume/replay), stream.py (micro-batch engine),
                        lifecycle.py (late signals), nexus.py (parsers + canonical schema),
                        redaction.py, detect.py, correlate.py, causal.py, validate.py, severity.py,
                        drafting.py, claude_drafting.py, review.py (approval gate), tickets.py (output/tickets)
backend/app/engine_api.py   /engine/* routes (stream status, signals, graph, queue, approve/reject, evidence)
backend/tests/          pytest suite (test_engine_stream.py covers streaming, silence, tickets, grounding)
frontend-next/          Next.js UI
problem-statement.html  the challenge brief
```

The legacy AlertLens batch routes (`/pipeline`, `/demo/*`) and generated-scenario routes are disabled
unless `AIOPS_OFFLINE_DEMO=1`, and they are not linked from the UI.
