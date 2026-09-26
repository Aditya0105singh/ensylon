# Judge demo script (about 2 minutes)

## Before judging (5 minutes)

- Demo from **localhost** if you can: backend on :8001, frontend on :3001, browser on the Overview.
  The hosted backend sleeps when idle and can take up to a minute to wake.
- If you must use the hosted site, open it 2-3 minutes early and load the Overview once so the
  backend wakes (it re-creates the golden run on startup).
- Click *Inject failure* once as a warm-up, then return to the Overview.
- Close other heavy apps: the dev server needs about 3 GB free.

## The walkthrough

1. **Set the scene (10s).** "Alert fatigue: one failure, dozens of signals, 20-40 minutes to write
   a ticket. We turn that into one explained incident and never publish without a human."
2. **Inject failure (10s).** Click *Inject failure*. "That runs a fixed failure through the real
   pipeline: CloudWatch, Grafana and OpenTelemetry telemetry."
3. **The funnel (10s).** Point at 17 -> 6 -> 1 and the red 1 rejected. "Seventeen signals, twelve
   were the same error and collapsed. One incident. One alert rejected."
4. **Correlation Explorer (25s).** Scroll the signal list. "Every signal names why it joined: same
   service, dependency edge, or the shared trace ID. Time alone never groups." Point at the rejected
   disk warning: "It fired in the same minute. No shared service, dependency or trace, so it stays out."
5. **Root cause (15s).** "Earliest alert wins is wrong. `postgres-primary` scores 0.89; the others are
   symptoms the counterfactual check rules out." (It is rule-based graph ablation; say so.)
6. **Why P1 (15s).** Severity card. "Four weighted factors add to 0.846; 0.75 is the P1 line. Every
   input is visible."
7. **The ticket (15s).** Green block = computed facts. Purple block = AI prose. "The LLM cannot add
   services, times, severity or a root cause." (Template fallback shows while no LLM key is set.)
8. **The gate (20s).** Point at "AWAITING HUMAN REVIEW - Jira not created". Enter a name, click
   *Approve & create Jira*. "Approval mints a single-use token. Without it the Jira call is rejected;
   we test that." Show the published key (mock Jira).
9. **Stateful incident (15s).** Click *Send a related late alert*. "It attaches to the same incident
   and becomes a comment on the same Jira issue. No second ticket." Then *Send an unrelated alert*:
   "Parked as noise."
10. **Close (15s).** Evaluation page, top card. "The golden run is one scenario, so its 100% is a
    reproduction check, not accuracy. Here is the engine on 80 held-out estates: root cause right
    97% of the time. Grouping is strong when incidents are staggered; concurrent failures on
    shared services are our known weak spot, and we show it rather than hide it."

If something breaks: *Replay golden incident* on the Evaluation page resets the engine state.

Note: after a late alert the severity can drop (the trend factor reads "decaying" once the burst
ends). That is the model working as designed; the re-score is recorded in the history.

## Day one: a new input format

If the problem statement hands you data files instead of webhooks:

```bash
cd backend
python scripts/feed_file.py their_alerts.csv --local   # any size: prints incidents, root causes, priorities
python scripts/feed_file.py their_alerts.csv           # through the running backend, shows up in the UI
```

JSON, JSON Lines and CSV all work, and field names are matched loosely. If it reports "no usable
signals", the timestamp column has an unusual name: rename it to `timestamp`, or add it to
`_TIME_KEYS` in `backend/app/engine/adapters.py`.

## Hard questions, straight answers

- **"Is the 91% your engine?"** No. That is the baseline scale explorer. The engine's own number is the
  held-out benchmark: root cause right in 97% of 80 runs, grouping F1 0.81 on staggered incidents.
- **"Why are there two pipelines?"** The baseline handles large raw datasets (BGL) quickly; the engine is
  the product, with the causal step, the review gate and full evidence. The dataset pages say which is which.
- **"What happens with two outages at once?"** If they share a service or an edge in the same minute they can
  be drafted as one incident. Root cause stays accurate, a reviewer can split them before Jira, and the
  structural fix is weighting error-type evidence when incidents overlap.
- **"Is the root cause ML?"** No, rule-based graph ablation over the dependency graph. That is deliberate:
  every step is explainable, and it scores 95-100% on the benchmark.
- **"Can it auto-publish if it's confident?"** No, by construction: Jira needs a single-use approval token
  that only a named human approval mints. It is tested.
- **"What is mocked?"** Jira and paging transports, the LLM without a key, and the seeded history. The
  Settings page shows live versus mock for the running instance.
