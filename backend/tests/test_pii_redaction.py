"""Redaction against a corpus of PII in realistic shapes (see pii_corpus.py).

Two directions, both asserted: every planted secret is gone (recall), and every
piece of evidence that is not PII survives (no false positives). The aggregate
numbers are printed with -s and are the ones quoted in the README and the deck.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.redaction import redact_text  # noqa: E402
from pii_corpus import CASES, Case, C  # noqa: E402


@pytest.mark.parametrize("case", CASES, ids=[c.id for c in CASES])
def test_secrets_are_removed_and_evidence_is_kept(case: Case):
    out, _kinds = redact_text(case.text)
    leaked = [s for s in case.secrets if s in out]
    assert not leaked, f"PII survived redaction: {leaked!r} in {out!r}"
    destroyed = [k for k in case.keep if k not in out]
    assert not destroyed, f"evidence was redacted away: {destroyed!r} in {out!r}"


def test_corpus_recall_and_false_positive_rate(capsys):
    planted = leaked = kept_total = destroyed = 0
    for c in CASES:
        out, _ = redact_text(c.text)
        planted += len(c.secrets)
        leaked += sum(1 for s in c.secrets if s in out)
        kept_total += len(c.keep)
        destroyed += sum(1 for k in c.keep if k not in out)
    recall = 1 - leaked / planted
    with capsys.disabled():
        print(f"\nPII corpus: {len(CASES)} cases · {planted} planted values, recall {recall:.1%} "
              f"· {kept_total} evidence values, {destroyed} wrongly redacted")
    assert recall == 1.0
    assert destroyed == 0


# Real, documented limits. Strict xfail: if one is ever fixed the test fails and
# the case must be moved into the corpus above.
LIMITS = [
    C("name-rare-uncued", "Refund failed for Oluwaseun Adeyemi", ["Oluwaseun Adeyemi"],
      note="a first name not in redaction_names, with no cue word and no email"),
]


@pytest.mark.parametrize("case", LIMITS, ids=[c.id for c in LIMITS])
@pytest.mark.xfail(strict=True, reason="known limit: uncommon name with no cue and no earlier email")
def test_known_limits_are_still_limits(case: Case):
    out, _ = redact_text(case.text)
    assert not [s for s in case.secrets if s in out]


def test_redaction_is_idempotent():
    """Redacting already-redacted text changes nothing: recordings and replays
    pass through the redactor more than once."""
    for c in CASES:
        once, _ = redact_text(c.text)
        twice, _ = redact_text(once)
        assert twice == once, c.id


def test_a_human_edit_is_redacted_too():
    """What a reviewer types into an edit is redacted like any other input."""
    from app.engine.review import _redact_edit

    edited = _redact_edit({"summary": "Call Rohan Mehta on +91 98765 43210"}["summary"])
    assert "Rohan Mehta" not in edited and "98765" not in edited
    steps = _redact_edit(["Ask neha.joshi@acmecorp.com about sess_kd3dxt", "check payments-service"])
    assert "neha.joshi" not in steps[0] and "sess_kd3dxt" not in steps[0]
    assert steps[1] == "check payments-service"
    assert _redact_edit("P2") == "P2"
