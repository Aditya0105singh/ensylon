"""Remediation playbook derived from what the incident actually is.

Each step is built from facts the pipeline established - the root-cause alert
and its service, the affected services, the alert text, and (when there is one)
the real resolution of a matched past incident. The category of guidance is
chosen by matching the incident's own alert text against a small set of known
failure families; if nothing matches it says so and falls back to generic
triage rather than guessing a technology stack.

Deliberately absent, because nothing in the data supports them: invented
thresholds ("5xx below 0.1%"), an assumed platform (Kubernetes, Postgres,
Prometheus), and any cost or revenue estimate. The earlier version produced a
"$14,000 per service" revenue figure from nothing; that is gone, not hidden.
"""

from __future__ import annotations

import re
from typing import Any

# Failure families, matched against the incident's own alert text. Each gives
# the checks that are actually meaningful for that kind of failure. Order
# matters: the first family whose pattern matches wins.
_FAMILIES: list[tuple[str, re.Pattern[str], list[tuple[str, str]]]] = [
    (
        "memory / ECC",
        re.compile(r"\b(ddr|ecc|parity|dcache|icache|cache unit|machine check|ce sym|memory)\b", re.I),
        [
            ("Check hardware error counters",
             "Read the correctable/uncorrectable memory error counters on {svc}. A rising correctable count ahead of the incident points to a degrading module."),
            ("Identify the affected node",
             "The alerts carry node locations; confirm whether the errors concentrate on one node or are spread across several."),
            ("Drain or isolate the node if errors persist",
             "If correctable errors keep climbing on one node, drain its workload and take it out of the scheduler before errors turn uncorrectable."),
        ],
    ),
    (
        "job / kernel termination",
        re.compile(r"\b(kernel terminated|kernterm|job .*(fail|killed)|rts:|exit(ed)? (with|code)|segfault|core file)\b", re.I),
        [
            ("Read the termination reasons",
             "Collect the exit/termination reason codes reported by {svc} and check whether one reason dominates."),
            ("Check for a common job or input",
             "Terminations clustered in time often share a job, input file or allocation; compare them before assuming hardware."),
            ("Re-run one affected job in isolation",
             "Reproduce with a single job to separate a code/input fault from a platform fault."),
        ],
    ),
    (
        "filesystem / mount",
        re.compile(r"\b(mount|lustre|nfs|filesystem|file system|i/?o error|bglio|disk|disk full|no space|inode)\b", re.I),
        [
            ("Check mount status on {svc}",
             "Confirm which mount points are failing and whether the I/O servers behind them are reachable."),
            ("Check the storage servers",
             "Mount failures that fan out across nodes usually trace back to a storage/I-O server, not the clients."),
            ("Remount after the server is healthy",
             "Remount on the affected nodes only once the backing server is confirmed healthy, to avoid a remount storm."),
        ],
    ),
    (
        "network / interconnect",
        re.compile(r"\b(torus|link|interconnect|network|packet|receiver|unreachable|connection refused|packet loss)\b", re.I),
        [
            ("Check link and interface health",
             "Inspect link/interface error counters for {svc} and the paths between the affected services."),
            ("Look for a shared path",
             "Errors on several services at once often share one switch, link or route; find the common hop."),
            ("Fail over or reroute if a link is degraded",
             "If one link is confirmed bad, route around it before it cascades further."),
        ],
    ),
    (
        "control plane / restart",
        re.compile(r"\b(has been started|restart(ed|ing)?|shutting down|shut down|has been stopped|re-?initiali[sz]ed)\b", re.I),
        [
            ("Find out why {svc} restarted",
             "A control process starting mid-incident usually means it crashed or was restarted; check its previous exit and what restarted it."),
            ("Check that what it manages came back",
             "Confirm the resources {svc} controls re-registered after the restart instead of staying orphaned."),
            ("Watch for a restart loop",
             "Repeated start events in a short window point to a crash loop rather than a one-off restart."),
        ],
    ),
    (
        "service / application",
        # Only "5xx"/"http 5nn": a bare 5\d\d also matched IPs, ports and counts,
        # and a bare "db" matched startup flags like --dbproperties.
        re.compile(r"\b(5xx|http\s*5\d\d|http|latency|error rate|connection pool|pool exhausted|deadline|grpc|database|query|token|auth|cache|redis|miss rate|queue|backlog|timeout|timed out)\b", re.I),
        [
            ("Check {svc} health and recent changes",
             "Look at {svc}'s error rate and latency, and at any deploy or config change shortly before the first alert."),
            ("Check the dependency it reports on",
             "The root alert's text names what {svc} was waiting on or failing against; check that dependency next."),
            ("Roll back or scale the offending change",
             "If a recent change lines up with the first alert, revert it; if load does, scale out."),
        ],
    ),
]


