"""TICKETS - the one write path: approved drafts become files in output/tickets/.

The challenge asks for tickets to be written only after explicit human approval.
This transport plugs into JiraClient in place of the mock, so the approval
token, single-use and idempotency guarantees in review.py are unchanged: the
only caller of `__call__` is JiraClient.create_issue, which consumes a token.

Each ticket is written twice: JSON (machine-readable, the full draft) and
Markdown (what a human reads). Late evidence on an approved ticket is appended
as a comment to the Markdown and recorded in the JSON, never as a new ticket.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_DIR = Path(os.getenv("TICKETS_DIR", Path(__file__).resolve().parents[3] / "output" / "tickets"))

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


class FileTicketTransport:
    def __init__(self, directory: Path | str | None = None) -> None:
        self.dir = Path(directory) if directory else DEFAULT_DIR
        self._lock = threading.Lock()
        self.sent: list[dict] = []

    def _next_key(self) -> str:
        self.dir.mkdir(parents=True, exist_ok=True)
        existing = [int(m.group(1)) for p in self.dir.glob("TKT-*.json")
                    if (m := re.match(r"TKT-(\d+)", p.name))]
        return f"TKT-{(max(existing) + 1) if existing else 1:04d}"

    def _paths(self, key: str) -> tuple[Path, Path]:
        key = _SAFE.sub("_", key)
        return self.dir / f"{key}.json", self.dir / f"{key}.md"

    def __call__(self, payload: dict) -> dict:
        with self._lock:
            key = self._next_key()
            json_path, md_path = self._paths(key)
            record = {
                "key": key,
                "written_at": datetime.now(timezone.utc).isoformat(),
                "approved_by": payload.get("approved_by"),
                "draft_id": payload.get("idempotency_key"),
                "ticket": payload.get("ticket") or payload.get("fields"),
                "comments": [],
            }
            json_path.write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
            md_path.write_text(payload.get("markdown") or payload["fields"]["description"], encoding="utf-8")
            self.sent.append(payload)
            return {"id": key, "key": key, "self": str(json_path)}

    def comment(self, key: str, body: str) -> None:
        with self._lock:
            json_path, md_path = self._paths(key)
            if not json_path.exists():
                return
            at = datetime.now(timezone.utc).isoformat()
            record = json.loads(json_path.read_text(encoding="utf-8"))
            record.setdefault("comments", []).append({"at": at, "body": body})
            json_path.write_text(json.dumps(record, indent=2, default=str), encoding="utf-8")
            with md_path.open("a", encoding="utf-8") as fh:
                fh.write(f"\n\n---\n**Update {at}**: {body}\n")
