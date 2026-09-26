"""Synthetic scenario generator with ground truth.

Correlation quality cannot be asserted, it has to be measured — and measuring
it requires knowing which signals genuinely belong together. Because this
generator *injects* the faults, it knows exactly that, which is what turns
"the clusters look right" into a precision and recall number.

Diversity is the whole point of this module. A benchmark built from one
topology and a handful of hand-written incidents measures how well the system
fits those incidents, not whether it works. So there are four topologies with
genuinely different shapes (deep chains, wide fan-out, shallow leaf-heavy),
a library of failure archetypes assigned to services by *role* rather than by
name, and telemetry degradation modes — because in a real estate, tracing
isn't deployed everywhere, plenty of incidents never trip a metric alarm, and
the dependency graph is always partly unknown.

Payloads are emitted in each source's native shape rather than as Signal
objects, so every run exercises the adapters too. Ground truth is returned
separately, keyed by (source, service, timestamp), rather than embedded in
the telemetry: a benchmark the system could read the answer from measures
nothing.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Iterable

import networkx as nx

from .signal import Signal

# --------------------------------------------------------------------------
# topologies
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Topology:
    """A service estate: who calls whom, and what each service is for.

    `roles` is what lets failure archetypes be written once and hosted by any
    estate — a connection-pool exhaustion belongs on whatever plays the
    `datastore` role here, not on a service hard-coded by name.
    """

    name: str
    edges: dict[str, list[str]]          # caller -> callees
    roles: dict[str, str]                # service -> role
    criticality: dict[str, float]

    def services(self) -> set[str]:
        out = set(self.edges)
        for callees in self.edges.values():
            out |= set(callees)
        return out | set(self.roles)

    def of_role(self, role: str) -> list[str]:
        return sorted(s for s, r in self.roles.items() if r == role)

    def digraph(self) -> nx.DiGraph:
        graph = nx.DiGraph()
        graph.add_nodes_from(self.services())
        for caller, callees in self.edges.items():
            for callee in callees:
                graph.add_edge(caller, callee)
        return graph

    def dependents_of(self, service: str) -> list[str]:
        """Services that transitively call this one — its blast radius."""
        graph = self.digraph()
        if service not in graph:
            return []
        return sorted(nx.ancestors(graph, service))


ECOMMERCE = Topology(
    name="ecommerce",
    edges={
        "web-frontend": ["api-gateway"],
        "api-gateway": ["checkout-bff", "auth-service"],
        "checkout-bff": ["order-api", "payment-svc"],
        "order-api": ["postgres-primary", "redis-cache"],
        "payment-svc": ["postgres-primary", "stripe-gateway"],
        "auth-service": ["redis-cache"],
        "session-svc": ["redis-cache"],
        "report-worker": ["postgres-replica"],
    },
    roles={
        "web-frontend": "frontend", "api-gateway": "gateway",
        "checkout-bff": "api", "order-api": "api", "payment-svc": "api",
        "auth-service": "auth", "session-svc": "api",
        "postgres-primary": "datastore", "postgres-replica": "datastore",
        "redis-cache": "cache", "stripe-gateway": "external",
        "report-worker": "worker",
    },
    criticality={
        "payment-svc": 1.0, "checkout-bff": 1.0, "auth-service": 1.0,
        "postgres-primary": 0.95, "stripe-gateway": 0.9, "api-gateway": 0.9,
        "order-api": 0.85, "redis-cache": 0.7, "session-svc": 0.7,
        "web-frontend": 0.65, "postgres-replica": 0.4, "report-worker": 0.3,
    },
)

# Deep chains: the root cause sits four hops from its loudest symptom, which
# is where "earliest alert wins" fails hardest.
MEDIA = Topology(
    name="media",
    edges={
        "cdn-edge": ["playback-api"],
        "playback-api": ["manifest-svc", "drm-service"],
        "manifest-svc": ["catalog-db", "asset-cache"],
        "drm-service": ["license-db"],
        "transcoder-worker": ["asset-cache", "media-queue"],
        "media-queue": ["catalog-db"],
    },
    roles={
        "cdn-edge": "frontend", "playback-api": "gateway",
        "manifest-svc": "api", "drm-service": "auth",
        "catalog-db": "datastore", "license-db": "datastore",
        "asset-cache": "cache", "media-queue": "queue",
        "transcoder-worker": "worker",
    },
    criticality={
        "playback-api": 1.0, "drm-service": 0.95, "cdn-edge": 0.9,
        "manifest-svc": 0.85, "catalog-db": 0.85, "license-db": 0.8,
        "asset-cache": 0.6, "media-queue": 0.5, "transcoder-worker": 0.3,
    },
)

# Wide fan-out from a single bff, plus a genuinely external dependency.
FINTECH = Topology(
    name="fintech",
    edges={
        "mobile-bff": ["ledger-api", "kyc-service", "notification-svc"],
        "ledger-api": ["ledger-db", "fraud-engine"],
        "fraud-engine": ["feature-store", "model-cache"],
        "kyc-service": ["external-kyc-api"],
        "notification-svc": ["message-queue"],
        "settlement-worker": ["ledger-db"],
    },
    roles={
        "mobile-bff": "gateway", "ledger-api": "api", "kyc-service": "api",
        "notification-svc": "api", "fraud-engine": "api",
        "ledger-db": "datastore", "feature-store": "datastore",
        "model-cache": "cache", "message-queue": "queue",
        "external-kyc-api": "external", "settlement-worker": "worker",
    },
    criticality={
        "ledger-api": 1.0, "ledger-db": 1.0, "mobile-bff": 0.95,
        "fraud-engine": 0.9, "external-kyc-api": 0.8, "kyc-service": 0.8,
        "feature-store": 0.6, "model-cache": 0.55, "message-queue": 0.5,
        "notification-svc": 0.45, "settlement-worker": 0.4,
    },
)

# Shallow and leaf-heavy: many services, few hops, so dependency reach is a
# weak discriminator and evidence has to carry the correlation.
IOT = Topology(
    name="iot",
    edges={
        "device-gateway": ["ingest-api", "device-registry"],
        "ingest-api": ["timeseries-db", "stream-queue"],
        "stream-queue": ["rollup-worker", "alert-engine"],
        "rollup-worker": ["timeseries-db"],
        "alert-engine": ["notification-relay"],
        "device-registry": ["registry-db"],
    },
    roles={
        "device-gateway": "gateway", "ingest-api": "api",
        "device-registry": "api", "alert-engine": "api",
        "timeseries-db": "datastore", "registry-db": "datastore",
        "stream-queue": "queue", "rollup-worker": "worker",
        "notification-relay": "external",
    },
    criticality={
        "device-gateway": 0.95, "ingest-api": 0.9, "timeseries-db": 0.85,
        "alert-engine": 0.8, "stream-queue": 0.7, "device-registry": 0.6,
        "registry-db": 0.6, "rollup-worker": 0.35, "notification-relay": 0.4,
    },
)

TOPOLOGIES: list[Topology] = [ECOMMERCE, MEDIA, FINTECH, IOT]

# Kept for backwards compatibility with earlier callers that imported the
# single hard-coded estate.
TOPOLOGY = ECOMMERCE.edges


# --------------------------------------------------------------------------
# failure archetypes
# --------------------------------------------------------------------------


@dataclass(frozen=True)
class Archetype:
    """A failure mode, expressed independently of any particular estate.

    `emits_metric` being False matters: plenty of real incidents never trip a
    metric alarm and are visible only as a log burst. Those are strictly
    harder, because the cleanest evidence a root cause can have — a threshold
    breach with a value — simply isn't there.
    """

    key: str
    role: str
    metric: str | None
    namespace: str
    threshold: float
    breach: float
    reason: str
    log_template: str
    log_repeats: int
    grafana_alert: str | None
    grafana_value: float
    downstream_error: str
    severity: str = "critical"

    @property
    def emits_metric(self) -> bool:
        return self.metric is not None

    @property
    def emits_grafana(self) -> bool:
        return self.grafana_alert is not None


ARCHETYPES: list[Archetype] = [
    # --- datastore ---
    Archetype("db_pool_exhaustion", "datastore", "DatabaseConnections", "AWS/RDS",
              180.0, 200.0, "connection pool saturated",
              "ERROR connection pool exhausted: {n}/200 in use, waiters={w}", 12,
              "HighLatencyP99", 3200.0, "upstream timeout acquiring connection"),
    Archetype("db_disk_full", "datastore", "FreeStorageSpace", "AWS/RDS",
              10.0, 2.7, "free storage below floor",
              "ERROR write rejected: no space left on device, retry={n}", 7,
              "WriteErrorRate", 61.0, "write rejected by upstream storage"),
    Archetype("db_replication_lag", "datastore", "ReplicaLag", "AWS/RDS",
              30.0, 412.0, "replica lag beyond tolerance",
              "WARN stale read detected: replica behind by {n}s", 9,
              "StaleReadRate", 38.5, "stale data returned from replica",
              severity="high"),
    Archetype("db_lock_contention", "datastore", None, "AWS/RDS",
              0.0, 0.0, "lock contention",
              "ERROR deadlock detected on relation orders, victim pid={n}", 11,
              "TransactionAbortRate", 27.4, "transaction aborted by deadlock victim"),
    Archetype("db_slow_query", "datastore", "ReadLatency", "AWS/RDS",
              50.0, 940.0, "query latency spike",
              "WARN slow query {n}ms: seq scan on large relation", 8,
              None, 0.0, "read timeout waiting on query", severity="high"),

    # --- cache ---
    Archetype("cache_memory_pressure", "cache", "DatabaseMemoryUsagePercentage",
              "AWS/ElastiCache", 85.0, 97.0, "maxmemory pressure, evictions climbing",
              "ERROR cache eviction storm: evicted={n} keys in {w}s", 8,
              "CacheMissRateHigh", 71.5, "cache lookup failed, entry unavailable"),
    Archetype("cache_conn_refused", "cache", "CurrConnections", "AWS/ElastiCache",
              5000.0, 6400.0, "connection ceiling reached",
              "ERROR cache connection refused: pool at capacity attempt={n}", 10,
              "CacheErrorRate", 55.0, "cache unreachable, falling through to origin"),

    # --- api ---
    Archetype("api_thread_saturation", "api", None, "AWS/ECS",
              0.0, 0.0, "worker threads saturated",
              "ERROR thread pool saturated: {n}/64 busy, queue depth {w}", 14,
              "RequestQueueDepth", 184.0, "request rejected, no worker available"),
    Archetype("api_memory_leak", "api", "MemoryUtilization", "AWS/ECS",
              80.0, 96.5, "heap growth without release",
              "WARN gc pause {n}ms, heap {w}% after collection", 9,
              "GcPauseP99", 1840.0, "upstream unresponsive during gc pause",
              severity="high"),
    Archetype("api_dependency_timeout", "api", None, "AWS/ECS",
              0.0, 0.0, "downstream call timeouts",
              "ERROR downstream call timed out after {n}ms endpoint=/v1/resolve", 13,
              "DependencyTimeoutRate", 47.2, "dependency timeout propagated upstream"),

    # --- gateway ---
    Archetype("gateway_rate_limit", "gateway", "ThrottleCount", "AWS/ApiGateway",
              100.0, 2840.0, "throttling clients at the edge",
              "WARN request throttled: quota exceeded for tenant-{n}", 10,
              "ThrottleRateHigh", 62.8, "429 returned by edge throttler",
              severity="high"),
    Archetype("gateway_tls_failure", "gateway", None, "AWS/ApiGateway",
              0.0, 0.0, "TLS handshake failures",
              "ERROR tls handshake failed: certificate verify depth={n}", 8,
              "TlsHandshakeErrorRate", 88.0, "tls handshake rejected upstream"),

    # --- auth ---
    Archetype("auth_jwks_outage", "auth", "5XXError", "AWS/ApiGateway",
              5.0, 96.0, "JWKS endpoint returning 503",
              "ERROR jwt validation failed: jwks fetch returned {n} after {w}ms", 15,
              "AuthErrorRateHigh", 96.2, "401 rejected during token refresh"),

    # --- queue ---
    Archetype("queue_consumer_lag", "queue", "ApproximateAgeOfOldestMessage",
              "AWS/SQS", 300.0, 4180.0, "consumers falling behind",
              "WARN consumer lag growing: {n} messages behind head", 9,
              "ConsumerLagHigh", 4180.0, "message processing delayed beyond sla",
              severity="high"),
    Archetype("queue_dlq_growth", "queue", "ApproximateNumberOfMessagesVisible",
              "AWS/SQS", 50.0, 1290.0, "dead letter queue filling",
              "ERROR message moved to dead letter queue after {n} attempts", 11,
              "DlqDepthHigh", 1290.0, "message discarded to dead letter queue"),

    # --- external ---
    Archetype("external_5xx", "external", None, "AWS/ApiGateway",
              0.0, 0.0, "third party returning errors",
              "ERROR third party responded {n}: upstream provider unavailable", 12,
              "ProviderErrorRate", 74.0, "third party provider call failed"),

    # --- worker ---
    Archetype("worker_batch_failure", "worker", None, "AWS/Batch",
              0.0, 0.0, "batch job failures",
              "ERROR batch shard {n} failed after {w} retries", 6,
              "BatchFailureRate", 44.0, "batch output missing for downstream job",
              severity="high"),
]


# --------------------------------------------------------------------------
# telemetry degradation
# --------------------------------------------------------------------------

# Real estates are never fully instrumented. These modes exist because a
# benchmark where every incident arrives with metric, log, trace and Grafana
# evidence is measuring the easy case only.
TELEMETRY_MODES = ("full", "no_traces", "no_metrics", "no_grafana", "logs_only")


# --------------------------------------------------------------------------
# noise
# --------------------------------------------------------------------------

NOISE_LOGS = [
    ("INFO served 200 in {n}ms path=/health", "info"),
    ("INFO scheduled rollup complete rows={n}", "info"),
    ("WARN approaching soft quota for tenant-{n}", "warning"),
    ("INFO webhook received id=evt_{n}", "info"),
    ("INFO warm cache populated keys={n}", "info"),
    ("INFO heartbeat ok uptime={n}s", "info"),
]

NOISE_ALARMS = [
    ("BurstBalance", "AWS/EC2", 40.0, 22.0, "burst credits draining"),
    ("CPUUtilization", "AWS/EC2", 80.0, 84.0, "background job busy"),
]


# --------------------------------------------------------------------------
# result
# --------------------------------------------------------------------------


@dataclass
class Scenario:
    """Raw payloads plus the answer key."""

    topology: Topology = ECOMMERCE
    cloudwatch_alarms: list[dict[str, Any]] = field(default_factory=list)
    cloudwatch_logs: list[dict[str, Any]] = field(default_factory=list)
    grafana_batches: list[dict[str, Any]] = field(default_factory=list)
    otlp_logs: list[dict[str, Any]] = field(default_factory=list)
    otlp_traces: list[dict[str, Any]] = field(default_factory=list)
    truth: dict[tuple[str, str, str], dict[str, Any]] = field(default_factory=dict)
    incident_count: int = 0
    manifest: list[dict[str, Any]] = field(default_factory=list)

    def mark(self, kind: str, service: str, ts: datetime,
             incident: str | None, root: bool = False) -> None:
        self.truth[(kind, service, ts.isoformat())] = {"incident": incident, "root": root}

    def describe(self) -> str:
        parts = [f"{m['incident']}={m['archetype']}@{m['root']}({m['telemetry']})"
                 for m in self.manifest]
        return f"[{self.topology.name}] " + " ".join(parts)


def _res_span(service: str, spans: list[dict]) -> dict:
    return {
        "resource": {"attributes": [
            {"key": "service.name", "value": {"stringValue": service}},
        ]},
        "scopeSpans": [{"spans": spans}],
    }


def _nano(ts: datetime) -> str:
    return str(int(ts.timestamp() * 1e9))


# --------------------------------------------------------------------------
# generator
# --------------------------------------------------------------------------


def generate(
    n_incidents: int = 3,
    noise_signals: int = 40,
    seed: int = 7,
    base_time: datetime | None = None,
    stagger_minutes: float = 45.0,
    topology: Topology | str | None = None,
    telemetry: str | None = None,
) -> Scenario:
    """Build a scenario with `n_incidents` genuine incidents plus background noise.

    `topology` and `telemetry` default to being chosen by the seed, so a sweep
    over seeds genuinely varies estate shape, which services fail and what
    evidence survives — not merely the noise, which is the trap the first
    version of this generator fell into.

    `stagger_minutes=0` makes every incident fire simultaneously — the hard
    case, where a time-window correlator merges all of them and only the
    shared-context gate and causal splitting keep them apart.
    """
    rng = random.Random(seed)
    topo = _resolve_topology(topology, rng)
    t0 = base_time or datetime(2026, 8, 26, 14, 0, 0, tzinfo=timezone.utc)
    sc = Scenario(topology=topo)

    chosen = _choose_archetypes(topo, n_incidents, rng)
    sc.incident_count = len(chosen)

    for idx, (archetype, root_service) in enumerate(chosen):
        incident_id = f"INC-{idx + 1:02d}-{archetype.key}"
        mode = telemetry or rng.choice(TELEMETRY_MODES)
        # A few seconds of offset even when fully concurrent, so identical
        # timestamps cannot collide in the truth map.
        start = t0 + timedelta(minutes=idx * stagger_minutes, seconds=idx * 3)
        emitted = _emit_incident(sc, topo, archetype, root_service, incident_id,
                                 start, mode, rng)
        sc.manifest.append({
            "incident": incident_id, "archetype": archetype.key,
            "root": root_service, "telemetry": mode, "signals": emitted,
        })

    _emit_noise(sc, topo, t0, noise_signals, rng)
    return sc


def _resolve_topology(topology: Topology | str | None, rng: random.Random) -> Topology:
    if isinstance(topology, Topology):
        return topology
    if isinstance(topology, str):
        for candidate in TOPOLOGIES:
            if candidate.name == topology:
                return candidate
        raise ValueError(f"unknown topology {topology!r}")
    return rng.choice(TOPOLOGIES)


def _choose_archetypes(
    topo: Topology, n: int, rng: random.Random
) -> list[tuple[Archetype, str]]:
    """Pick distinct (failure, host service) pairs valid for this estate.

    Two incidents are never hosted on the same service: that would be one
    service with two simultaneous faults, which is a different (and much rarer)
    problem than two independent incidents, and would make the answer key
    ambiguous rather than hard.
    """
    usable = [a for a in ARCHETYPES if topo.of_role(a.role)]
    rng.shuffle(usable)

    chosen: list[tuple[Archetype, str]] = []
    taken: set[str] = set()
    for archetype in usable:
        if len(chosen) >= n:
            break
        hosts = [s for s in topo.of_role(archetype.role) if s not in taken]
        if not hosts:
            continue
        host = rng.choice(hosts)
        chosen.append((archetype, host))
        taken.add(host)
    return chosen


def _emit_incident(
    sc: Scenario, topo: Topology, tpl: Archetype, root_service: str,
    incident_id: str, start: datetime, mode: str, rng: random.Random,
) -> int:
    """Emit one incident's telemetry. Returns how many signals were produced."""
    trace_id = f"trace{abs(hash(incident_id)) % 10**12:012d}"
    emitted = 0

    dependents = topo.dependents_of(root_service)
    # The service that carries the log burst is the nearest caller, since that
    # is where a failing dependency actually surfaces as application errors.
    log_service = dependents[0] if dependents else root_service
    downstream = dependents[1:3]

    want_metric = tpl.emits_metric and mode not in ("no_metrics", "logs_only")
    want_grafana = tpl.emits_grafana and mode not in ("no_grafana", "logs_only")
    want_traces = mode not in ("no_traces", "logs_only")

    # --- 1. root cause: CloudWatch metric alarm ---
    if want_metric:
        sc.cloudwatch_alarms.append({
            "AlarmName": f"{root_service}-{tpl.metric}-alarm",
            "AlarmDescription": tpl.reason,
            "NewStateValue": "ALARM",
            "NewStateReason": (
                f"Threshold Crossed: 1 datapoint [{tpl.breach} "
                f"({start.strftime('%d/%m/%y %H:%M:%S')})] was greater than "
                f"the threshold ({tpl.threshold})."
            ),
            "StateChangeTime": start.isoformat().replace("+00:00", "Z"),
            "Region": "ap-south-1",
            "Trigger": {
                "MetricName": tpl.metric, "Namespace": tpl.namespace,
                "Statistic": "AVERAGE", "Threshold": tpl.threshold,
                "ComparisonOperator": "GreaterThanThreshold",
                "Dimensions": [{"name": "ServiceName", "value": root_service}],
            },
        })
        sc.mark("cloudwatch_metric", root_service, start, incident_id, root=True)
        emitted += 1

    # --- 2. log burst on the nearest caller ---
    # When no metric alarm exists, the burst *is* the incident's origin
    # evidence, so it is emitted on the failing service itself and marked as
    # the root — otherwise the answer key would name a root with no signals.
    burst_service = log_service if want_metric else root_service
    burst_is_root = not want_metric
    events = []
    for i in range(tpl.log_repeats):
        ts = start + timedelta(seconds=8 + i * 3)
        events.append({
            "timestamp": int(ts.timestamp() * 1000),
            "message": tpl.log_template.format(n=rng.randint(120, 999), w=rng.randint(2, 90)),
            "logStreamName": f"{burst_service}/task/{rng.randrange(16**6):06x}",
        })
        sc.mark("cloudwatch_log", burst_service, ts, incident_id,
                root=burst_is_root and i == 0)
        emitted += 1
    sc.cloudwatch_logs.append({
        "logGroupName": f"/aws/ecs/{burst_service}", "events": events,
    })

    # --- 3. Grafana alert, already thresholded by its own rule ---
    if want_grafana:
        g_service = log_service
        g_ts = start + timedelta(seconds=42)
        sc.grafana_batches.append({
            "receiver": "alertlens", "status": "firing",
            "alerts": [{
                "status": "firing",
                "labels": {
                    "alertname": tpl.grafana_alert, "service": g_service,
                    "severity": tpl.severity, "trace_id": trace_id,
                },
                "annotations": {"description": f"{tpl.grafana_alert} on {g_service}"},
                "startsAt": g_ts.isoformat(),
                "valueString": f"[ var='B' labels={{}} value={tpl.grafana_value} ]",
            }],
        })
        sc.mark("grafana_alert", g_service, g_ts, incident_id)
        emitted += 1

    # --- 4. downstream failures, carrying the shared trace ---
    #
    # Span nesting must follow the real call direction: the caller is the
    # parent and the service it calls is the child. Emitting an affected
    # service as the child of the alerting service invents an edge pointing
    # the wrong way, and since topology is derived from exactly these spans,
    # one reversed edge makes the graph cyclic and ancestor reasoning
    # meaningless.
    if want_traces and downstream:
        resource_spans: list[dict] = []
        span_seq = 0
        for i, svc in enumerate(downstream):
            path = _call_path(topo, svc, root_service)
            base_ts = start + timedelta(seconds=67 + i * 9)
            parent_span: str | None = None

            for depth, hop in enumerate(path):
                span_seq += 1
                span_id = f"sp{span_seq:03d}"
                ts = base_ts + timedelta(milliseconds=depth * 120)
                span: dict[str, Any] = {
                    "traceId": trace_id, "spanId": span_id,
                    "name": f"{hop} call", "startTimeUnixNano": _nano(ts),
                    "status": {"code": 2, "message": tpl.downstream_error},
                }
                if parent_span:
                    span["parentSpanId"] = parent_span
                resource_spans.append(_res_span(hop, [span]))
                # Every hop on this path is emitted as an ERROR span, making it
                # a genuine injected symptom rather than incidental topology.
                sc.mark("trace_span", hop, ts, incident_id)
                emitted += 1
                parent_span = span_id

            log_ts = base_ts + timedelta(seconds=2)
            sc.otlp_logs.append({"resourceLogs": [{
                "resource": {"attributes": [
                    {"key": "service.name", "value": {"stringValue": svc}},
                ]},
                "scopeLogs": [{"logRecords": [{
                    "timeUnixNano": _nano(log_ts), "severityText": "ERROR",
                    "body": {"stringValue": tpl.downstream_error},
                    "traceId": trace_id, "spanId": f"sp{span_seq:03d}",
                    "attributes": [{"key": "http.status_code", "value": {"intValue": 504}}],
                }]}],
            }]})
            sc.mark("app_log", svc, log_ts, incident_id)
            emitted += 1

        if resource_spans:
            sc.otlp_traces.append({"resourceSpans": resource_spans})

    elif downstream:
        # No tracing available: downstream services still fail, they just have
        # no trace context to prove it. This is the case where correlation must
        # lean entirely on topology and evidence.
        for i, svc in enumerate(downstream):
            log_ts = start + timedelta(seconds=69 + i * 9)
            sc.otlp_logs.append({"resourceLogs": [{
                "resource": {"attributes": [
                    {"key": "service.name", "value": {"stringValue": svc}},
                ]},
                "scopeLogs": [{"logRecords": [{
                    "timeUnixNano": _nano(log_ts), "severityText": "ERROR",
                    "body": {"stringValue": tpl.downstream_error},
                    "attributes": [],
                }]}],
            }]})
            sc.mark("app_log", svc, log_ts, incident_id)
            emitted += 1

    return emitted


