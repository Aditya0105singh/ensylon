# Page-by-page build spec

Companion to `docs/WORKPLAN.md`. **Team of three** (Aditya + two friends), so the workstreams there are folded into
three roles below. Every page has: purpose, owner, data (existing endpoint or new one to build), layout, states,
interactions, accessibility, tests, acceptance, and an effort estimate in hours.

## 0. The three roles

| Role | Person | Backend scope | Pages they build |
|---|---|---|---|
| **Lead / Product** | Aditya | Integration, `main`, contracts, deck story, Claude key | Shell (nav, top bar, search, notifications), Design system, **Overview**, **Incident detail**, **Review queue**, **Time Machine** |
| **Pipeline** | Friend 1 | C1 ingest/redaction/streaming resilience, recorder + replay, C5 Claude drafting, ticket files, audit | **Signal Feed**, **Tickets**, **Settings**, replay banner |
| **Intelligence** | Friend 2 | C2–C4 tuning, benchmark, ablation, calibration, maintenance windows, CI + docs | **Correlation & Validation**, **Evaluation**, **Deduplication**, **Service Topology** |

Rule: **whoever owns the data owns the page that shows it.** That keeps each person's backend change and its UI in one PR.

Rough load (hours): Lead ~70 (UI heavy + integration + deck), Pipeline ~60, Intelligence ~60. Numbers are per-page below.

**Order of work** (matches WORKPLAN phases): P0 real-event check → design system → pages in the order of §14 → polish → freeze.

---

## 1. Global shell  — Lead · ~8 h

Files: `components/navbar/*`, `app/(keep)/layout.tsx`, `shared/ui`.

**Purpose:** consistent frame, always shows the one thing that matters: are the streams live, and does a human owe a decision.

**Layout**
```
┌ sidebar ─────────┬ top bar ──────────────────────────────────────────────┐
│ ◉ Nexus AIOps    │ [ search / jump  Ctrl K ]   ● Streams live 3/3   🔔 2   ☀/☾  👤 │
│ Overview         ├───────────────────────────────────────────────────────┤
│ Signal Feed      │                    page content                        │
│ INCIDENTS        │                                                        │
│  Incidents&Review│                                                        │
│  Time Machine    │                                                        │
│  Tickets         │                                                        │
│ INTELLIGENCE     │                                                        │
│  Deduplication   │                                                        │
│  Correlation     │                                                        │
│  Topology        │                                                        │
│ INSIGHTS         │                                                        │
│  Evaluation      │                                                        │
│  Settings        │                                                        │
└──────────────────┴───────────────────────────────────────────────────────┘
```
**Build**
- Top-bar status pill: green "Streams live 3/3", amber "Streams 2/3" (names the missing one on hover), red "Backend offline". Data: `/engine/stream/status`.
- Bell = incidents awaiting review; click → Review queue filtered. P1 waiting turns the bell red and pulses (respect reduced motion).
- Command palette (`Ctrl K`): jump to pages, and to any incident by title/service (data: `/engine/queue`).
- Sidebar badges: Review count, Tickets written count.
- **Replay banner** (Pipeline provides the flag via `/engine/stream/status.replay`): full-width amber "REPLAY — recorded session, not live".
- Theme toggle, projector-mode toggle (larger type, higher contrast), both persisted.
- Global error boundary and 404 in the same visual language.

**States:** backend offline (banner + retry), loading skeleton for the frame, collapsed sidebar on narrow screens.
**A11y:** skip-to-content link, landmarks (`nav`, `main`), focus ring, palette is a proper dialog with `aria-activedescendant`.
**Accept:** every page reachable by keyboard; status pill matches `/engine/stream/status` within 3 s of a connection change; no "AlertLens" string anywhere.

---

## 2. Design system  — Lead · ~10 h  (do first)

Files: `styles/tokens.css`, `shared/ui/*`, `entities/engine/charts.tsx`.

