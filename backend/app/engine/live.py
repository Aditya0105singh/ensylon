"""LIVE - the three Nexus SSE streams feeding the StreamEngine.

One reader thread per stream. Each keeps the last event id it saw and sends it
as `Last-Event-ID` when it reconnects, so a dropped connection resumes where it
left off instead of replaying or skipping. `:keepalive` comments (every 15 s)
only refresh the "last heard from" time; they are never parsed as signals.
A ticker thread runs StreamEngine.tick() every TICK_SECONDS.

Inputs, per the challenge rules: the three streams, plus the service
dependency graph from the reference endpoint. Nothing else.

Every handled event is also recorded, already redacted (see recording.py), so
a restart resumes where it left off and a quiet simulator can be demonstrated
with a clearly labelled replay of what the streams sent earlier.
"""

from __future__ import annotations

import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Iterator

import httpx

from . import claude_drafting
from . import recording as rec
from .correlate import DependencyGraph
from .drafting import apply_claude
from .nexus import from_cloudwatch, from_grafana, parse_log_line
from .signal import Signal
from .stream import StreamEngine

log = logging.getLogger(__name__)

BASE_URL = os.getenv("NEXUS_BASE_URL", "https://logs.nonprod.nexus.ensylon.com").rstrip("/")
STREAMS = {
    "aiops-logs": "application_logs",
    "aiops-cloudwatch": "cloudwatch_metrics",
    "aiops-grafana": "grafana_alerts",
}
GRAPH_PATH = "/sim/reference/service-dependency-graph"
TICK_SECONDS = float(os.getenv("STREAM_TICK_SECONDS", "2"))
BACKOFF_MAX = 30.0

# Recording is on for a live run; resume rebuilds state from it after a restart.
RECORD = os.getenv("NEXUS_RECORD", "1") != "0"
RESUME = os.getenv("NEXUS_RESUME", "1") != "0"
# Replay a recording instead of connecting: a path, or "latest".
REPLAY = os.getenv("NEXUS_REPLAY", "").strip()
REPLAY_SPEED = max(0.1, float(os.getenv("REPLAY_SPEED", "1")))
# Where playback starts: "busiest" (just before the busiest stretch), "start", or an ISO time.
REPLAY_FROM = os.getenv("REPLAY_FROM", "busiest").strip()

# From the problem statement (0-100); unknown services default to 50.
CRITICALITY_0_100 = {
    "payments-service": 95, "enrollment-service": 92, "carrier-service": 88,
    "agency-gateway": 85, "agency-db": 80, "compensation-service": 78,
    "rulesforge": 75, "party-service": 72, "distribution-service": 65,
    "product-service": 60, "comms-service": 40, "docforge": 30,
}
DEFAULT_CRITICALITY = 50

