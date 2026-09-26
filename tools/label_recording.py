"""Label a recorded simulator session with the incident each signal belongs to.

The live streams carry no ground truth, so this builds one by hand-written,
reviewable rules. The simulator runs a handful of overlapping scenarios, each
with its own wording, plus decoys. Reading a recording, the stories are:

  carrier_leak      carrier-service memory leak -> OOM, and its symptoms
                    (gateway 503s on /policies, comms "policy event" failures)
  payments_config   payments 5xx after a config deploy (cfg-0926-1)
  cdn_latency       gateway latency / 504s from an external CDN
  rulesforge_batch  the nightly batch job holding rulesforge's DB connections
  agencydb_pool     agency-db pool exhaustion -> payments -> enrollment
  rulesforge_slow   slow risk-rules query -> payments FallbackMode
  comms_smtp        comms-service SMTP relay outage
  decoy             routine warnings that are not an incident
  unsure            anomalous but ambiguous; left out of scoring

A story repeats in rounds; signals of one story more than GAP_MIN (15) minutes apart
(25 for the long carrier leak)
are separate incidents (story#1, story#2, ...).

    python tools/label_recording.py <recording.jsonl> <labels.json>
"""

from __future__ import annotations

import json
import re
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from app.engine import recording  # noqa: E402
from app.engine.signal import Severity, SignalSource  # noqa: E402

# The service each story really starts at, judged from the wording of its signals.
# cdn_latency's origin is an external CDN, seen first at the gateway.
ROOTS = {
    "carrier_leak": "carrier-service", "payments_config": "payments-service", "cdn_latency": "agency-gateway",
    "rulesforge_batch": "rulesforge", "agencydb_pool": "agency-db", "rulesforge_slow": "rulesforge",
    "comms_smtp": "comms-service",
}
GAP_MIN = 15.0
# The carrier leak is one long scenario with quiet stretches inside it.
GAP_OVERRIDE = {"carrier_leak": 25.0}

# (story, service or None, regex on the lower-cased message). First match wins,
# so more specific rules come first.
RULES: list[tuple[str, str | None, str]] = [
    # decoys and ambiguous lines first
    ("decoy", "docforge", r".*"),
    ("decoy", "carrier-service", r"slow response from carrier gateway"),
    ("decoy", "comms-service", r"soft-bounced"),
    ("decoy", "enrollment-service", r"session .* expired"),
    ("unsure", "agency-gateway", r"approaching rate limit"),
    ("unsure", "carrier-service", r"downstream timeouts"),
    # carrier leak and its symptoms
    ("carrier_leak", "agency-gateway", r"upstream carrier-service|half_open for carrier|policy endpoints returning 503|/policies/"),
    ("carrier_leak", "comms-service", r"policy event"),
    # agency-db cascade (carrier's payment-confirmation lines are its symptoms)
    ("agencydb_pool", "carrier-service", r"premium payment confirmation|dead-letter"),
    ("carrier_leak", "carrier-service",
     r"memory|gc time|gc pause|healthy host|heap|oom|outofmemory|slow query|container restarted|warm-up|"
     r"policy lookup timed out|policy submission rejected|5xx rate|p99 latency|requests failing"),
    # cdn
    ("cdn_latency", "agency-gateway", r"cdn\.fastedge|/static/|external cdn|origin cdn|latency"),
    # payments
    ("payments_config", "payments-service", r"after deploy|config deploy|configreload|cfg-0926"),
    ("agencydb_pool", "payments-service", r"connection pool|no free connection|pool saturated|premium collection failed|"
                                          r"no db connection|for 3 periods|above the 10% threshold"),
    ("rulesforge_slow", "payments-service", r"rulesforge call|fallbackmode|requests returning 503|5xx rate"),
    # rulesforge
    ("rulesforge_batch", "rulesforge", r"rules_rescore|batch window|exhausted by batch|prod-rulesforge-db connections|holds \d+/\d+"),
    ("rulesforge_slow", "rulesforge", r"p99|latency|timeout|backlog|connection held|long-running|error rate"),
    # agency-db and enrollment
    ("agencydb_pool", "agency-db", r".*"),
    ("agencydb_pool", "enrollment-service", r"upstream call to payments|circuit breaker open for payments|p99|latency"),
    # comms
    ("comms_smtp", "comms-service", r"smtp|retry queue|failed to deliver|tls handshake|sms fallback|giving up|queue depth|delivery failure"),
]
_COMPILED = [(s, svc, re.compile(rx)) for s, svc, rx in RULES]


def is_candidate(sig) -> bool:
    """Alarms and alerts, plus warning-or-worse log lines."""
    if sig.source in (SignalSource.CLOUDWATCH_METRIC.value, SignalSource.GRAFANA_ALERT.value):
        return True
    return sig.severity in (Severity.CRITICAL.value, Severity.HIGH.value, Severity.WARNING.value)


def story_of(sig) -> tuple[str, int] | None:
    text = (sig.message or sig.metric or "").lower()
    for idx, (story, svc, rx) in enumerate(_COMPILED):
        if (svc is None or svc == sig.service) and rx.search(text):
            return story, idx
    return None


def label(signals) -> dict[str, dict]:
    assigned: dict[str, dict] = {}
    by_story: dict[str, list] = {}
    for s in sorted(signals, key=lambda x: x.timestamp):
        if not is_candidate(s):
            continue
        hit = story_of(s)
        if hit is None:
            continue
        story, rule = hit
        assigned[s.id] = {"story": story, "rule": rule, "at": s.timestamp.isoformat(), "service": s.service}
        if story not in ("decoy", "unsure"):
            by_story.setdefault(story, []).append(s)
    for story, sigs in by_story.items():
        gap = timedelta(minutes=GAP_OVERRIDE.get(story, GAP_MIN))
        instance, last = 1, None
        for s in sigs:  # already time-ordered
            if last is not None and s.timestamp - last > gap:
                instance += 1
            last = s.timestamp
            assigned[s.id]["incident"] = f"{story}#{instance}"
            assigned[s.id]["root"] = ROOTS[story]
    return assigned


def main() -> None:
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    sigs = recording.load(src).signals
    labels = label(sigs)
    dst.write_text(json.dumps(labels, indent=0, sort_keys=True), encoding="utf-8")
    counts: dict[str, int] = {}
    for v in labels.values():
        key = v.get("incident", v["story"])
        counts[key] = counts.get(key, 0) + 1
    print(f"{len(sigs)} signals, {len(labels)} labelled")
    for k in sorted(counts):
        print(f"  {k:22s} {counts[k]:4d}")


if __name__ == "__main__":
    main()