- **Tokens:** severity (P1 red, P2 orange, P3 amber, P4 grey), source (logs blue, CloudWatch amber, Grafana violet), state (ok/warn/bad), spacing 4-pt scale, radius 8/12/16, two elevations, type scale (12/14/16/20/28). Light and dark values for every colour.
- **Components:** `PageHero`, `KpiCard` (value + delta + sparkline + animated counter), `Panel`, `Badge` (priority/source/state), `Gauge` (0–100 and 0–1 variants), `Sparkline`, `StackedColumns`, `Histogram`, `Donut` (exist in `charts.tsx`), `EmptyState`, `Skeleton`, `ErrorState`, `DataTable` (sticky head, virtualised), `Drawer`, `Tooltip`, `KeyHint`, `CopyButton`.
- **Rules:** colour never carries meaning alone (icon or text too); charts have a text/table alternative; numbers use tabular figures; motion ≤ 300 ms and disabled under `prefers-reduced-motion`.
- **Storybook-lite:** a hidden `/design` page rendering every component in light/dark for review.
- **Accept:** all components render in both themes; contrast AA (checked with an axe run on `/design`).

---

## 3. Overview  — Lead · ~10 h

Route `/` · `app/(keep)/LiveOverviewClient.tsx`.

**Purpose:** the 10-second answer: are we receiving signals, what did the engine make of them, what needs a human.

**Data:** `/engine/stream/status` (3 s poll), `/engine/stream/metrics`, `/engine/queue`, `/engine/stream/signals?limit=12`, `/engine/stream/rejections`.
**New (Pipeline builds):** `GET /engine/stream/events?limit=50` — activity log entries `{at, kind: signal|joined|incident|rejected|expired|approved|rejected_by_human, text, ref}`.

**Layout**
```
[ hero: Nexus live operations ............................ graph · Claude status ]
[ stream card ][ stream card ][ stream card ]      ← sparkline, heartbeat, last-event age
[ KPI ][ KPI ][ KPI ][ KPI ][ KPI ][ KPI ]          ← animated counters + sparklines
[ FUNNEL: raw → distinct → anomalous → correlated → incidents → awaiting review ]
[ signals/min chart          ][ score histogram ]
[ priority donut ][ incidents over time ][ activity ticker ]
[ incidents list (gauges)    ][ latest signals ]
[ rejected by validation ]
```
**Build**
1. **Funnel ("Chaos → Order")** — the signature visual. Six labelled bars with live counts and the % kept at each step; hover explains the step ("collapsed 7 repeats"). New signals animate along it.
2. KPI cards get sparklines from `metrics.timeline` and a delta vs previous 5 minutes.
3. Stream cards: per-stream events/min sparkline, keepalive heartbeat dot that pulses on each keepalive, last-event age coloured (green < 30 s, amber < 2 min, red beyond).
4. Incident rows show **two gauges side by side**: Impact 0–100, Confidence 0–1, with a caption "scored separately".
5. Activity ticker (from the new endpoint), click opens the incident / signal.
6. Quiet state: "Listening… 3 streams connected, last keepalive 6 s ago" with the heartbeat; not an empty page.

**States:** loading skeleton per panel; backend offline; streams down (cards red, funnel greyed with reason).
**A11y:** live region announces "New incident P1: agency-db …"; charts have data tables behind a "Show as table" toggle.
**Tests:** renders each state; new incident triggers announcement; funnel numbers equal metrics numbers.
**Accept:** with the fake host the funnel reads 19 → 13 → 12 → 7 → 2 → 2 (values from the run); a stalled stream turns its card red within 2 min.

---

## 4. Signal Feed  — Pipeline · ~7 h

Route `/feed` · `app/(keep)/feed/SignalFeedClient.tsx`.

**Purpose:** prove C1: what came in, normalised and redacted. The judge's "show me the PII is gone" page.

**Data:** `/engine/stream/signals?limit&source&service`. **New:** `GET /engine/stream/signals/{signal_id}` → canonical record + `disposition`: `incident:<draft_id> | pending | noise(expired) | not anomalous`, and the redaction kinds applied (counts only, never values).

