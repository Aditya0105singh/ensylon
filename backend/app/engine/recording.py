"""RECORDING - keep the live session on disk, already redacted.

Three uses, one file format:

  * Record. Every event the stream readers handle is appended as one JSON line:
    the stream, its SSE id, and the parsed Signal. Parsers redact PII before a
    Signal exists (see nexus.py), so nothing un-redacted is ever written - the
    brief requires redaction "before any further processing or storage".
    Skipped events (recoveries) and unparsable ones are recorded by id only.

  * Resume. After a restart the engine is rebuilt from the recording, in the
    same 2-second event-time batches the live ticker uses, and each stream
    reconnects with its recorded Last-Event-ID. Nothing is lost, nothing is
    counted twice, and an incident on screen survives a restart.

  * Replay. A recording can be played back through the same engine at any
    speed, for a demo when the live simulator is quiet. The runtime says so
    in its status (`replay.active`), and the UI shows a REPLAY banner.

File layout, one JSON object per line:
    {"kind": "header", "version": 1, "base_url": ..., "started_at": ...}
    {"kind": "event", "stream": "aiops-logs", "id": "000042", "at": ..., "signal": {...} | null, "outcome": "signal|skipped|error"}
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from .signal import Signal

VERSION = 1
DEFAULT_DIR = Path(os.getenv("RECORDINGS_DIR", Path(__file__).resolve().parents[3] / "recordings"))
# A recording older than this is a previous session, not one to resume.
RESUME_MAX_AGE_HOURS = float(os.getenv("RESUME_MAX_AGE_HOURS", "12"))
# Replay: silences longer than this (event time) are shortened to it.
REPLAY_MAX_GAP_SECONDS = float(os.getenv("REPLAY_MAX_GAP_SECONDS", "6"))


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------
# writing
# --------------------------------------------------------------------------


class Recorder:
    """Append-only JSONL writer, safe to call from every reader thread."""

    def __init__(self, path: Path, base_url: str, fresh: bool) -> None:
        self.path = path
        self._lock = threading.Lock()
        path.parent.mkdir(parents=True, exist_ok=True)
        self._fh = open(path, "a", encoding="utf-8")
        if fresh:
            self._write({"kind": "header", "version": VERSION, "base_url": base_url,
                         "started_at": _utcnow().isoformat()})

    @classmethod
    def new_session(cls, base_url: str, directory: Path | None = None) -> "Recorder":
        directory = directory or DEFAULT_DIR
        name = f"session-{_utcnow().strftime('%Y%m%d-%H%M%S')}.jsonl"
        return cls(directory / name, base_url, fresh=True)

    def record(self, stream: str, event_id: str | None, signal: Signal | None, outcome: str) -> None:
        self._write({
            "kind": "event", "stream": stream, "id": event_id, "at": _utcnow().isoformat(),
            "outcome": outcome,
            "signal": signal.model_dump(mode="json") if signal is not None else None,
        })

    def _write(self, obj: dict[str, Any]) -> None:
        line = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
        with self._lock:
            self._fh.write(line + "\n")
            self._fh.flush()

    def close(self) -> None:
        with self._lock:
            self._fh.close()


# --------------------------------------------------------------------------
# reading
# --------------------------------------------------------------------------


@dataclass
class RecordedEvent:
    stream: str
    id: str | None
    outcome: str
    signal: Signal | None


@dataclass
class Recording:
    path: Path
    header: dict[str, Any]
    events: list[RecordedEvent] = field(default_factory=list)

    @property
    def signals(self) -> list[Signal]:
        return [e.signal for e in self.events if e.signal is not None]

    def last_ids(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for e in self.events:
            if e.id:
                out[e.stream] = e.id
        return out

    def counts(self) -> dict[str, dict[str, int]]:
        """Per stream: events, signals, skipped, parse_errors - as the readers count them."""
        out: dict[str, dict[str, int]] = {}
        for e in self.events:
            c = out.setdefault(e.stream, {"events": 0, "signals": 0, "skipped": 0, "parse_errors": 0})
            c["events"] += 1
            key = {"signal": "signals", "skipped": "skipped", "error": "parse_errors"}.get(e.outcome)
            if key:
                c[key] += 1
        return out


def load(path: Path) -> Recording:
    """Read a recording. A torn last line (crash mid-write) is ignored."""
    header: dict[str, Any] = {}
    events: list[RecordedEvent] = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("kind") == "header":
                header = obj
            elif obj.get("kind") == "event":
                raw = obj.get("signal")
                try:
                    signal = Signal.model_validate(raw) if raw else None
                except Exception:
                    continue
                events.append(RecordedEvent(obj.get("stream", ""), obj.get("id"), obj.get("outcome", ""), signal))
    return Recording(path, header, events)


def latest(directory: Path | None = None) -> Path | None:
    directory = directory or DEFAULT_DIR
    if not directory.is_dir():
        return None
    files = sorted(directory.glob("session-*.jsonl"))
    return files[-1] if files else None


def resumable(base_url: str, directory: Path | None = None) -> Path | None:
    """The latest recording of this simulator, if it is recent enough to be this session."""
    path = latest(directory)
    if path is None:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            header = json.loads(fh.readline())
        started = datetime.fromisoformat(header["started_at"])
    except Exception:
        return None
    if header.get("base_url") != base_url:
        return None
    age = _utcnow() - datetime.fromtimestamp(path.stat().st_mtime, timezone.utc)
    if age > timedelta(hours=RESUME_MAX_AGE_HOURS) or started > _utcnow():
        return None
    return path


# --------------------------------------------------------------------------
# feeding an engine
# --------------------------------------------------------------------------


def batches(signals: list[Signal], seconds: float) -> Iterator[list[Signal]]:
    """Group signals into consecutive windows of `seconds` of event time - the
    same shape of batch the live ticker sees every TICK_SECONDS."""
    ordered = sorted(signals, key=lambda s: s.timestamp)
    batch: list[Signal] = []
    start: datetime | None = None
    for s in ordered:
        if start is None or (s.timestamp - start).total_seconds() >= seconds:
            if batch:
                yield batch
            batch, start = [], s.timestamp
        batch.append(s)
    if batch:
        yield batch


def fast_forward(engine, signals: list[Signal], tick_seconds: float) -> int:
    """Rebuild engine state from recorded signals, batch by batch. Returns the
    number of ticks run. The caller holds the engine lock."""
    ticks = 0
    for batch in batches(signals, tick_seconds):
        for s in batch:
            engine.offer(s.model_copy(deep=True))
        engine.tick()
        ticks += 1
    return ticks


def busiest_start(signals: list[Signal], window_minutes: float = 10.0, lead_seconds: float = 60.0) -> datetime | None:
    """Where to start a replay: shortly before the window with the most errors
    and firing alarms, so a demo reaches the interesting part quickly.
    Warnings are not counted: routine ones arrive all the time and would pull
    the start into an ordinary stretch. They are the fallback if nothing else."""
    from .signal import Severity

    notable = sorted(s.timestamp for s in signals if s.severity in (Severity.CRITICAL, Severity.HIGH))
    if not notable:
        notable = sorted(s.timestamp for s in signals if s.severity == Severity.WARNING)
    if not notable:
        return None
    best, best_n, j = notable[0], 0, 0
    span = timedelta(minutes=window_minutes)
    for i, t in enumerate(notable):
        while notable[j] < t - span:
            j += 1
        if i - j + 1 > best_n:
            best_n, best = i - j + 1, notable[j]
    return best - timedelta(seconds=lead_seconds)


__all__ = ["Recorder", "Recording", "RecordedEvent", "load", "latest", "resumable",
           "batches", "fast_forward", "busiest_start", "DEFAULT_DIR", "REPLAY_MAX_GAP_SECONDS"]
