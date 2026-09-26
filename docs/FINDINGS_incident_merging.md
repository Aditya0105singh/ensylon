# Finding: separate stories merge into one long incident on real data

**Status: resolved for the large cases (2026-09-26, second pass). See "Resolution" at the bottom.**

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
5 minutes after it, and a dependent only counts toward reach if it did not fail more than 5 minutes before the
candidate (`causal.PRECEDENCE_TOLERANCE_S`). First set to 10 minutes, which kept the generated benchmark unchanged
(root cause 0.969; 3 minutes cost 0.9 points). After the weights were re-tuned (second pass below) 10 minutes got 1 of
11 real roots wrong and 5 minutes got all 11, with the benchmark still fine, so it is now 5.
Tests: `test_engine_causal_order.py`.

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


---

## Resolution (second pass)

We built ground truth instead of guessing. `tools/label_recording.py` labels a recording with the incident each signal
belongs to, using readable keyword rules per simulator scenario; `backend/app/engine/groundtruth.py` scores the
engine's incidents against it (pair precision/recall/F1, purity, completeness, root cause). Fixture and labels:
`backend/tests/fixtures/live_session_2026-09-26.*`. Reproduce: `python tools/eval_recording.py <recording> <labels>`.

**What the real data showed** (1,307 signals, 17 true incidents, seven overlapping scenarios plus decoys). On the
original weights the engine scored **pair F1 0.347, purity 0.59**. Over 4,000+ same-window pairs:

| dimension | separates same-story from different-story pairs (AUC) |
|---|---|
| time | **0.89** |
| same service | 0.69 |
| dependency closeness | 0.68 (the 12-service graph is dense; almost everything is one hop apart) |
| wording (template / token overlap) | 0.58 (0.55 with IDF weighting, so that was not the answer) |
| component | 0.58 |

and one service takes part in several concurrent stories (payments-service in four), so "same service" links unrelated
incidents.

**What changed**
1. Weights re-tuned on the labelled run (random search then hill-climb), then cross-checked on the generated benchmark:
   time 0.36, service 0.06, dependency 0.33, evidence 0.19, component 0.06; time scale 1 min; merge threshold 0.45.
   Time's maximum contribution (0.36) stays below the threshold, so time alone still cannot merge two signals (tested).
2. A signal that names another service ("Circuit breaker OPEN for payments-service") now earns at least 0.6 evidence
   agreement, not only a pass through the gate. The full 1.0 hurt real precision; 0.6 is the largest value that leaves
   the real-data metrics unchanged.
3. Causal precedence (first pass): a cause cannot fail more than 5 minutes after the services it broke.
4. Late signals are held to the same threshold; the demo helpers and two tests were updated to model a genuine late
   arrival (close in time, repeating the victim's own error).

**Result** (real / generated held-out):

| | before | after |
|---|---|---|
| real pair F1 | 0.347 | **0.571** |
| real purity | 0.59 | **0.90** |
| real root cause (incidents dominated by one story) | 6/6 | **13/13** |
| generated F1 | 0.686 | **0.713** |
| generated root cause | 0.969 | 0.974 |

**Tried and rejected:** requiring corroboration for every dependency-only link (F1 0.686 to 0.602 on generated data, 9
tests broke); the same only beyond 5 minutes (no effect on the real case); IDF-weighted text similarity (no better than
the current wording term); a wider window for late attachment (chain is continuous, not a time gap).

**Still open**
- Grafana evaluates every rule at the same instant, so alerts of unrelated stories arrive together with no wording in
  common. That leaves one small mixed fragment (8 signals, 5 stories). Needs semantic similarity (embeddings) or per-rule
  metadata; not attempted.
- Stories can be split into several incidents (completeness 0.65, unchanged). A merge-by-root step for incidents that
  share a root cause and are close in time is the obvious next experiment.
- The labels are our reading of the wording, not the organisers' key. Ask the organisers whether one exists.
- The weights are tuned on one 3-hour recording. Re-run the search on a second recording before trusting them for the
  final run (`tools/label_recording.py` then `tools/eval_recording.py`).


---

## Fragment merging and reassignment: evaluated, not shipped

Asked for: merge incidents that share a root cause and are close in time, to raise completeness (0.65). Prototyped
offline on the labelled recording before touching the live path. It does not help:

| variant | pair F1 | purity | completeness |
|---|---|---|---|
| current engine | 0.571 | 0.90 | 0.65 |
| merge incidents with the same root, gap <= 5 / 10 / 15 min (also with structural link, wording, component) | 0.544 | 0.87 | 0.66 |
| the same, gap <= 25 min | 0.479 | 0.58 | 0.67 |
| reassign each signal to the incident it is most similar to (top-3 mean, margin 0) | 0.572 | 0.91 | 0.68 |

Why: the remaining "fragments" are mostly not fragments.
- Several are **single stray signals** inside the wrong incident: Grafana fires every rule at one instant (10:24, 10:27:56),
  so an alert of one story is coincident in time and one hop from another story's services. Reassignment moves a few of
  them (mixed incidents 5 to 3, split stories 7 to 5) but the gain is inside the noise and needs pairwise similarity
  over every incident in the live path, so it was not adopted.
- Two stories share a root service but are different problems (rulesforge batch job vs rulesforge slow query), so
  merging by root wrongly joins them: purity falls.
- The carrier leak's "three pieces" are two phases 26 minutes apart that the labeller glued together.

**The headline pair F1 depends on that one labelling decision.** Re-scoring the same engine output:

| carrier leak labelled as | true stories | pair F1 | purity | completeness |
|---|---|---|---|---|
| one story (gap 25 min, as committed) | 17 | 0.571 | 0.90 | 0.65 |
| two phases (gap 15 min) | 18 | 0.685 | 0.90 | 0.65 |
| two phases (gap 10 min) | 19 | 0.705 | 0.90 | 0.62 |

So quote the real-data result as "pair F1 0.57 to 0.70 depending on how one ambiguous story is labelled; purity 0.90 and
13 of 13 root causes either way". Purity and root cause are the stable numbers. To settle it we need the organisers'
answer key or a second recording with a different label owner.

Next experiments, if more accuracy is wanted: per-rule metadata for the simultaneous Grafana burst; semantic (embedding)
similarity for wording across sources; and a second labelled recording to tune on and to hold out.
