"""Synthetic alert generator for the Alert Correlation & Dedup Engine.

Simulates the alert flood a monitoring stack (Prometheus / Datadog / custom app)
produces during real infrastructure incidents. Each incident scenario is a
cascade: one root-cause failure that ripples across dependent services, the way
a single Redis outage trips alerts in every service that depends on it.

Every alert carries a hidden ``ground_truth`` label (which incident produced it,
or "noise"). The pipeline never reads it — it exists so we can report REAL
evaluation numbers (clustering accuracy, noise reduction %) instead of claims.

Usage:
    python synthetic_alert_generator.py --incidents 3 --noise 20 --out alerts.json
"""

from __future__ import annotations

import argparse
import json
import random
import uuid
from datetime import datetime, timedelta

SOURCES = ["prometheus", "datadog", "custom-app", "gcp-monitoring", "grafana"]

# Each scenario: root cause fires first, then dependent services cascade.
# (service, alertname, message template, severity, cascade delay range in seconds)
INCIDENT_SCENARIOS = {
    "db_connection_exhaustion": {
        "description": "Postgres connection pool exhausted, downstream APIs starve",
        "root": ("postgres-primary", "DBConnectionPoolExhausted",
                 "Connection pool exhausted: 200/200 connections in use, 148 queued", "critical"),
        "cascade": [
            ("api-gateway", "UpstreamTimeout",
             "Upstream timeout: 34% of requests to order-api exceeding 5s", "critical", (20, 90)),
            ("order-api", "HighErrorRate",
             "HTTP 5xx rate at 22% (threshold 5%) over last 5m", "critical", (30, 120)),
            ("checkout-service", "HighLatency",
             "p99 latency 8.4s (SLO 800ms) on /checkout/confirm", "high", (60, 180)),
            ("order-api", "DBQueryTimeout",
             "Query timeout: SELECT on orders table exceeded 30s statement_timeout", "high", (15, 60)),
            ("notification-service", "QueueBacklog",
             "Message queue depth 12,400 and rising, consumers stalled", "high", (120, 300)),
        ],
    },
    "redis_memory_pressure": {
        "description": "Redis hits maxmemory, cache misses hammer the database",
        "root": ("redis-cache", "RedisMemoryCritical",
                 "Used memory 3.9GB/4.0GB (97%), evictions active: 1,240 keys/min", "critical"),
        "cascade": [
            ("session-service", "CacheMissRateHigh",
             "Cache miss rate 68% (baseline 4%), falling through to DB", "high", (20, 80)),
            ("postgres-primary", "HighCPU",
             "CPU at 91% — read query volume 6x baseline", "high", (60, 180)),
            ("api-gateway", "HighLatency",
             "p95 latency 3.1s (SLO 500ms) across all authenticated routes", "high", (90, 240)),
            ("session-service", "SessionLookupErrors",
             "Session lookup failures: 840/min, users being logged out", "critical", (60, 200)),
        ],
    },
    "disk_full_logging": {
        "description": "Log partition fills up, services crash-loop on write failures",
        "root": ("worker-node-3", "DiskUsageCritical",
                 "Disk usage /var/log at 98.7%, 1.2GB remaining", "critical"),
        "cascade": [
            ("payment-worker", "PodCrashLooping",
             "Pod payment-worker-7d4f restarting: CrashLoopBackOff (write /var/log: no space left)", "critical", (60, 240)),
            ("worker-node-3", "KubeletUnhealthy",
             "Kubelet PLEG unhealthy, node flapping Ready/NotReady", "high", (120, 300)),
            ("payment-worker", "JobProcessingStalled",
             "Payment job throughput 0/min for 4m (baseline 220/min)", "critical", (180, 360)),
            ("log-shipper", "LogExportFailures",
             "Log export failing: cannot write spool to /var/log, 3,100 events dropped", "high", (30, 150)),
            ("worker-node-3", "InodeUsageHigh",
             "Inode usage on /var/log partition at 96%", "high", (60, 200)),
        ],
    },
    "auth_cascade_failure": {
        "description": "Identity provider degraded, auth failures cascade to every client app",
        "root": ("auth-service", "TokenValidationErrors",
                 "JWT validation failing: JWKS endpoint returning 503, 96% error rate", "critical"),
        "cascade": [
            ("api-gateway", "AuthRejectionSpike",
             "401 responses up 40x baseline: 2,300/min", "critical", (10, 40)),
            ("mobile-bff", "LoginFailureRate",
             "Login success rate dropped to 3% (baseline 99.2%)", "critical", (30, 90)),
            ("checkout-service", "SessionValidationTimeout",
             "Session validation calls timing out, cart abandonment rising", "high", (60, 150)),
            ("support-portal", "LoginFailureRate",
             "Agent login failures: 100% since 5m ago", "high", (90, 200)),
        ],
    },
    "network_packet_loss": {
        "description": "ToR switch degradation causes packet loss between AZ subnets",
        "root": ("network-fabric", "PacketLossHigh",
                 "Packet loss 12% between subnet-a and subnet-c (threshold 0.5%)", "critical"),
        "cascade": [
            ("order-api", "GRPCDeadlineExceeded",
             "gRPC DEADLINE_EXCEEDED on inventory-service calls: 18%/min", "high", (30, 100)),
            ("inventory-service", "ReplicationLag",
             "Read-replica lag 47s and climbing (threshold 5s)", "high", (60, 180)),
            ("kafka-broker-2", "ISRShrink",
             "In-sync replica set shrunk for 14 partitions", "critical", (90, 240)),
            ("metrics-collector", "ScrapeFailures",
             "Scrape failures for 23 targets in subnet-c", "info", (30, 120)),
        ],
    },
}

