# Task list — start here

How to use: pick the next unchecked task in **your** column, make a branch `t-<id>-<topic>`, open a PR into `main`, tick the box
in this file in the same PR. Specs: `PAGES.md` (what each page shows), `WORKPLAN.md` (why), `PLAN.md` (how to run).
Roles: **L** = Lead (Aditya) · **P** = Pipeline · **I** = Intelligence.

Legend: `→` depends on. Hours are estimates. Every task's "done" means the page/feature passes `PAGES.md` §15.

## 1. API contracts (agree these first, then build both sides in parallel)

Backend builds the endpoint, frontend codes against the fixture below. Add each to `frontend-next/entities/engine/types.ts`
and drop the JSON in `backend/tests/fixtures/` so both sides test against the same shape.

**`GET /engine/config`** (I) — the page never hard-codes a constant
```json
{ "weights": {"time":0.25,"service":0.20,"dependency":0.20,"template":0.20,"component":0.15},
  "merge_threshold": 0.34, "window_minutes": {"base":5,"max":15}, "time_scale_minutes": 4,
  "hop_closeness": {"0":1.0,"1":0.75,"2":0.45,"3":0.15},
  "anomaly": {"z_threshold":3.0,"min_incident_score":0.60,"ewma_alpha":0.3},
  "severity": {"weights":{"blast":0.40,"criticality":0.35,"magnitude":0.25},"bands":{"P1":75,"P2":50,"P3":25}},
  "confidence": {"weights":{"density":0.40,"topology":0.35,"evidence":0.25}},
  "validation": [{"name":"environment consistency","rule":"..."}],
  "criticality": {"payments-service":95,"docforge":30}, "criticality_default": 50 }
```

**`POST /engine/explain-pair`** (I) `{ "a_id": "...", "b_id": "..." }`
```json
{ "gate": {"passed":true,"reason":"direct dependency edge","hops":1},
  "components": {"time":0.98,"service":0.0,"dependency":0.75,"template":0.29,"component":1.0},
  "weights": {"time":0.25,"service":0.20,"dependency":0.20,"template":0.20,"component":0.15},
  "contributions": {"time":0.245,"service":0.0,"dependency":0.15,"template":0.057,"component":0.15},
  "total": 0.60, "merge_threshold": 0.34, "merged": true }
```

**`GET /engine/stream/events?limit=50`** (P) — Overview activity ticker
```json
[ {"at":"2026-09-26T05:24:12Z","kind":"joined","text":"enrollment-service joined incident draft-0 via service named in evidence","ref":{"draft_id":"draft-0-1790400249"}},
  {"at":"...","kind":"incident","text":"P1 incident: agency-db cascading to 2 service(s)","ref":{"draft_id":"..."}},
  {"at":"...","kind":"rejected","text":"candidate on docforge failed coherence","ref":null},
  {"at":"...","kind":"expired","text":"batch-report signal expired without a partner","ref":{"signal_id":"..."}} ]
```
kinds: `signal | joined | incident | rejected | expired | approved | rejected_by_human`.

**`GET /engine/stream/signals/{signal_id}`** (P)
```json
{ "signal": { "...canonical record..." },
  "disposition": {"state":"incident","draft_id":"draft-0-...","note":null},
  "redaction": {"EMAIL":1,"SESSION":1,"ACCOUNT":1} }
```
`state`: `incident | pending | noise | not_anomalous`. Redaction is counts only, never values.

**`GET /engine/tickets`** and **`GET /engine/tickets/{key}`** (P)
```json
[ {"key":"TKT-0001","draft_id":"...","title":"...","priority":"P1","approved_by":"Aditya",
   "written_at":"...","edited":true,"comments":1,"path":"output/tickets/TKT-0001.json"} ]
```
detail adds `ticket` (JSON), `markdown`, `edit_diff: [{"field":"title","before":"...","after":"..."}]`, `comments: [{"at","body"}]`.

**Evidence additions** on `GET /engine/queue/{id}/evidence` (I)
```json
{ "graph": { "nodes": [{"id":"sig1","service":"agency-db","source":"cloudwatch_metrics","score":0.76,"at":"..."}],
             "edges": [{"a":"sig1","b":"sig2","gate":"direct dependency edge","similarity":0.60,
                        "components":{"time":0.98,"service":0,"dependency":0.75,"template":0.29,"component":1.0}}] },
  "near_misses": [{"signal_id":"...","service":"batch-report","reason":"no shared service, edge, component or mention"}],
  "pending_before_join": [{"signal_id":"sig3","waited_seconds":18}] }
```

**`GET /engine/stream/status`** additions (P): `"replay": {"active":false,"source":null,"speed":1}`, `"tick_ms": {"p50":4,"p95":11}`,
`"buffers": {"pending":{"size":1,"cap":5000}}`, `"claude": {..., "last_latency_ms":2100,"last_error":null}`, `"parse_error_samples":[]`.

**Benchmark additions** (I): `GET /engine/benchmark/ablation` →
`[{"variant":"without time","f1":0.61},{"variant":"time only (gate off)","f1":0.31}, ...]`; `GET /engine/benchmark/reliability` →
`[{"bucket":"0.6-0.7","predicted":0.65,"actual":0.58,"n":12}]`.

---

## 2. Lead (Aditya)