def _call_path(topo: Topology, caller: str, callee: str) -> list[str]:
    """Real call path from `caller` down to `callee` in this estate."""
    graph = topo.digraph()
    try:
        return nx.shortest_path(graph, caller, callee)
    except (nx.NetworkXNoPath, nx.NodeNotFound):
        return [caller, callee]


def _emit_noise(
    sc: Scenario, topo: Topology, t0: datetime, count: int, rng: random.Random
) -> None:
    """Unrelated background traffic spread across the whole window."""
    services = sorted(topo.services())
    span_minutes = 200

    for i in range(count):
        service = services[i % len(services)]
        template, severity = NOISE_LOGS[i % len(NOISE_LOGS)]
        ts = t0 + timedelta(seconds=rng.randint(0, span_minutes * 60), microseconds=i)
        sc.otlp_logs.append({"resourceLogs": [{
            "resource": {"attributes": [
                {"key": "service.name", "value": {"stringValue": service}},
            ]},
            "scopeLogs": [{"logRecords": [{
                "timeUnixNano": _nano(ts), "severityText": severity.upper(),
                "body": {"stringValue": template.format(n=rng.randint(1, 9999))},
                "attributes": [],
            }]}],
        }]})
        sc.mark("app_log", service, ts, None)

    # Genuine but unrelated alarms — the ones a naive time-window correlator
    # wrongly absorbs into whatever else happens to be firing. Hosted on
    # services outside the estate so they can never be a legitimate member of
    # any injected incident.
    for j, (metric, ns, thr, val, reason) in enumerate(NOISE_ALARMS):
        svc = f"unrelated-host-{j + 1}"
        ts = t0 + timedelta(minutes=3 + j * 47, seconds=22)
        sc.cloudwatch_alarms.append({
            "AlarmName": f"{svc}-{metric}-alarm",
            "AlarmDescription": reason,
            "NewStateValue": "ALARM",
            "NewStateReason": (
                f"Threshold Crossed: 1 datapoint [{val} "
                f"({ts.strftime('%d/%m/%y %H:%M:%S')})] was greater than "
                f"the threshold ({thr})."
            ),
            "StateChangeTime": ts.isoformat().replace("+00:00", "Z"),
            "Region": "ap-south-1",
            "Trigger": {
                "MetricName": metric, "Namespace": ns, "Statistic": "AVERAGE",
                "Threshold": thr, "ComparisonOperator": "GreaterThanThreshold",
                "Dimensions": [{"name": "ServiceName", "value": svc}],
            },
        })
        sc.mark("cloudwatch_metric", svc, ts, None)