# Routine alerts unrelated to any incident — the background noise every real
# ops feed has. These should NOT end up inside incident clusters. Status is
# explicit per entry: "resolved" for one-off completed events, "firing" for
# ongoing low-severity conditions — gives the feed a realistic status mix
# without random chance calls (stays reproducible under a seed).
NOISE_ALERTS = [
    ("backup-service", "BackupCompleted", "Nightly backup completed in 42m (within window)", "info", "resolved"),
    ("cert-manager", "CertExpirySoon", "TLS cert for internal.example.com expires in 21 days", "info", "firing"),
    ("autoscaler", "ScaleUpEvent", "HPA scaled web-frontend 4 -> 6 replicas on CPU signal", "info", "firing"),
    ("cron-runner", "JobSlowWarning", "Job cleanup-temp-files took 8m (usual 5m)", "info", "firing"),
    ("cdn-edge", "CacheHitRatioDip", "CDN cache hit ratio 89% (baseline 93%)", "info", "firing"),
    ("staging-api", "HighLatency", "p99 latency 2.1s on staging environment", "info", "firing"),
    ("dev-cluster", "PodEvicted", "Pod test-runner-x9 evicted (node memory pressure) in dev", "info", "resolved"),
    ("license-monitor", "UsageReport", "Monthly license usage report generated", "info", "resolved"),
    ("security-scanner", "ScanCompleted", "Weekly CVE scan completed: 3 low findings", "info", "resolved"),
    ("dns-monitor", "LookupSlowWarning", "DNS lookup p95 380ms via resolver-2", "info", "firing"),
]


def _make_alert(service: str, alertname: str, message: str, severity: str,
                ts: datetime, ground_truth: str, status: str = "firing") -> dict:
    return {
        "id": str(uuid.uuid4()),
        "service": service,
        "alertname": alertname,
        "message": message,
        "severity": severity,          # info | high | critical
        "status": status,              # firing | suppressed | resolved
        "timestamp": ts.isoformat(timespec="seconds"),
        "source": random.choice(SOURCES),
        "assignee": "n/a",
        "dismissed": status != "firing",
        "ground_truth": ground_truth,  # evaluation only — pipeline must not read this
    }


def _emit_with_duplicates(alert_args: tuple, ts: datetime, ground_truth: str,
                          max_dups: int) -> list[dict]:
    """Real monitoring re-fires the same alert every eval interval — emit
    1..max_dups near-identical copies so the dedup layer has work to do.
    The first copy stays "firing"; monitoring tools mark repeat fires of an
    already-known alert as "suppressed" rather than re-alerting each time."""
    service, alertname, message, severity = alert_args
    copies = random.randint(1, max_dups)
    return [
        _make_alert(service, alertname, message, severity,
                    ts + timedelta(seconds=i * random.randint(25, 65)), ground_truth,
                    status="firing" if i == 0 else "suppressed")
        for i in range(copies)
    ]