**Layout:** filter bar (source chips, service select, score slider, "anomalous only", search evidence) · pause/resume + rate ("14 signals/s") · virtualised table · right drawer with the canonical JSON and disposition.
**Build**
- Virtualise (5,000 rows smooth); newest first; pause freezes the view but the count keeps rising with a "N new" pill.
- Row: time, source badge, service, component, type, **score bar**, evidence with `[REDACTED:…]` tokens rendered as small pills (so redaction is visible, not just text).
- Drawer: canonical record (copy JSON), disposition with a link to the incident, "redaction applied: EMAIL×1, SESSION×1".
- **"Redaction proof" panel:** totals by kind since start (from `report.redaction_counts`) — "0 raw values stored".
- Export CSV of the current filter (canonical fields only).
**States:** empty (quiet streams), filtered-empty, error, paused.
**A11y:** table semantics, row selectable by keyboard, `aria-live=off` on the streaming body (announce only the "N new" pill).
**Tests:** filters, pause, drawer, redaction pills; 5k-row render < 100 ms scroll frame.
**Accept:** clicking any signal shows where it went; no value matching the leak scanner's PII regexes appears anywhere on the page.

---

## 5. Incidents & Review  — Lead · ~9 h

Route `/review` · `app/(keep)/review/page.client.tsx`.

**Purpose:** the human's inbox. Fast triage: what's burning, decide, move on.

**Data:** `/engine/queue`, `/engine/audit`, `/engine/report`.
**Layout:** tabs Awaiting / Published (written) / Rejected · sort (priority, impact, newest) · list of incident cards · audit log below.
**Build**
- Card: priority badge, title, services chips, **impact gauge + confidence gauge**, signal count, age ("waiting 4 m") with SLA colouring, source mini-bar (which streams contributed), "updated by 2 late signals".
- Inline quick actions: Open, Approve (opens the confirm drawer), Reject (reason prompt).
- Keyboard: `J/K` move, `Enter` open, `A/E/R` act, `?` help overlay.
- Bulk reject for obvious noise (multi-select) with one confirm.
- Reviewer name remembered locally; required before any decision (existing rule).
- Audit log: filterable, shows actor, action, detail; link to the ticket file for approvals.
**States:** nothing waiting ("All clear — 0 awaiting"), loading, error.
**Accept:** a P1 always sorts first; decisions update the list within 1 s; the audit log records every decision with the reviewer name.

---

## 6. Incident detail (investigation)  — Lead · ~16 h  (biggest page)

Route `/review/[id]` · `app/(keep)/review/[id]/InvestigationClient.tsx`.

**Purpose:** answer "why is this one incident, why this severity, why this cause" and let the human act with confidence.

**Data:** `/engine/queue/{id}`, `/engine/queue/{id}/evidence`, `/engine/audit`, `/engine/graph`.
**New (Intelligence builds):** evidence adds `graph: {nodes:[signal ids], edges:[{a,b,gate,similarity,components}]}` for the correlation graph, and `near_misses` with reason.

**Layout**
```
[ hero: title · P1 badge · status · waiting 4m ]
[ lifecycle: open → drafting → in review → written → resolved ]
[ funnel: raw → unique → in incident | rejected ]
[ Correlation graph (big)          ][ Root cause ranking   ]
[  nodes=signals, edges=gate+sim   ][ Severity 0–100 gauge  ]
[  hover: T/S/D/E/C breakdown      ][ Confidence 0–1 gauge  ]
[ Topology overlay (propagation)   ][ Validation checks ✓✓✓✓ ]
[ TICKET: facts | hypothesis+steps ][ edit / approve / reject ]
[ audit trail ]
```
**Build**
1. **Correlation graph** (SVG, force or layered by time): node colour = source, size = anomaly score, edge label = gate ("dependency edge"), thickness = similarity. Hover an edge → T/S/D/E/C bars with weights. Click a node → its evidence row. Toggle "show rejected candidates" (near-misses in red dashed).
2. **Topology overlay:** the 12-service graph, incident services lit, suspected root pulsing, arrows animate in first-seen order. "Play propagation" button. Link to Time Machine.
3. **Severity card:** big 0–100 gauge, stacked bar for the three contributions (blast 0.40 / criticality 0.35 / magnitude 0.25) each with a plain sentence ("payments-service criticality 95").
4. **Confidence card:** 0–1 gauge with density / topology / evidence bars. Caption "never blended with severity".
5. **Validation card:** the four checks as ✓/✗ with the numbers.
6. **Ticket card:** left = computed facts + timeline (source-labelled) ; right = Claude's summary, suspected root cause (tagged hypothesis), steps. Provenance line: "written by claude-opus-5 · checked for grounding" or "template — reason".
7. **Edit & approve** (exists): add a **diff view** of edits vs the draft before confirming, and a preview of the file that will be written (`output/tickets/TKT-000N.md`).
8. Late signals: a "+2 late signals joined" strip with when/gate; the ticket after approval shows appended updates.
**States:** incident not found, still narrating (spinner on the AI half only), rejected/merged read-only.
**A11y:** graph has a table alternative (edges list); all actions keyboard reachable; toasts are `role=status`.
**Tests:** approve/edit/reject payloads (exist), diff view, graph renders N nodes/E edges from fixture, unknown-gate fallback.
**Accept:** every number on the page is traceable to a line in the evidence response; the human can approve without leaving the page.