# --------------------------------------------------------------------------
# truth attachment
# --------------------------------------------------------------------------


def attach_truth(signals: list[Signal], scenario: Scenario) -> list[Signal]:
    """Copy the answer key onto Signals *after* the adapters have run."""
    for signal in signals:
        key = (str(signal.source), signal.service, signal.timestamp.isoformat())
        entry = scenario.truth.get(key)
        if entry:
            signal.truth_incident = entry["incident"]
            signal.truth_is_root_cause = entry["root"]
    return signals


def build_signals(scenario: Scenario) -> list[Signal]:
    """Run every raw payload through the real adapters, then attach truth."""
    from . import adapters

    signals: list[Signal] = []
    for alarm in scenario.cloudwatch_alarms:
        signal = adapters.from_cloudwatch_alarm(alarm)
        if signal:
            signals.append(signal)
    for response in scenario.cloudwatch_logs:
        signals.extend(adapters.from_cloudwatch_logs(response))
    for batch in scenario.grafana_batches:
        signals.extend(adapters.from_grafana_webhook(batch))
    for payload in scenario.otlp_logs:
        signals.extend(adapters.from_otlp_logs(payload))
    for payload in scenario.otlp_traces:
        signals.extend(adapters.from_otlp_traces(payload))

    attach_truth(signals, scenario)
    signals.sort(key=lambda s: s.timestamp)
    return signals


def dependency_edges(
    scenario: Scenario, observed_fraction: float = 1.0, seed: int = 0
) -> set[tuple[str, str]]:
    """Topology available to the pipeline at runtime.

    `observed_fraction` below 1.0 drops edges at random, modelling an estate
    where tracing is only partly deployed. This matters: the causal engine
    leans on the dependency graph, and a benchmark that always hands it a
    perfect graph never tests what happens when it doesn't have one.
    """
    from . import adapters

    edges: set[tuple[str, str]] = set()
    for payload in scenario.otlp_traces:
        edges |= adapters.service_dependency_edges(payload)
    for caller, callees in scenario.topology.edges.items():
        for callee in callees:
            edges.add((caller, callee))

    if observed_fraction >= 1.0:
        return edges
    rng = random.Random(seed)
    keep = max(1, int(len(edges) * observed_fraction))
    return set(rng.sample(sorted(edges), keep))


def criticality_map(scenario: Scenario) -> dict[str, float]:
    """Per-service criticality for this estate, for severity scoring."""
    return dict(scenario.topology.criticality)
