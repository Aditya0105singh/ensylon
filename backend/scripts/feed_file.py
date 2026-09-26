"""Feed any alert file through the AlertLens engine.

Rehearses the "here is a sample data file, not a webhook" case. Reads JSON (a
list, or an object wrapping one under alerts/signals/records/data/events),
JSON Lines, or CSV, and field names are matched loosely (service/host/resource,
severity/level/priority, timestamp/time/ts, message/description/summary ...).

    # through the running backend, so the result shows up in the UI
    python scripts/feed_file.py alerts.csv
    python scripts/feed_file.py alerts.json --url https://my-backend --key $ALERTLENS_API_KEY

    # in-process, any size, prints a summary (no server needed)
    python scripts/feed_file.py alerts.csv --local

Standard library only for the HTTP mode.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

MAX_SIGNALS = 5_000          # the API's per-request cap (engine_api.MAX_INGEST_SIGNALS)
DEFAULT_BODY_CAP = 2 * 1024 * 1024


def load_records(path: Path) -> list[dict]:
    text = path.read_text(encoding="utf-8-sig")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return [dict(row) for row in csv.DictReader(text.splitlines())]
    if suffix in (".jsonl", ".ndjson"):
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    data = json.loads(text)
    if isinstance(data, dict):
        for key in ("alerts", "signals", "records", "data", "events"):
            if isinstance(data.get(key), list):
                return data[key]
        return [data]
    return data


def run_local(records: list[dict]) -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    import warnings
    warnings.filterwarnings("ignore")
    from app.engine.adapters import from_generic_records
    from app.engine.correlate import DependencyGraph
    from app.engine.pipeline import run
    from app.engine.review import ReviewQueue

    signals = from_generic_records(records)
    print(f"{len(records)} records -> {len(signals)} usable signals")
    if not signals:
        print("No usable signals: every record lacked a parseable timestamp. Check the field names.")
        return
    result = run(signals, DependencyGraph(set()), queue=ReviewQueue(), use_llm=False)
    rep = result.report
    print(f"unique {rep.unique_signals} | anomalous {rep.anomalies_detected} | "
          f"incidents {rep.incidents_formed} | noise {rep.noise_signals} | priorities {rep.priorities}")
    for inc in sorted(result.incidents, key=lambda i: -i.draft.severity_score)[:10]:
        d = inc.draft
        print(f"  [{d.priority}] {d.severity_score:.2f}  root cause {d.root_cause_service}  "
              f"| {d.signal_count} signals | {len(d.affected_services)} services")


def post(url: str, key: str | None, body: bytes) -> dict:
    req = urllib.request.Request(url, data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    if key:
        req.add_header("X-API-Key", key)
    with urllib.request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read())


def get(url: str, key: str | None):
    req = urllib.request.Request(url)
    if key:
        req.add_header("X-API-Key", key)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read())


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=Path)
    ap.add_argument("--url", default="http://127.0.0.1:8001", help="backend base URL")
    ap.add_argument("--key", default=None, help="X-API-Key, if the backend sets ALERTLENS_API_KEY")
    ap.add_argument("--local", action="store_true", help="run the engine in-process instead of over HTTP")
    args = ap.parse_args()

    records = load_records(args.file)
    print(f"Loaded {len(records)} records from {args.file.name}")
    if args.local:
        run_local(records)
        return 0

    if len(records) > MAX_SIGNALS:
        print(f"Note: the API accepts {MAX_SIGNALS} signals per request; sending the last {MAX_SIGNALS}. "
              f"Use --local to analyse the whole file.")
        records = records[-MAX_SIGNALS:]
    body = json.dumps(records, default=str).encode("utf-8")
    if len(body) > DEFAULT_BODY_CAP:
        print(f"Warning: payload is {len(body) / 1e6:.1f} MB; the backend's default cap is 2 MB. "
              f"Raise ALERTLENS_MAX_BODY_BYTES on the backend or use --local.")
    try:
        out = post(f"{args.url.rstrip('/')}/engine/ingest/generic?fresh=true", args.key, body)
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode(errors='replace')[:300]}")
        return 1
    except urllib.error.URLError as e:
        print(f"Could not reach {args.url}: {e.reason}. Is the backend running?")
        return 1
    print("Ingest:", out)
    if not out.get("received"):
        print("No usable signals: every record lacked a parseable timestamp. Check the field names.")
        return 1
    queue = get(f"{args.url.rstrip('/')}/engine/queue", args.key)
    print(f"{len(queue)} draft(s) awaiting review:")
    for q in queue[:10]:
        print(f"  [{q['priority']}] {q['title']}  (root cause {q['root_cause_service']}, {q['signal_count']} signals)")
    print("Open the Review Queue in the UI to investigate and approve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