---

## 7. Time Machine  — Lead · ~6 h

Route `/timemachine` (exists, basic).

**Purpose:** the demo centrepiece: watch an incident form.
**Data:** `/engine/queue/{id}/evidence` (signal order, join info).
**Build on what exists**
- Scrub bar with tick marks per signal; `Space` play/pause, `←/→` step, speed 0.5×–4×.
- Show **the pending pool** at each step: signals waiting before they joined (needs evidence to include `first_seen_at_engine`, small backend add by Pipeline).
- Animate the topology overlay in sync (reuse the component from §6).
- "Explain this step" panel: gate reason + T/S/D/E/C bars + similarity vs 0.34 line drawn on the bar.
- Deep link `?id=&step=` so the demo can jump to the interesting moment.
- Share: copy a link to the step.
**Accept:** stepping to the last signal reveals the root cause; the replay of a 6-signal incident runs smoothly at 4×.

---

## 8. Tickets  — Pipeline · ~6 h  (new page)

Route `/tickets`.

**Purpose:** show the deliverable — what was actually written to `output/tickets/`.
**Data (new):** `GET /engine/tickets` → `[{key, draft_id, title, priority, approved_by, written_at, edited: bool, comments: n, path}]`; `GET /engine/tickets/{key}` → full JSON + rendered Markdown + edit diff + comments.
**Layout:** table of tickets · click → split view: rendered Markdown left, JSON right (tabs) · "edited by reviewer" badge with the diff · updates appended after approval.
**Build:** open-file path copy button; download `.md`/`.json`; empty state "Nothing written yet — a ticket appears only after a human approves".
**Accept:** the list equals the files on disk; an edited ticket shows before/after; no ticket appears for a rejected draft.

---

## 9. Deduplication  — Intelligence · ~5 h

Route `/deduplication` (exists, live).

**Data:** `/engine/stream/metrics` (`dedup`, `top_repeats`).
**Add**
- Before/after bar: received vs distinct, with the fingerprint recipe drawn as pills (service + component + condition + 5-min bucket).
- **Interactive example:** pick a top repeat → list its occurrences (time, count) and show the one representative that survived and the onset time preserved.
- Per-source dedup rate (logs collapse more than metrics — say so).
- Window sensitivity note linking to the benchmark (does 5 min lose anything?) — number comes from B3.
**Accept:** "collapsed" equals received − distinct exactly; selecting a repeat shows all its occurrences.

---

## 10. Correlation & Validation  — Intelligence · ~10 h

Route `/correlations` (exists, static explainer).

