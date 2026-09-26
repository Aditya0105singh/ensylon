# Finding: separate stories merge into one long incident on real data

Found 2026-09-26 by replaying the real simulator recording (`recordings/session-*.jsonl`) through the engine.
Reproduce with any recording: feed `recording.load(path).signals` to a `StreamEngine` via `recording.fast_forward`.

## What happens

On the real streams the simulator injects several problems at once. After ~40 minutes the engine holds a
**single P1 incident of 44+ signals over 40 minutes** that contains at least four stories:

| Story (by service and time) | Signals |
|---|---|
| carrier-service memory leak → OOM, gateway/enrollment/comms symptoms (10:10-10:50) | ~30 |
| agency-db pool exhaustion → payments → enrollment (10:27-10:28) | ~14 |
| comms-service SMTP outage (10:21-10:36) | ~12 |
| rulesforge slow queries (10:17-10:35) | ~10 |

Every link is "same service" or "direct dependency edge". The reference graph is dense (12 services, agency-db under
almost everything), so an edge says little, and a run of loosely linked signals chains the stories together. A merged
incident is bad for a reviewer: one ticket, one root cause, several real problems.

## Fixed in this branch

**Wrong root cause.** The merged incident named `comms-service` as root cause, although carrier-service (which calls it)
failed 18 minutes before comms-service did. Two rules ignored time: a failing callee made its caller a "symptom", and
dependents counted toward reach whatever their onset. Now a dependency only explains a service if it failed no more than
10 minutes after it, and a dependent only counts toward reach if it did not fail more than 10 minutes before the
candidate (`causal.PRECEDENCE_TOLERANCE_S`). Held-out benchmark unchanged (F1 0.686, root cause 0.969). Tolerances of
3 and 5 minutes cost 0.9 points of root-cause accuracy, so 10 minutes was chosen. Tests: `test_engine_causal_order.py`.

## Not fixed — needs a decision and ground truth

Tried offline on the real recording (`replay_variants.py` style harness, not committed):

| Variant | Real recording | Held-out benchmark |
|---|---|---|
| Late signals must sit within the 15-min window of the member they link to | no change (chain is continuous) | not run |
| A dependency edge between two *different* services needs corroboration (similar wording, same component, or the service named in the evidence) — **always** | splits the blob into coherent incidents (payments+agency-db, comms, rulesforge, carrier leak) | **F1 0.686 → 0.602, recall 0.84 → 0.73**, 9 existing tests fail |
| The same corroboration rule, only for pairs > 5 min apart | no change (chaining is via short-range links) | unchanged |

So the strict rule fixes the real case but costs accuracy on generated estates, and the mild rule does nothing. The
generated estates are not a good proxy for this estate, so we should not decide on them alone.

**Suggested next step (task I4/I3 in `docs/TASKS.md`):** hand-label the recording into its true stories (the simulator's
scenarios are recognisable by service and time), and use that as the ground truth to tune the gate and `EPS`. Then
re-run the strict-corroboration variant against it. Options to try, best guess first:

1. Corroboration required only between *different* services whose only link is a bare dependency edge, with the wording
   test using the metric/alarm name and component, not just log templates.
2. Split a long incident at internal quiet gaps or at a story boundary (root-cause centres that disagree), extending the
   existing `refine_clusters` split beyond onset-time ties.
3. Cap incident duration for auto-extension (a signal more than N minutes after the last one starts a new incident).

Until then, treat any incident spanning more than ~20 minutes or more than 5 services as "review for merged stories".
