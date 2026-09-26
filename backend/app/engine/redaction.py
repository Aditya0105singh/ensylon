"""PII / PHI / PCI redaction — Hard constraint #3.

Runs at the ingestion boundary, before a signal reaches any persistent store
or any external API (including the LLM used for drafting). Placing it here
rather than in front of each consumer means no downstream component can leak
what it never received — the constraint holds by construction rather than by
every future contributor remembering to call it.

Two passes, for two different problems:

  1. Structured formats (cards, emails, tokens, SSNs, IPs) — regex. Exact,
     fast, no dependencies, and the patterns are auditable by a reviewer.
  2. Free-text names and addresses — a pluggable NER recognizer. Regex
     structurally cannot do this: "contact Priya Sharma" has no lexical
     pattern distinguishing it from "contact support desk".

The NER pass is optional at import time. Presidio pulls in spaCy and a model
download, which is a poor thing to discover missing at 3am during a 24-hour
build, so its absence degrades to regex-only with a visible warning rather
than crashing the pipeline. `redaction_backends()` reports which passes are
actually live so the review UI can show it honestly instead of implying
protection that isn't running.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any, Callable

# --------------------------------------------------------------------------
# Structured patterns
# --------------------------------------------------------------------------

# Ordered: more specific patterns first, so a JWT isn't first half-eaten by
# the generic token rule.
_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("AWS_KEY", re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b")),
    ("BEARER", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}")),
    ("API_KEY", re.compile(
        r"(?i)\b(?:api[_-]?key|secret|token|password|passwd|pwd)\b\s*[=:]\s*[\"']?([^\s\"',;)]{6,})")),
    # Internal service accounts (svc-payments@internal.corp.com) before the
    # generic email rule, so the ticket shows what kind of identity it was.
    ("SERVICE_ACCOUNT", re.compile(r"\bsvc[-_.][A-Za-z0-9._-]*@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("SESSION", re.compile(r"\bsess_[A-Za-z0-9]+\b")),
    ("SESSION", re.compile(r"(?i)\bsession(?:[_ -]?id)?\s*[:=]\s*([A-Za-z0-9_-]{4,})")),
    ("ACCOUNT", re.compile(r"\bACC-\d{4,}\b")),
    ("ACCOUNT", re.compile(r"(?i)\b(?:acc|account(?:[_ -]?(?:id|no|number))?)\s*[:=]\s*([A-Za-z0-9-]{4,})")),
    # AWS account ids are exactly 12 digits (card candidates start at 13).
    ("CLOUD_ACCOUNT", re.compile(r"(?<![\d.-])\d{12}(?![\d.-])")),
    ("SSN", re.compile(r"\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b")),
    # Indian mobile numbers: +91 98765 43210, +91-9876543210, 9876543210.
    ("PHONE", re.compile(r"(?<![\d.])(?:\+91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?![\d.])")),
    ("PHONE", re.compile(r"(?<![\d.])(?:\+\d{1,3}[\s-]?)?(?:\(\d{3}\)|\d{3})[\s-]\d{3}[\s-]\d{4}(?![\d.])")),
    ("IPV6", re.compile(r"\b(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}\b")),
    ("IPV4", re.compile(r"\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b")),
    ("MRN", re.compile(r"(?i)\b(?:mrn|patient[_-]?id)\b\s*[=:]\s*[\"']?([A-Za-z0-9-]{4,})")),
]

# Card numbers are handled separately: the regex alone matches far too much
# (order ids, trace ids, request ids are all long digit runs), so every
# candidate is Luhn-checked before being treated as a real PAN.
# Written so the group can't end on a separator - `(?:\d[ -]?){13,19}` would
# swallow the space *after* the final digit, gluing the placeholder to the
# next word.
_CARD_CANDIDATE = re.compile(r"\b\d(?:[ -]?\d){12,18}\b")

# Every IP address is redacted, private ranges included: the challenge rules
# name IP addresses as PII outright, and a client IP in a log line identifies
# a person regardless of which range it sits in. Internal *hostnames*
# (enrollment-prod-02) are not IPs and are left alone.

# --------------------------------------------------------------------------
# Personal names
# --------------------------------------------------------------------------
#
# There is no NER model installed by default, and a regex cannot tell "Priya
# Sharma" from "Circuit Breaker". Two cheap, auditable signals instead:
#   1. A cue word before a capitalised name ("customer Priya Sharma").
#   2. Names learned from email addresses seen earlier (neha.joshi@... ->
#      "neha joshi"). Only a SHA-256 of the lower-cased name is kept, so the
#      learned set itself holds no readable personal data.

_NAME_CUE = re.compile(
    r"(?:\b(?:[Cc]ustomer|[Uu]ser|[Cc]lient|[Cc]ontact|[Nn]ame|[Mm]ember|[Aa]gent|[Pp]olicyholder|[Ii]nsured|[Cc]aller)"
    r"|\b(?:Mr|Mrs|Ms|Dr)\.?)\s*[:=-]?\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\b"
)
_TITLE_BIGRAM = re.compile(r"\b([A-Z][a-z]+)\s+([A-Z][a-z]+)\b")
_EMAIL_NAME = re.compile(r"\b([A-Za-z]{2,})[._]([A-Za-z]{2,})@")
_learned_name_hashes: set[str] = set()
_MAX_LEARNED_NAMES = 20000


def _name_hash(name: str) -> str:
    return hashlib.sha256(" ".join(name.lower().split()).encode("utf-8")).hexdigest()


def _learn_names(text: str) -> None:
    for first, last in _EMAIL_NAME.findall(text):
        if len(_learned_name_hashes) < _MAX_LEARNED_NAMES:
            _learned_name_hashes.add(_name_hash(f"{first} {last}"))


def learn_names(text: str) -> None:
    """Learn first.last@ names from a value that is redacted by field instead
    of by pattern, so the name pass still recognises that person in free text."""
    _learn_names(text)


def _redact_names(text: str, found: list[str]) -> str:
    def _cue(match: re.Match[str]) -> str:
        found.append("NAME")
        return match.group(0).replace(match.group(1), "[REDACTED:NAME]")

    text = _NAME_CUE.sub(_cue, text)
    if _learned_name_hashes:
        def _known(match: re.Match[str]) -> str:
            if _name_hash(f"{match.group(1)} {match.group(2)}") in _learned_name_hashes:
                found.append("NAME")
                return "[REDACTED:NAME]"
            return match.group(0)
        text = _TITLE_BIGRAM.sub(_known, text)
    return text


def _luhn_ok(digits: str) -> bool:
    """Standard mod-10 checksum. Filters digit runs that merely look card-like."""
    if not 13 <= len(digits) <= 19 or not digits.isdigit():
        return False
    total, parity = 0, len(digits) % 2
    for i, ch in enumerate(digits):
        d = int(ch)
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


# --------------------------------------------------------------------------
# Optional NER backend
# --------------------------------------------------------------------------

_ner_analyzer: Any = None
_ner_available: bool | None = None


def _load_ner() -> Any:
    """Import Presidio lazily. Missing install is a degradation, not a crash."""
    global _ner_analyzer, _ner_available
    if _ner_available is not None:
        return _ner_analyzer
    try:  # pragma: no cover - depends on host having the model installed
        from presidio_analyzer import AnalyzerEngine

        _ner_analyzer = AnalyzerEngine()
        _ner_available = True
    except Exception:
        _ner_analyzer = None
        _ner_available = False
    return _ner_analyzer


_NER_ENTITIES = ("PERSON", "LOCATION", "US_DRIVER_LICENSE", "MEDICAL_LICENSE")


def redaction_backends() -> dict[str, bool]:
    """What is actually running, for honest display in the review UI."""
    _load_ner()
    return {"regex": True, "ner": bool(_ner_available)}


# --------------------------------------------------------------------------
# Core
# --------------------------------------------------------------------------


def redact_text(text: str) -> tuple[str, list[str]]:
    """Redact one string. Returns (clean_text, kinds_found).

    Replacement is a typed placeholder (`[REDACTED:EMAIL]`) rather than a
    blanket mask so a reviewer reading the ticket can still tell *what kind*
    of value sat there — which is often enough context to triage without ever
    exposing the value itself.
    """
    if not text:
        return text, []

    found: list[str] = []
    _learn_names(text)

    # Cards first, Luhn-verified.
    def _card_sub(match: re.Match[str]) -> str:
        digits = re.sub(r"[ -]", "", match.group(0))
        if _luhn_ok(digits):
            found.append("CARD")
            return "[REDACTED:CARD]"
        return match.group(0)

    text = _CARD_CANDIDATE.sub(_card_sub, text)

    for kind, pattern in _PATTERNS:
        def _sub(match: re.Match[str], _kind: str = kind) -> str:
            whole = match.group(0)
            found.append(_kind)
            if match.groups():
                # Keep the key, redact only the value: "api_key=[REDACTED:API_KEY]"
                secret = match.group(1)
                return whole.replace(secret, f"[REDACTED:{_kind}]")
            return f"[REDACTED:{_kind}]"

        text = pattern.sub(_sub, text)

    text = _redact_names(text, found)

    analyzer = _load_ner()
    if analyzer is not None:  # pragma: no cover - requires optional install
        try:
            results = analyzer.analyze(text=text, entities=list(_NER_ENTITIES), language="en")
            for res in sorted(results, key=lambda r: r.start, reverse=True):
                if res.score < 0.6:
                    continue
                found.append(res.entity_type)
                text = text[: res.start] + f"[REDACTED:{res.entity_type}]" + text[res.end :]
        except Exception:
            pass

    # Preserve first-seen order while removing duplicates.
    return text, list(dict.fromkeys(found))


def redact_signal(signal: Any) -> Any:
    """Redact a Signal in place and record what was removed.

    Mutates rather than copying on purpose: an un-redacted copy lingering in
    memory is exactly the thing this module exists to prevent.
    """
    kinds: list[str] = []

    clean_message, found = redact_text(signal.message or "")
    signal.message = clean_message
    kinds.extend(found)

    if signal.labels:
        clean_labels: dict[str, str] = {}
        for key, value in signal.labels.items():
            clean_value, found = redact_text(str(value))
            clean_labels[key] = clean_value
            kinds.extend(found)
        signal.labels = clean_labels

    signal.redacted_fields = list(dict.fromkeys(kinds))
    return signal


def redact_all(signals: list[Any]) -> tuple[list[Any], dict[str, int]]:
    """Redact a batch and return per-kind counts for the pipeline report."""
    counts: dict[str, int] = {}
    for signal in signals:
        redact_signal(signal)
        for kind in signal.redacted_fields:
            counts[kind] = counts.get(kind, 0) + 1
    return signals, counts


# --------------------------------------------------------------------------
# Plain-dict alerts
# --------------------------------------------------------------------------

# Fields the pipeline and the UI key off. They are identifiers and enums, not
# prose, and rewriting them would break correlation, the DB primary key or the
# action-to-alert mapping — so they are passed through untouched and everything
# else is treated as potentially free text.
_STRUCTURAL_FIELDS = frozenset({
    "id", "timestamp", "status", "severity", "source", "service", "component",
    "fingerprint", "ground_truth", "duplicate_count", "cluster_id", "acked",
    "escalated", "assignee", "status_override", "incident_key",
})


def _redact_value(value: Any, found: list[str]) -> Any:
    """Redact strings anywhere inside a nested alert payload."""
    if isinstance(value, str):
        clean, kinds = redact_text(value)
        found.extend(kinds)
        return clean
    if isinstance(value, dict):
        return {k: _redact_value(v, found) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_value(v, found) for v in value]
    return value


def redact_alert_dict(alert: dict) -> tuple[dict, list[str]]:
    """Redact one plain-dict alert, returning it plus the kinds removed.

    Allowlisted on the *structural* fields rather than the text ones: a new
    free-text field added later is redacted automatically, where an allowlist
    of text fields would silently stop covering it. Getting that default
    backwards is how a redaction layer quietly decays into decoration.
    """
    found: list[str] = []
    for key in list(alert.keys()):
        if key in _STRUCTURAL_FIELDS:
            continue
        alert[key] = _redact_value(alert[key], found)
    kinds = list(dict.fromkeys(found))
    if kinds:
        alert["redacted_fields"] = kinds
    return alert, kinds


def redact_alert_dicts(alerts: list[dict]) -> tuple[list[dict], dict[str, int]]:
    """Redact a batch of dict alerts in place, with per-kind counts."""
    counts: dict[str, int] = {}
    for alert in alerts:
        _, kinds = redact_alert_dict(alert)
        for kind in kinds:
            counts[kind] = counts.get(kind, 0) + 1
    return alerts, counts