def _classify(texts: list[str]) -> tuple[str | None, list[tuple[str, str]]]:
    # Alert names are often CamelCase ("DiskUsageCritical"), which a \b word
    # boundary can't see inside; split them so "disk"/"cache" become words.
    blob = re.sub(r"([a-z])([A-Z])", r"\1 \2", " ".join(texts))
    for name, pattern, steps in _FAMILIES:
        if pattern.search(blob):
            return name, steps
    return None, [
        ("Read the root-cause alert on {svc}",
         "No known failure family matched this incident's alert text, so start from the root alert and its surrounding log lines on {svc}."),
    ]


def _name_services(services: list[str], limit: int = 4) -> str:
    """Names the affected services, and says how many were left out so a
    truncated list is never presented as the whole set. Empty for no services,
    which lets callers fall back to the root service."""
    shown = ", ".join(services[:limit])
    hidden = len(services) - limit
    return f"{shown} and {hidden} more" if hidden > 0 else shown


def generate_playbook(cluster: dict[str, Any]) -> dict[str, Any]:
    if not cluster:
        return {
            "title": "No incident",
            "priority": "High P2",
            "failure_family": None,
            "estimated_resolution": None,
            "resolution_basis": "no incident",
            "confidence": None,
            "steps": [],
            "validation": [],
            "rollback": [],
            "impact": {},
        }

    root = cluster.get("root_cause") or {}
    risk = cluster.get("risk") or {}
    dna = cluster.get("dna_match")
    alerts = sorted(cluster.get("alerts") or [], key=lambda a: a.get("timestamp", ""))

    root_svc = root.get("service", "the root service")
    root_name = root.get("alertname", "the root alert")
    root_sev = root.get("severity", "high")
    services = list(dict.fromkeys(a.get("service") for a in alerts if a.get("service")))
    downstream = [s for s in services if s != root_svc]

    priority = "Critical P1" if risk.get("level") == "high" or root_sev == "critical" else "High P2"

    texts = [root_name, root.get("message", "")] + [a.get("alertname", "") for a in alerts[:20]]
    family, family_steps = _classify(texts)

    steps: list[dict[str, Any]] = [
        {
            "title": f"Confirm the root cause on {root_svc}",
            "description": f"The earliest alert in this incident is \"{root_name}\" on {root_svc}"
            + (f", followed by {len(downstream)} other service(s)." if downstream else "."),
        }
    ]
    for title, desc in family_steps:
        steps.append({
            "title": title.format(svc=root_svc),
            "description": desc.format(svc=root_svc),
        })
    if dna and dna.get("resolution"):
        steps.append({
            "title": f"Apply the fix that resolved {dna.get('incident_id')}",
            "description": f"This incident is {dna.get('similarity_pct')}% similar to {dna.get('incident_id')}, "
            f"which was resolved by: {dna.get('resolution')}",
        })
    # Name the services to watch, not just how many: the rendered playbook is
    # the only place the operator sees them, and with nothing downstream (or no
    # alerts at all) the root service is the honest fallback.
    where = (
        f"across {len(services)} service(s): {_name_services(services)}"
        if services
        else f"on {root_svc}"
    )
    steps.append({
        "title": "Confirm the alerts stop",
        "description": f"Watch for \"{root_name}\" and the {cluster.get('size', len(alerts))} related alert(s) "
        f"to stop firing {where}.",
    })

    for i, s in enumerate(steps, 1):
        s["step_number"] = i

    # Only a matched past incident gives a real baseline for time-to-resolve.
    # The previous version reused triage-minutes-saved here, which is a
    # different quantity; without a match there is honestly no estimate.
    if dna and dna.get("resolution_minutes"):
        estimated = f"~{dna['resolution_minutes']} minutes"
        basis = f"resolution time of {dna.get('incident_id')}"
    elif dna:
        estimated = None
        basis = f"{dna.get('incident_id')} matched but records no resolution time"
    else:
        estimated = None
        basis = "no similar past incident to estimate from"

    return {
        "title": f"{root_svc} — {family or 'unclassified'} incident",
        "priority": priority,
        "failure_family": family,
        "estimated_resolution": estimated,
        "resolution_basis": basis,
        "confidence": dna.get("similarity_pct") if dna else None,
        "steps": steps,
        "validation": [
            f"\"{root_name}\" stops firing on {root_svc}",
            f"No new alerts from {_name_services(services) or root_svc} for a full correlation window",
        ],
        "rollback": [
            f"If a change to {root_svc} preceded the first alert, revert it",
            "Escalate to the owning team if the alerts continue after the steps above",
        ],
        "impact": {
            "services_affected": services,
            "signals": cluster.get("size", len(alerts)),
            "raw_alerts": cluster.get("raw_alert_count"),
        },
    }
