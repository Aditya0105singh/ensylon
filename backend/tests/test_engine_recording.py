"""Recording, resume and replay: the live session on disk, already redacted."""

import json
import threading
from datetime import datetime, timedelta, timezone

from app.engine import recording as rec
from app.engine.live import (
    STREAMS,
    LiveRuntime,
    ReplayReader,
    StreamReader,
    iter_sse,
)
from app.engine.signal import Severity, Signal, SignalSource

from tests.test_engine_stream import KNOWN, _cw, _engine, _gf, _sse

PII = ("neha", "priya", "10.0.", "sess_", "ACC-", "456789012345", "svc-payments@")

CASCADE = {
    "aiops-cloudwatch": [_cw("2026-09-26T10:01:00Z", "agency-db", "db-connection-pool", 97.0)],
    "aiops-logs": [
        "2026-09-26T10:01:05Z ERROR payments-service db-connection-pool [user:neha.joshi@acmecorp.com "
        "ip:10.0.2.83 session:sess_kd3dxt acc:ACC-10000055] Connection pool exhausted. Pool size: 100",
        "2026-09-26T10:01:48Z ERROR enrollment-service api-handler [host:enrollment-prod-02] "
        "Circuit breaker OPEN for payments-service after 27 consecutive failures",
    ],
    "aiops-grafana": [_gf("enrollment-service"), _gf("docforge", state="ok")],
}


def _record_cascade(tmp_path):
    """Run the cascade through recording readers; return (engine, recording path)."""
    engine = _engine()
    recorder = rec.Recorder.new_session("http://sim", tmp_path)
    for stream, events in CASCADE.items():
        reader = StreamReader(stream, engine, KNOWN, threading.Event())
        reader.recorder = recorder
        for ev in iter_sse(iter(_sse(events))):
            reader.handle(ev)
    engine.tick()
    recorder.close()
    return engine, recorder.path


def test_recording_holds_every_event_and_no_pii(tmp_path):
    _, path = _record_cascade(tmp_path)
    text = path.read_text(encoding="utf-8")
    for pii in PII:
        assert pii not in text
    lines = [json.loads(line) for line in text.splitlines()]
    assert lines[0]["kind"] == "header" and lines[0]["base_url"] == "http://sim"
    outcomes = [line["outcome"] for line in lines[1:]]
    assert outcomes.count("signal") == 4 and outcomes.count("skipped") == 1   # grafana `ok`


def test_resume_rebuilds_the_same_incident_and_resume_points(tmp_path):
    live, path = _record_cascade(tmp_path)
    recording = rec.load(path)

    restored = _engine()
    rec.fast_forward(restored, recording.signals, 2.0)
    assert len(restored.result.incidents) == len(live.result.incidents) == 1
    assert set(restored.result.incidents[0].cluster.services) == set(live.result.incidents[0].cluster.services)

    assert recording.last_ids() == {"aiops-cloudwatch": "000001", "aiops-logs": "000002", "aiops-grafana": "000002"}
    assert recording.counts()["aiops-grafana"] == {"events": 2, "signals": 1, "skipped": 1, "parse_errors": 0}

    reader = StreamReader("aiops-grafana", restored, KNOWN, threading.Event())
    reader.restore("000002", recording.counts()["aiops-grafana"])
    assert reader.status.last_event_id == "000002" and reader.status.skipped == 1


def test_a_torn_last_line_is_ignored(tmp_path):
    _, path = _record_cascade(tmp_path)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write('{"kind": "event", "stream": "aiops-lo')          # crash mid-write
    assert len(rec.load(path).signals) == 4


def test_only_a_recent_recording_of_the_same_simulator_is_resumed(tmp_path):
    _, path = _record_cascade(tmp_path)
    assert rec.resumable("http://sim", tmp_path) == path
    assert rec.resumable("http://other-sim", tmp_path) is None
    assert rec.resumable("http://sim", tmp_path / "missing") is None


def test_batches_follow_event_time():
    t0 = datetime(2026, 9, 26, 10, 0, tzinfo=timezone.utc)
    sigs = [Signal(id=str(i), source=SignalSource.APP_LOG, service="s", timestamp=t0 + timedelta(seconds=s))
            for i, s in enumerate([0, 1, 3, 3.5, 10])]
    assert [[s.id for s in b] for b in rec.batches(sigs, 2.0)] == [["0", "1"], ["2", "3"], ["4"]]


def test_busiest_start_lands_just_before_the_burst():
    t0 = datetime(2026, 9, 26, 10, 0, tzinfo=timezone.utc)
    quiet = [Signal(id=f"q{i}", source=SignalSource.APP_LOG, service="s", severity=Severity.WARNING,
                    timestamp=t0 + timedelta(minutes=i * 20)) for i in range(3)]
    burst = [Signal(id=f"b{i}", source=SignalSource.APP_LOG, service="s", severity=Severity.HIGH,
                    timestamp=t0 + timedelta(hours=2, seconds=i)) for i in range(10)]
    start = rec.busiest_start(quiet + burst, window_minutes=5, lead_seconds=60)
    assert start == t0 + timedelta(hours=2) - timedelta(seconds=60)


def test_replay_plays_a_recording_through_the_engine(tmp_path):
    _, path = _record_cascade(tmp_path)
    engine = _engine()
    runtime = LiveRuntime(engine=engine, lock=threading.RLock(), graph_origin="test", adjacency={})
    readers = {name: StreamReader(name, engine, KNOWN, runtime.stop_event) for name in STREAMS}
    runtime.readers.extend(readers.values())
    replay = ReplayReader(runtime, rec.load(path), readers, speed=1000.0, start_at=None)
    replay.run()                         # synchronously, for the test
    engine.tick()

    assert replay.finished and replay.played == replay.total == 4
    assert len(engine.result.incidents) == 1
    assert readers["aiops-grafana"].status.skipped == 1
    assert replay.as_dict()["active"] is True and replay.as_dict()["source"] == path.name
