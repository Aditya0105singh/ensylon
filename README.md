# AIOps Challenge 2026 — Team SpaceX

Your team's repository for the Ensylon AIOps Challenge 2026. Commit your solution here.

**Start with [`problem-statement.html`](problem-statement.html)** — download it and open it in a
browser. It is the full technical problem statement: signal formats, the canonical schema, the
reference data and the five components you must build.

## Signal streams

The simulator is hosted by Ensylon and streams raw signals over Server-Sent Events. Connect and keep
the connection open:

| Source | Stream |
|---|---|
| Application logs (plain text) | `https://logs.nonprod.nexus.ensylon.com/sim/stream/aiops-logs` |
| Grafana alerts (JSON) | `https://logs.nonprod.nexus.ensylon.com/sim/stream/aiops-grafana` |
| CloudWatch alarms (JSON) | `https://logs.nonprod.nexus.ensylon.com/sim/stream/aiops-cloudwatch` |

```bash
curl -N https://logs.nonprod.nexus.ensylon.com/sim/stream/aiops-logs
```

Each event is `id: 000042` / `event: signal` / `data: <payload>`. Reconnect with `Last-Event-ID` to
resume without losing signals. Expect bursts and silences — handle both gracefully.

The Nexus Agency service dependency graph is served at
`https://logs.nonprod.nexus.ensylon.com/sim/reference/service-dependency-graph`.

## Rules that matter

- **Redact PII before anything else** — no raw PII in storage, logs or tickets.
- **Time proximity alone does not prove correlation** — group signals only on structural evidence.
- **Human approval before a ticket is written** to `output/tickets/`.
- The three streams are your only input.

## Submission

Commit your source code here with a `README.md` (setup and run instructions) replacing this one, and
present your design decisions on Day 2.

---
Ensylon Technologies · AIOps Challenge 2026 · Confidential