# Bundled copy of the reference graph, used only if the endpoint is unreachable
# at startup (it is the same adjacency list the endpoint serves).
FALLBACK_GRAPH: dict[str, list[str]] = {
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


def tickets_dir():
    from .tickets import DEFAULT_DIR
    return DEFAULT_DIR


def criticality_map() -> dict[str, float]:
    """The brief's 0-100 criticality, scaled to the engine's 0-1."""
    return {svc: v / 100.0 for svc, v in CRITICALITY_0_100.items()}


def graph_from_adjacency(adjacency: dict[str, list[str]]) -> DependencyGraph:
    edges = {(caller, callee) for caller, callees in adjacency.items() for callee in callees or []}
    graph = DependencyGraph(edges)
    for svc in adjacency:            # isolated services (no edges) still exist
        graph.graph.add_node(svc)
    graph._undirected = graph.graph.to_undirected()
    return graph


def load_reference_graph(timeout: float = 10.0) -> tuple[dict[str, list[str]], str]:
    """(adjacency, origin). Falls back to the bundled copy if the endpoint fails."""
    try:
        r = httpx.get(BASE_URL + GRAPH_PATH, timeout=timeout)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and data:
            return {k: list(v or []) for k, v in data.items()}, "reference endpoint"
    except Exception as exc:  # network, JSON, shape
        log.warning("dependency graph endpoint unavailable (%s); using bundled copy", exc)
    return dict(FALLBACK_GRAPH), "bundled copy"


# --------------------------------------------------------------------------
# SSE framing
# --------------------------------------------------------------------------


@dataclass
class SSEEvent:
    id: str | None
    event: str
    data: str


def iter_sse(lines: Iterator[str], on_comment: Callable[[str], None] | None = None) -> Iterator[SSEEvent]:
    """Parse SSE lines into events. A blank line ends an event; `:` lines are comments."""
    event_id: str | None = None
    event_type = "message"
    data: list[str] = []
    for raw in lines:
        line = raw.rstrip("\r\n")
        if line == "":
            if data:
                yield SSEEvent(event_id, event_type, "\n".join(data))
            event_id, event_type, data = None, "message", []
            continue
        if line.startswith(":"):
            if on_comment:
                on_comment(line[1:].strip())
            continue
        name, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if name == "id":
            event_id = value
        elif name == "event":
            event_type = value
        elif name == "data":
            data.append(value)
    if data:
        yield SSEEvent(event_id, event_type, "\n".join(data))


# --------------------------------------------------------------------------
# per-stream reader
# --------------------------------------------------------------------------


@dataclass
class StreamStatus:
    name: str
    source: str
    connected: bool = False
    last_event_id: str | None = None
    events: int = 0
    signals: int = 0
    skipped: int = 0            # events that were not incident symptoms (e.g. state ok)
    parse_errors: int = 0
    keepalives: int = 0
    reconnects: int = 0
    last_heard: float | None = None
    last_error: str | None = None

    def as_dict(self) -> dict[str, Any]:
        d = {k: v for k, v in self.__dict__.items()}
        d["last_heard_seconds_ago"] = round(time.time() - self.last_heard, 1) if self.last_heard else None
        d.pop("last_heard")
        return d


def to_signal(stream: str, data: str, engine: StreamEngine, known: list[str], seq: str | None) -> Signal | None:
    """One SSE `data` payload -> redacted Signal (or None if not a symptom)."""
    if stream == "aiops-logs":
        return parse_log_line(data, known, seq)
    if stream == "aiops-cloudwatch":
        return from_cloudwatch(data, known, seq)
    if stream == "aiops-grafana":
        return from_grafana(data, engine.now(), known, seq)
    raise ValueError(stream)


class StreamReader(threading.Thread):
    def __init__(self, name: str, engine: StreamEngine, known: list[str], stop: threading.Event):
        super().__init__(name=f"sse-{name}", daemon=True)
        self.stream = name
        self.engine = engine
        self.known = known
        self.stop_event = stop
        self.status = StreamStatus(name=name, source=STREAMS[name])
        self.recorder: rec.Recorder | None = None

    def _comment(self, text: str) -> None:
        self.status.last_heard = time.time()
        if text.startswith("keepalive"):
            self.status.keepalives += 1

    def run(self) -> None:
        backoff = 1.0
        url = f"{BASE_URL}/sim/stream/{self.stream}"
        while not self.stop_event.is_set():
            headers = {"Accept": "text/event-stream", "Cache-Control": "no-cache"}
            if self.status.last_event_id:
                headers["Last-Event-ID"] = self.status.last_event_id
            try:
                # read timeout > 2 keepalive intervals: a silent-but-alive stream is fine
                timeout = httpx.Timeout(10.0, read=45.0)
                with httpx.stream("GET", url, headers=headers, timeout=timeout) as resp:
                    resp.raise_for_status()
                    self.status.connected, self.status.last_error = True, None
                    backoff = 1.0
                    for ev in iter_sse(resp.iter_lines(), self._comment):
                        if self.stop_event.is_set():
                            return
                        self.handle(ev)
            except Exception as exc:
                self.status.last_error = f"{type(exc).__name__}: {exc}"[:200]
            self.status.connected = False
            if self.stop_event.is_set():
                return
            self.status.reconnects += 1
            self.stop_event.wait(backoff)
            backoff = min(BACKOFF_MAX, backoff * 2)

    def handle(self, ev: SSEEvent) -> None:
        self.status.last_heard = time.time()
        if ev.id:
            self.status.last_event_id = ev.id
        self.status.events += 1
        if ev.event not in ("signal", "message"):
            return
        try:
            signal = to_signal(self.stream, ev.data, self.engine, self.known, ev.id)
        except Exception:
            # Payload is never logged: it may carry PII before redaction.
            self.status.parse_errors += 1
            self._record(ev.id, None, "error")
            return
        if signal is None:
            self.status.skipped += 1
            self._record(ev.id, None, "skipped")
            return
        self.status.signals += 1
        # Recorded before the engine sees it: the Signal is already redacted
        # and not yet scored, exactly what a replay or resume needs to feed back.
        self._record(ev.id, signal, "signal")
        self.engine.offer(signal)

    def _record(self, event_id: str | None, signal: Signal | None, outcome: str) -> None:
        if self.recorder is None:
            return
        try:
            self.recorder.record(self.stream, event_id, signal, outcome)
        except Exception:
            log.exception("could not record an event; ingestion continues")

    def restore(self, last_id: str | None, counts: dict[str, int]) -> None:
        """Carry counters and the resume point over from a recording."""
        self.status.last_event_id = last_id
        for key, value in counts.items():
            setattr(self.status, key, getattr(self.status, key) + value)


# --------------------------------------------------------------------------
# Claude narration, off the ingest path
# --------------------------------------------------------------------------


class ReplayReader(threading.Thread):
    """Plays a recording into the engine in place of the three live streams.

    Everything before the start point is fast-forwarded (so detector baselines
    and earlier incidents exist, exactly as they did live); from there, signals
    arrive in their recorded order, paced by their event-time gaps / speed,
    with long silences shortened to REPLAY_MAX_GAP_SECONDS.
    """

    def __init__(self, runtime: "LiveRuntime", recording: rec.Recording, readers: dict[str, "StreamReader"],
                 speed: float, start_at: datetime | None) -> None:
        super().__init__(name="replay", daemon=True)
        self.runtime, self.recording, self.readers = runtime, recording, readers
        self.speed, self.start_at = speed, start_at
        self.played = 0
        self.total = sum(1 for e in recording.events if e.signal is not None)
        self.finished = False

    def run(self) -> None:
        events = self.recording.events
        first = 0
        if self.start_at is not None:
            while first < len(events) and (events[first].signal is None or events[first].signal.timestamp < self.start_at):
                first += 1
        warm = [e.signal for e in events[:first] if e.signal is not None]
        with self.runtime.lock:
            rec.fast_forward(self.runtime.engine, warm, TICK_SECONDS)
        for e in events[:first]:
            self._count(e)
        self.played = len(warm)

        prev: datetime | None = None
        for e in events[first:]:
            if self.runtime.stop_event.is_set():
                return
            if e.signal is not None:
                if prev is not None:
                    gap = (e.signal.timestamp - prev).total_seconds()
                    gap = min(max(gap, 0.0), rec.REPLAY_MAX_GAP_SECONDS) / self.speed
                    if gap > 0 and self.runtime.stop_event.wait(gap):
                        return
                prev = e.signal.timestamp
            self._count(e)
            if e.signal is not None:
                self.runtime.engine.offer(e.signal.model_copy(deep=True))
                self.played += 1
        self.finished = True

    def _count(self, e: rec.RecordedEvent) -> None:
        reader = self.readers.get(e.stream)
        if reader is None:
            return
        st = reader.status
        st.connected, st.last_heard = True, time.time()
        st.events += 1
        st.last_event_id = e.id or st.last_event_id
        if e.outcome == "signal":
            st.signals += 1
        elif e.outcome == "skipped":
            st.skipped += 1
        elif e.outcome == "error":
            st.parse_errors += 1

    def as_dict(self) -> dict[str, Any]:
        return {
            "active": True,
            "source": self.recording.path.name,
            "recorded_at": self.recording.header.get("started_at"),
            "speed": self.speed,
            "from": self.start_at.isoformat() if self.start_at else None,
            "played": self.played,
            "total": self.total,
            "finished": self.finished,
        }


class Narrator(threading.Thread):
    """Adds Claude's prose to drafts in the background.

    A draft reaches the review queue immediately with template prose; a Claude
    call takes seconds and must never hold up ingestion. When a late signal
    changes the draft, it is narrated again. Only drafts still awaiting review
    are touched - an approved ticket is never rewritten.
    """

    def __init__(self, engine: StreamEngine, lock, stop: threading.Event) -> None:
        super().__init__(name="claude-narrator", daemon=True)
        self.engine, self.lock, self.stop_event = engine, lock, stop
        self._pending: list[str] = []
        self._cv = threading.Condition()
        self.stats = {"narrated": 0, "fallback": 0}

    def submit(self, draft_id: str) -> None:
        with self._cv:
            if draft_id not in self._pending:
                self._pending.append(draft_id)
            self._cv.notify()

    def run(self) -> None:
        while not self.stop_event.is_set():
            with self._cv:
                if not self._pending:
                    self._cv.wait(timeout=1.0)
                    continue
                draft_id = self._pending.pop(0)
            with self.lock:
                item = self.engine.queue.items.get(draft_id)
                if item is None or item.status.value != "awaiting_review":
                    continue
                draft = item.draft
            import copy
            candidate = copy.deepcopy(draft)
            ok = apply_claude(candidate)   # network call, outside the lock
            with self.lock:
                item = self.engine.queue.items.get(draft_id)
                if not ok:
                    self.stats["fallback"] += 1
                    continue
                if item is None or item.draft is not draft or item.status.value != "awaiting_review":
                    continue   # changed meanwhile; a newer submit covers it
                for name in ("summary", "suspected_root_cause", "investigation_steps",
                             "summary_source", "drafted_by"):
                    setattr(draft, name, getattr(candidate, name))
                self.stats["narrated"] += 1


# --------------------------------------------------------------------------
# runtime
# --------------------------------------------------------------------------


@dataclass
class LiveRuntime:
    engine: StreamEngine
    lock: threading.RLock
    graph_origin: str
    adjacency: dict[str, list[str]]
    readers: list[StreamReader] = field(default_factory=list)
    stop_event: threading.Event = field(default_factory=threading.Event)
    ticker: threading.Thread | None = None
    started_at: float | None = None
    on_tick: Callable[[dict[str, Any]], None] | None = None
    narrator: "Narrator | None" = None
    recorder: rec.Recorder | None = None
    replay: ReplayReader | None = None
    resumed: dict[str, Any] | None = None

    def start(self, connect: bool = True) -> None:
        self.started_at = time.time()
        known = sorted(self.adjacency)
        if connect and REPLAY:
            self._start_replay(known)
        elif connect:
            readers = [StreamReader(name, self.engine, known, self.stop_event) for name in STREAMS]
            self.readers.extend(readers)
            self._resume_and_record(readers)
            for reader in readers:
                reader.start()
        if claude_drafting.enabled():
            self.narrator = Narrator(self.engine, self.lock, self.stop_event)
            self.narrator.start()
        self.ticker = threading.Thread(target=self._tick_loop, name="stream-ticker", daemon=True)
        self.ticker.start()

    def _resume_and_record(self, readers: list[StreamReader]) -> None:
        """Rebuild from this session's recording (if any), then keep recording to it."""
        path = rec.resumable(BASE_URL) if RESUME else None
        if path is not None:
            try:
                recording = rec.load(path)
                with self.lock:
                    rec.fast_forward(self.engine, recording.signals, TICK_SECONDS)
                ids, counts = recording.last_ids(), recording.counts()
                for r in readers:
                    r.restore(ids.get(r.stream), counts.get(r.stream, {}))
                self.resumed = {"source": path.name, "signals": len(recording.signals),
                                "events": len(recording.events)}
                log.info("resumed %d signals from %s", len(recording.signals), path.name)
            except Exception:
                log.exception("could not resume from %s; starting fresh", path)
                path = None
        if not RECORD:
            return
        try:
            self.recorder = (rec.Recorder(path, BASE_URL, fresh=False) if path is not None
                             else rec.Recorder.new_session(BASE_URL))
        except Exception:
            log.exception("could not open a recording; ingestion continues without one")
            return
        for r in readers:
            r.recorder = self.recorder

    def _start_replay(self, known: list[str]) -> None:
        path = rec.latest() if REPLAY == "latest" else Path(REPLAY)
        if path is None or not path.is_file():
            raise FileNotFoundError(f"NEXUS_REPLAY: no recording at {REPLAY!r}")
        recording = rec.load(path)
        if REPLAY_FROM == "start":
            start_at = None
        elif REPLAY_FROM == "busiest":
            start_at = rec.busiest_start(recording.signals)
        else:
            start_at = datetime.fromisoformat(REPLAY_FROM.replace("Z", "+00:00"))
        readers = {name: StreamReader(name, self.engine, known, self.stop_event) for name in STREAMS}
        self.readers.extend(readers.values())       # status holders only; never connected
        self.replay = ReplayReader(self, recording, readers, REPLAY_SPEED, start_at)
        self.replay.start()

    def _tick_loop(self) -> None:
        while not self.stop_event.wait(TICK_SECONDS):
            try:
                with self.lock:
                    summary = self.engine.tick()
                    touched, self.engine.touched = self.engine.touched, set()
                summary["touched"] = sorted(touched)     # drafts raised or grown this tick
                if self.narrator is not None:
                    for draft_id in touched:
                        self.narrator.submit(draft_id)
                if self.on_tick:
                    self.on_tick(summary)
            except Exception:
                log.exception("stream tick failed")

    def stop(self) -> None:
        self.stop_event.set()
        if self.recorder is not None:
            self.recorder.close()

    def status(self) -> dict[str, Any]:
        return {
            "base_url": BASE_URL,
            "tickets_dir": str(tickets_dir()),
            "graph_origin": self.graph_origin,
            "uptime_seconds": round(time.time() - self.started_at, 1) if self.started_at else 0,
            "tick_seconds": TICK_SECONDS,
            "streams": [r.status.as_dict() for r in self.readers],
            "claude": {"enabled": self.narrator is not None, "model": claude_drafting.MODEL,
                       **(self.narrator.stats if self.narrator else {})},
            "engine": self.engine.status(),
            "replay": self.replay.as_dict() if self.replay else {"active": False},
            "resumed": self.resumed,
            "recording": self.recorder.path.name if self.recorder else None,
        }


def build_runtime(queue=None, on_new_incident=None) -> LiveRuntime:
    adjacency, origin = load_reference_graph()
    graph = graph_from_adjacency(adjacency)
    crit = criticality_map()
    for svc in adjacency:
        crit.setdefault(svc, DEFAULT_CRITICALITY / 100.0)
    engine = StreamEngine(graph, crit, queue=queue, on_new_incident=on_new_incident)
    return LiveRuntime(engine=engine, lock=threading.RLock(), graph_origin=origin, adjacency=adjacency)


def replay_file(runtime: LiveRuntime, stream: str, path: str) -> int:
    """Feed a captured SSE transcript (e.g. `curl -N ... > file`) through the
    same parser as the live readers. For offline testing only."""
    known = sorted(runtime.adjacency)
    reader = StreamReader(stream, runtime.engine, known, runtime.stop_event)
    n = 0
    with open(path, encoding="utf-8") as fh:
        for ev in iter_sse(iter(fh)):
            reader.handle(ev)
            n += 1
    return n


__all__ = ["LiveRuntime", "build_runtime", "iter_sse", "SSEEvent", "replay_file",
           "criticality_map", "graph_from_adjacency", "load_reference_graph"]