def generate_incident(scenario_key: str, start: datetime, max_dups: int = 4) -> list[dict]:
    scenario = INCIDENT_SCENARIOS[scenario_key]
    alerts = _emit_with_duplicates(scenario["root"], start, scenario_key, max_dups)
    for service, alertname, message, severity, (lo, hi) in scenario["cascade"]:
        fire_at = start + timedelta(seconds=random.randint(lo, hi))
        alerts += _emit_with_duplicates((service, alertname, message, severity),
                                        fire_at, scenario_key, max_dups)
    return alerts


def generate_batch(n_incidents: int = 3, n_noise: int = 20,
                   window_minutes: int = 45, seed: int | None = None,
                   noise_window_hours: float | None = None,
                   force_scenario: str | None = None) -> list[dict]:
    """Generate a realistic alert batch: n_incidents cascading incidents plus
    background noise, spread over window_minutes.

    noise_window_hours (optional): spread background noise over a much wider
    historical range ("2 days ago" style variety for the Feed's Last Received
    column) instead of cramming it into window_minutes. Left as None by
    default so existing eval/notebook calls stay bit-for-bit reproducible;
    the live dashboard demo passes this explicitly for visual realism.

    force_scenario (optional): guarantee this incident scenario is in the
    batch — lets a live-demo audience pick which failure to inject.
    """
    if seed is not None:
        random.seed(seed)
        # Fixed base time so seeded runs are fully reproducible — dedup's
        # time buckets otherwise shift with wall-clock time between runs.
        base = datetime(2026, 7, 16, 10, 0, 0)
    else:
        base = datetime.now().replace(microsecond=0) - timedelta(minutes=window_minutes)
    now_anchor = base + timedelta(minutes=window_minutes)
    scenarios = random.sample(list(INCIDENT_SCENARIOS), k=min(n_incidents, len(INCIDENT_SCENARIOS)))
    if force_scenario and force_scenario in INCIDENT_SCENARIOS:
        if force_scenario in scenarios:
            scenarios.remove(force_scenario)
        else:
            scenarios = scenarios[:-1]
        # last slot = most recent in the window, so the chosen failure is the
        # freshest incident on screen when the storm finishes
        scenarios.append(force_scenario)

    # One incident per time slot: real incidents rarely start simultaneously,
    # and overlapping starts make even human operators merge them.
    slot_seconds = (window_minutes * 60) // max(len(scenarios), 1)
    alerts: list[dict] = []
    for i, key in enumerate(scenarios):
        jitter = random.randint(0, max(slot_seconds - 600, 1))
        alerts += generate_incident(key, base + timedelta(seconds=i * slot_seconds + jitter))

    for _ in range(n_noise):
        service, alertname, message, severity, status = random.choice(NOISE_ALERTS)
        if noise_window_hours:
            ts = now_anchor - timedelta(seconds=random.randint(0, int(noise_window_hours * 3600)))
        else:
            ts = base + timedelta(seconds=random.randint(0, window_minutes * 60))
        alerts.append(_make_alert(service, alertname, message, severity,
                                  ts=ts, ground_truth="noise", status=status))

    alerts.sort(key=lambda a: a["timestamp"])
    return alerts


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--incidents", type=int, default=3)
    parser.add_argument("--noise", type=int, default=20)
    parser.add_argument("--window", type=int, default=45, help="time window in minutes")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--noise-window-hours", type=float, default=None)
    parser.add_argument("--out", type=str, default="alerts.json")
    args = parser.parse_args()

    alerts = generate_batch(args.incidents, args.noise, args.window, args.seed,
                            noise_window_hours=args.noise_window_hours)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(alerts, f, indent=2)

    by_truth: dict[str, int] = {}
    for a in alerts:
        by_truth[a["ground_truth"]] = by_truth.get(a["ground_truth"], 0) + 1
    print(f"Wrote {len(alerts)} alerts to {args.out}")
    for k, v in sorted(by_truth.items()):
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