**Purpose:** the formula page the deck points at, made live.
**Data:** existing constants (serve them from the backend so the page cannot drift: **new** `GET /engine/config` → weights, thresholds, window, checks, criticality map); `/engine/stream/rejections`; **new** `POST /engine/explain-pair {a_id,b_id}` → gate + T/S/D/E/C + total.
**Build**
1. **Pair explainer:** choose two signals (from recent feed), see whether the gate passes and why, the five dimension bars × weights, total vs 0.34. Answers any judge question live.
2. Formula card generated from `/engine/config` (no hard-coded copy), with a "why this weight" note per dimension (Intelligence writes these from the ablation).
3. **Ablation chart** (from B3): F1 with each dimension removed; time-only baseline highlighted.
4. **Threshold curve:** precision/recall vs merge threshold with our operating point marked.
5. Validation section: each check with rule, the count of candidates it rejected so far, and recent rejections (exists).
6. Scoring models: severity and confidence formulas with a **calculator** (drag sliders for blast / criticality / magnitude → see impact and priority).
**Accept:** changing a constant in the backend changes this page without a frontend edit; pair explainer matches the engine's own score to 3 decimals.

---

## 11. Service Topology  — Intelligence · ~7 h

Route `/topology` (exists, basic layered SVG).

**Data:** `/engine/graph` (nodes with criticality, incidents, roots).
**Build**
- Heat by criticality (colour ramp) with legend; edge direction arrows; hover shows callers/callees and 1-2 hop reach.
- **Blast-radius mode:** click a service → highlight everything downstream that would be hit (this is what the blast factor uses) with the count.
- **Incident filter:** pick an incident → lights its services, marks root, shows first-seen order badges 1,2,3.
- Panel for the selected service: criticality, open incidents, recent signals count, dependents list.
- Layout: stable positions (persist per session) so the demo doesn't reshuffle.
**Accept:** blast-radius count equals the backend's `_dependents` for that service; unknown service in an incident appears as a grey "not in graph" node.

---

## 12. Evaluation  — Intelligence · ~8 h

Route `/evaluation` (exists, benchmark card only).

**Data:** `/engine/benchmark`; **new** `/engine/benchmark/ablation`, `/engine/benchmark/reliability`.
**Build**
- Benchmark table by scenario (staggered/concurrent, 3/6 incidents) with the Nexus-estate scenarios (B2).
- Ablation and sensitivity charts (same data as the Correlation page, larger).
- **Reliability plot:** predicted confidence buckets vs actual correctness, diagonal reference.
- Root-cause accuracy and incident-count accuracy tiles; worst-case seed listed (honesty).
- Clear banner: "Measured offline on generated estates with injected faults. Live streams have no ground truth."
- Drafting eval results (from C2 eval): grounded rate, fallback rate, latency.
**Accept:** every number reproducible with one command (`python -m app.engine.benchmark`); seeds shown.

---

## 13. Settings  — Pipeline · ~4 h

Route `/settings` (exists, live).
**Add:** Claude key *present/absent* (never the value) + last call latency and error; per-stream last error; tick duration p50/p95; memory in use of each buffer vs its cap; build/commit hash; a "test Claude" button (one tiny call, shows result); maintenance windows form (from B6) — list, add, remove, with visible suppression counts.
**Accept:** no secret ever returned by any endpoint (test greps the response for the key prefix).

---

## 14. Build order (three parallel tracks)

| Week-slice | Lead | Pipeline | Intelligence |
|---|---|---|---|
| **P0** | Design system, shell | Verify real events, recorder, fix parsers | CI + secret scan, calibration report from recordings |
| **P1a** | Overview + funnel | Signal Feed + redaction proof, PII leak scanner | `/engine/config`, Nexus benchmark, ablation |
| **P1b** | Incidents & Review, Incident detail (graph first) | Claude eval + injection tests, Tickets page + API | Correlation & Validation page, Deduplication |
| **P2** | Time Machine, detail polish, diff view | Settings, replay mode + banner, maintenance | Topology, Evaluation, reliability plot |
| **P3** | Deck story, demo script, rehearsal | Backup video, final security pass | README, judge Q&A, final numbers check |

## 15. Definition of done (every page)

- [ ] Works with the fake host **and** with recorded real data
- [ ] Empty, loading, error, quiet, data states all designed
- [ ] Light and dark; laptop and projector size
- [ ] Keyboard-only usable; axe reports 0 serious issues
- [ ] Component/unit test for each state; page test in `__tests__`
- [ ] No number hard-coded that the backend can supply
- [ ] Types updated in `entities/engine/types.ts`; README/PLAN updated if a contract changed
- [ ] Screenshot added to `docs/screens/` (light + dark)