- [ ] **L1 Design system** (10h) — tokens, `KpiCard`, `Gauge`, `Sparkline`, `Badge`, states, `/design` page → PAGES §2
- [ ] **L2 Shell** (8h) → L1 — status pill, bell, command palette, theme + projector toggles, replay banner slot → PAGES §1
- [ ] **L3 Overview funnel + KPI sparklines** (6h) → L1 — build against `/engine/stream/metrics`; ticker later
- [ ] **L4 Overview ticker + stream heartbeat** (4h) → P3 — uses `/engine/stream/events`
- [ ] **L5 Review queue** (9h) → L1 — cards with two gauges, keyboard, bulk reject, audit filter
- [ ] **L6 Incident detail: correlation graph** (8h) → I5 — SVG graph, edge hover breakdown, near-miss toggle
- [ ] **L7 Incident detail: topology overlay + gauges + validation card** (8h) → L1, L6
- [ ] **L8 Incident detail: ticket diff view + file preview** (4h) → P7 — edits vs draft, `output/tickets/…` preview
- [ ] **L9 Time Machine** (6h) → L6 — scrub, speeds, pending pool, deep links
- [ ] **L10 Integration + `main` guard** (ongoing) — review PRs, keep contracts and README in sync
- [ ] **L11 Deck story + demo script** (8h, P3) — assemble slides from each owner's numbers

## 3. Pipeline (friend 1)

- [ ] **P1 Recorder** (3h) — `tools/record_stream.py` → `recordings/` (gitignored)  **do first**
- [ ] **P2 Real-event check** (6h) → P1 — compare with `nexus.py`, fix parsers, `parse_error_samples`; exit: 30 min at `parse_errors=0`
- [ ] **P3 `/engine/stream/events`** (3h) — the activity log; contract above
- [ ] **P4 PII corpus + leak scanner test** (8h) — 200 variants, recall/FP numbers, scans every artefact
- [ ] **P5 Resilience tests + `tools/chaos.py`** (6h) → P2 — drop/reconnect/flood/silence; bounded buffers; tick p50/p95 in status
- [ ] **P6 Signal Feed page** (7h) → L1 — virtualised, drawer, redaction pills, proof panel; `/stream/signals/{id}` endpoint
- [ ] **P7 Tickets API + page** (6h) — `/engine/tickets`, edit diff stored in ticket JSON, audit to `output/audit.jsonl`, redact edits
- [ ] **P8 Claude for real + eval** (8h) — run with key, 15-incident eval, latency/cost, grounded rate ≥ 95%
- [ ] **P9 Prompt-injection safety** (3h) → P8 — delimiters, length cap, tests with hostile log lines
- [ ] **P10 Replay mode + banner** (6h) → P1 — replay a recording through the same parser; `replay` in status; off by default
- [ ] **P11 Settings page** (4h) — key present/absent, last Claude call, buffers, maintenance form (uses I8)

## 4. Intelligence (friend 2)

- [ ] **I1 CI + secret scan + pre-commit** (4h) **do first** — pytest, tsc, jest, gitleaks, "no `.env`/`output/` tracked"
- [ ] **I2 `/engine/config`** (2h) — contract above; every UI constant comes from here
- [ ] **I3 Calibration report** (6h) → P2 — `docs/CALIBRATION.md` from recordings: score histograms, incidents/hour, noise share; tune thresholds
- [ ] **I4 Nexus benchmark generator** (8h) — 12-service graph, criticality map, concurrent + flapping + PII payloads; held-out seeds untouched
- [ ] **I5 Evidence graph + near misses** (4h) — contract above (unblocks L6)
- [ ] **I6 `explain-pair`** (3h) → I2 — contract above
- [ ] **I7 Ablation + sensitivity + reliability** (8h) → I4 — endpoints above, CSVs in `docs/results/`
- [ ] **I8 Maintenance windows API** (3h) — create/list/delete; suppression shown, never silent
- [ ] **I9 More validation checks** (5h) — causal order, source diversity, graph consistency, min evidence; boundary tests
- [ ] **I10 Correlation & Validation page** (10h) → I2, I6, I7 — pair explainer, live formula, ablation, threshold curve, calculator
- [ ] **I11 Deduplication page upgrade** (5h) — repeat explorer, per-source rates
- [ ] **I12 Topology page upgrade** (7h) — heat, blast-radius mode, incident filter, stable layout
- [ ] **I13 Evaluation page** (8h) → I7 — tables, ablation, reliability, drafting eval from P8
- [ ] **I14 README + docs cleanup** (4h) — remove old AlertLens docs (`DEMO_SCRIPT.md`, `DEPLOY.md`, `render.yaml`), keep README = spec

## 5. First day, in order

1. **Everyone:** clone `https://github.com/Aditya0105singh/ensylon`, follow `README.md`, run `tools/fake_nexus.py` + backend + frontend, click through every page.
2. **P:** P1 then P2 the moment real events flow. Nobody else tunes anything until P2 is green.
3. **I:** I1 (CI) then I2 (`/engine/config`) — small, unblocks the UI.
4. **L:** L1 design system, then L2 shell.
5. Agree the contracts in §1 in the group chat; anyone who needs to change one says so before coding.

## 6. Merge rules

- PR title `T-<id>: <what>`; one reviewer (Aditya reviews all until CI is in, then any teammate).
- CI green before merge. No `.env`, keys, `output/`, `recordings/` in a PR.
- Tick the box here and, if a contract changed, update `types.ts` + the README table in the same PR.
- Don't push to the organisers' repo. Aditya does that at the end.
