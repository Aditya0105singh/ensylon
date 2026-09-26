"""A local stand-in for the Nexus signal host, for demos and offline testing.

It serves the same three SSE streams and the reference graph, with the same
event framing (`id:` / `event: signal` / `data:`), a `:keepalive` comment, and
`Last-Event-ID` resume. Payloads follow the shapes in the problem statement and
carry PII on purpose, so redaction is visible end to end.

This is NOT an input to the evaluated system. The real runtime reads only the
organisers' streams. To use this, point a second backend at it:

    python tools/fake_nexus.py --port 9100
    NEXUS_BASE_URL=http://127.0.0.1:9100 python -m uvicorn app.main:app --port 8003

Scenario (seconds after the server starts, scaled by --speed):
  * an agency-db connection-pool exhaustion cascades to payments-service and
    enrollment-service (metric alarm, error logs with PII, Grafana alert,
    a circuit breaker line that names payments-service)
  * a burst of repeated log lines (deduplication)
  * an unrelated comms-service SMTP failure (a second incident)
  * a lone CPU alarm on batch-report, a service outside the graph, that nothing joins (noise)
  * a late payments-service log after the first incident exists (attach)
Background INFO lines and a Grafana `ok` keep the streams realistic.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

GRAPH = {
    "agency-gateway": ["carrier-service", "party-service"],
    "enrollment-service": ["payments-service", "carrier-service", "party-service", "product-service"],
    "carrier-service": ["payments-service", "agency-db", "comms-service"],
    "payments-service": ["agency-db", "rulesforge"],
    "rulesforge": ["agency-db"],
    "compensation-service": ["payments-service", "distribution-service", "agency-db"],
    "distribution-service": ["party-service", "agency-db"],
    "party-service": ["agency-db"],
    "product-service": ["agency-db"],
    "comms-service": [],
    "docforge": ["agency-db"],
    "agency-db": [],
}

PII = "user:neha.joshi@acmecorp.com ip:10.0.2.83 session:sess_kd3dxt acc:ACC-10000055"


def iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def cw(now, service, component, value, threshold, name, metric="DBConnectionCount"):
    return json.dumps({
        "AlarmName": name,
        "AlarmDescription": f"{metric} exceeded threshold - affects svc-payments@internal.corp.com",
        "StateChangeTime": iso(now), "Region": "ap-south-1", "NewStateValue": "ALARM", "OldStateValue": "OK",
        "Trigger": {"MetricName": metric, "Namespace": "AWS/RDS", "Statistic": "AVERAGE", "Period": 60,
                    "EvaluationPeriods": 3, "Threshold": threshold, "ObservedValue": value},
        "AffectedResources": {"service": service, "component": component, "environment": "prod",
                              "region": "ap-south-1", "accountId": "456789012345",
                              "serviceAccount": "svc-payments@internal.corp.com"},
    })


def gf(service, title, metric, value, threshold, state="alerting"):
    return json.dumps({
        "title": f"{title} - {service}".replace(" - ", " — ", 1), "state": state, "ruleName": f"{title}-{service}",
        "orgId": 1, "dashboardId": 12, "panelId": 7,
        "evalMatches": [{"metric": metric, "value": value,
                         "tags": {"service": service, "environment": "prod", "region": "ap-south-1", "host": "10.0.4.56"}}],
        "message": f"{metric} {value} above the {threshold} threshold for 3 consecutive periods. "
                   f"Last affected user: priya.sharma@acmecorp.com (acc: ACC-10000181, session: sess_58917o)",
        "tags": {"environment": "prod", "region": "ap-south-1"}, "imageUrl": None,
        "ruleUrl": f"http://grafana.internal/d/dash-12/{service}",
    })


def log(now, level, service, component, msg, ctx=PII):
    return f"{iso(now)} {level} {service} {component} [{ctx}] {msg}"


def schedule():
    """(offset seconds, stream, builder(now) -> data)."""
    ev = []
    add = lambda t, stream, fn: ev.append((t, stream, fn))

    # calm background
    for t in (1, 3, 6, 9, 14, 30, 50):
        add(t, "aiops-logs", lambda n: log(n, "INFO", "party-service", "api-handler", "Request completed in 42ms", "host:party-prod-01"))
    add(4, "aiops-grafana", lambda n: gf("docforge", "High Latency", "response_time_p99", 180, 4000, state="ok"))

    # incident 1: agency-db pool exhaustion cascade
    add(8, "aiops-cloudwatch", lambda n: cw(n, "agency-db", "db-connection-pool", 97.0, 90, "HighDBConnections-agency-db"))
    add(11, "aiops-logs", lambda n: log(n, "ERROR", "payments-service", "db-connection-pool",
                                        "Connection pool exhausted. Pool size: 100, waiting threads: 22"))
    for t, waiting in ((13, 25), (15, 31), (17, 38)):   # repeats of one condition
        add(t, "aiops-logs", lambda n, w=waiting: log(n, "ERROR", "payments-service", "db-connection-pool",
                                                     f"Connection pool exhausted. Pool size: 100, waiting threads: {w}"))
    add(20, "aiops-cloudwatch", lambda n: cw(n, "payments-service", "db-connection-pool", 95.0, 90, "HighDBConnections-payments-service"))
    add(24, "aiops-logs", lambda n: log(n, "ERROR", "enrollment-service", "api-handler",
                                        "Circuit breaker OPEN for payments-service after 27 consecutive failures", "host:enrollment-prod-02"))
    add(28, "aiops-grafana", lambda n: gf("enrollment-service", "High Latency", "response_time_p99", 4785, 4000))

    # noise: one lone alarm on a service nothing else touches
    add(18, "aiops-cloudwatch", lambda n: cw(n, "batch-report", "renderer", 99.0, 85, "HighCPU-batch-report", metric="CPUUtilization"))

    # incident 2: unrelated, comms-service
    add(40, "aiops-logs", lambda n: log(n, "ERROR", "comms-service", "smtp-relay",
                                        "SMTP relay refused connection: 421 service not available", "host:comms-prod-01"))
    add(44, "aiops-grafana", lambda n: gf("comms-service", "Email Delivery Failures", "smtp_error_rate", 42, 5))
    add(47, "aiops-logs", lambda n: log(n, "ERROR", "comms-service", "smtp-relay",
                                        "SMTP relay refused connection: 421 service not available", "host:comms-prod-01"))

    # late arrival on incident 1
    add(75, "aiops-logs", lambda n: log(n, "ERROR", "payments-service", "db-connection-pool",
                                        "Connection pool exhausted. Pool size: 100, waiting threads: 44"))
    return sorted(ev, key=lambda e: e[0])


class State:
    def __init__(self, speed: float, keepalive: float):
        self.t0 = time.time()
        self.speed = speed
        self.keepalive = keepalive
        self.events: dict[str, list[tuple[float, str, str]]] = {}  # stream -> [(due_wall, id, data)]
        self.lock = threading.Lock()
        self.by_stream: dict[str, list] = {}
        for off, stream, fn in schedule():
            self.by_stream.setdefault(stream, []).append((off / speed, fn))

    def due(self, stream: str, after_id: int):
        """Events with sequence > after_id whose time has come, as (id, data)."""
        now = time.time()
        out = []
        for seq, (off, fn) in enumerate(self.by_stream.get(stream, []), start=1):
            if seq > after_id and self.t0 + off <= now:
                # payload timestamps are the moment the event is emitted
                out.append((seq, fn(datetime.now(timezone.utc))))
        return out


def make_handler(state: State):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *a):  # quiet
            pass

        def _json(self, obj):
            body = json.dumps(obj).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path.startswith("/sim/reference/service-dependency-graph"):
                return self._json(GRAPH)
            if self.path.startswith("/sim/stream/"):
                stream = self.path.rsplit("/", 1)[-1]
                if stream not in ("aiops-logs", "aiops-grafana", "aiops-cloudwatch"):
                    self.send_error(404)
                    return
                try:
                    last = int(self.headers.get("Last-Event-ID") or 0)
                except ValueError:
                    last = 0
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("Connection", "keep-alive")
                self.end_headers()
                last_ka = 0.0
                try:
                    while True:
                        for seq, data in state.due(stream, last):
                            self.wfile.write(f"id: {seq:06d}\nevent: signal\ndata: {data}\n\n".encode())
                            last = seq
                        if time.time() - last_ka >= state.keepalive:
                            self.wfile.write(b":keepalive\n\n")
                            last_ka = time.time()
                        self.wfile.flush()
                        time.sleep(0.5)
                except (BrokenPipeError, ConnectionResetError, OSError):
                    return
            self.send_error(404)

    return H


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9100)
    ap.add_argument("--speed", type=float, default=1.0, help="2.0 plays the scenario twice as fast")
    ap.add_argument("--keepalive", type=float, default=15.0)
    a = ap.parse_args()
    state = State(a.speed, a.keepalive)
    srv = ThreadingHTTPServer(("127.0.0.1", a.port), make_handler(state))
    print(f"fake Nexus on http://127.0.0.1:{a.port}  (scenario runs ~{int(75 / a.speed)}s from now)", flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
