"""summarize() calls out to Cerebras/Groq. Real network calls are never made
here — `_configured_providers` and `_call_chat_api` are monkeypatched so
these tests exercise the real fallback/retry orchestration deterministically,
independent of whatever real keys happen to be in the repo's .env."""

import http.client
import time
import urllib.error

import pytest

from app import summarizer


def _alerts():
    return [
        {"service": "postgres-primary", "severity": "critical", "message": "pool exhausted"},
        {"service": "api-gateway", "severity": "high", "message": "upstream timeout"},
    ]


def _root():
    return {"alertname": "DBConnectionPoolExhausted", "service": "postgres-primary"}


class TestTemplateSummary:
    def test_includes_root_cause_and_service_count(self):
        text = summarizer._template_summary(_alerts(), _root())
        assert "DBConnectionPoolExhausted" in text
        assert "postgres-primary" in text
        assert "2 related alerts" in text

    def test_includes_dna_match_when_present(self):
        dna = {"incident_id": "INC-0389", "similarity_pct": 87.0, "resolution": "restarted pool", "resolution_minutes": 12}
        text = summarizer._template_summary(_alerts(), _root(), dna)
        assert "INC-0389" in text
        assert "restarted pool" in text

    def test_omits_dna_section_when_absent(self):
        text = summarizer._template_summary(_alerts(), _root(), None)
        assert "Resembles" not in text


class TestBuildPrompt:
    def test_prompt_includes_root_cause_and_sample_messages(self):
        prompt = summarizer._build_prompt(_alerts(), _root(), None)
        assert "DBConnectionPoolExhausted" in prompt
        assert "pool exhausted" in prompt

    def test_prompt_includes_dna_when_present(self):
        dna = {"incident_id": "INC-0389", "similarity_pct": 87.0, "resolution": "restarted pool", "resolution_minutes": 12}
        prompt = summarizer._build_prompt(_alerts(), _root(), dna)
        assert "INC-0389" in prompt


class TestSummarize:
    def test_no_providers_configured_uses_template(self, monkeypatch):
        monkeypatch.setattr(summarizer, "_configured_providers", lambda: [])
        result = summarizer.summarize(_alerts(), _root(), None)
        assert result == summarizer._template_summary(_alerts(), _root(), None)

    def test_first_provider_success_used_directly(self, monkeypatch):
        monkeypatch.setattr(
            summarizer, "_configured_providers",
            lambda: [("cerebras", "fake-key", "https://fake", "fake-model")],
        )
        monkeypatch.setattr(summarizer, "_call_chat_api", lambda *a, **k: "Real LLM summary text.")
        result = summarizer.summarize(_alerts(), _root(), None)
        assert result == "Real LLM summary text."

    def test_first_provider_fails_second_succeeds(self, monkeypatch):
        calls = []

        def fake_call(api_key, url, model, prompt):
            calls.append(model)
            if model == "model-a":
                # URLError is what urlopen actually raises on a real
                # connection failure — one of the exception types
                # _llm_summary's except tuple explicitly catches.
                raise urllib.error.URLError("blocked")
            return "Groq answered instead."

        monkeypatch.setattr(
            summarizer, "_configured_providers",
            lambda: [
                ("cerebras", "k1", "https://a", "model-a"),
                ("groq", "k2", "https://b", "model-b"),
            ],
        )
        monkeypatch.setattr(summarizer, "_call_chat_api", fake_call)
        result = summarizer.summarize(_alerts(), _root(), None)
        assert result == "Groq answered instead."
        assert calls == ["model-a", "model-b"]

    def test_all_providers_fail_falls_back_to_template(self, monkeypatch, capsys):
        monkeypatch.setattr(
            summarizer, "_configured_providers",
            lambda: [("cerebras", "k1", "https://a", "model-a")],
        )

        def always_fail(*a, **k):
            raise TimeoutError("no response")

        monkeypatch.setattr(summarizer, "_call_chat_api", always_fail)
        result = summarizer.summarize(_alerts(), _root(), None)
        assert result == summarizer._template_summary(_alerts(), _root(), None)

    def test_empty_llm_response_falls_back_to_template(self, monkeypatch):
        monkeypatch.setattr(
            summarizer, "_configured_providers",
            lambda: [("cerebras", "k1", "https://a", "model-a")],
        )
        monkeypatch.setattr(summarizer, "_call_chat_api", lambda *a, **k: "")
        result = summarizer.summarize(_alerts(), _root(), None)
        assert result == summarizer._template_summary(_alerts(), _root(), None)

    @pytest.mark.parametrize("exc", [
        ConnectionError("not in the old except tuple"),
        # What urlopen really lets through unwrapped: getresponse() raises
        # RemoteDisconnected when the provider hangs up, resp.read() raises
        # IncompleteRead on a truncated body, and both surface as
        # ConnectionReset/AbortedError on Windows.
        http.client.RemoteDisconnected("Remote end closed connection without response"),
        http.client.IncompleteRead(b"{\"choices\": ["),
        ConnectionResetError(10054, "An existing connection was forcibly closed"),
        # A 200 with a malformed body — {"choices": null} — subscripts None.
        TypeError("'NoneType' object is not subscriptable"),
    ], ids=lambda e: type(e).__name__)
    def test_exception_outside_the_old_caught_tuple_falls_back_to_template(
        self, monkeypatch, exc
    ):
        """Mounil Kanakhara flagged this asymmetry (his original test pinned
        the then-current behavior and called it "not desired"): _llm_summary
        caught only (URLError, HTTPError, KeyError, IndexError, TimeoutError,
        ValueError) — narrower than assistant.py's equivalent provider loop,
        which catches broad Exception — so anything else _call_chat_api
        raised crashed summarize() instead of falling back to the template.
        That was a real bug, not a quirk: run_pipeline() maps
        summarize_with_source() over the top incidents in a thread pool, and
        pool.map re-raises, so one flaky provider hang-up failed an entire
        dataset load with a 500 (verified against a loopback server: a
        hang-up gives RemoteDisconnected, a truncated body IncompleteRead, a
        {"choices": null} body TypeError — none of them in the old tuple).
        _llm_summary now catches Exception, so every one of these degrades to
        the deterministic template instead."""
        monkeypatch.setattr(
            summarizer, "_configured_providers",
            lambda: [("cerebras", "k1", "https://a", "model-a")],
        )

        def raises(*a, **k):
            raise exc

        monkeypatch.setattr(summarizer, "_call_chat_api", raises)
        result = summarizer.summarize(_alerts(), _root(), None)
        assert result == summarizer._template_summary(_alerts(), _root(), None)
        # The cooldown must still engage on these failures, exactly as it does
        # for the types the old tuple caught — otherwise a broken provider
        # costs one full failure latency per incident in the batch.
        assert summarizer._llm_down_until > time.monotonic()

    def test_cooldown_skips_llm_calls_after_all_providers_fail(self, monkeypatch):
        """The cooldown _llm_summary sets after a total failure is what made
        Mounil's test order-dependent (it leaks between tests unless reset —
        see conftest's no_real_llm_calls_by_default). Pin the production
        behavior it encodes: no provider call at all while the cooldown is
        live, and calls resume once it lapses."""
        calls = []

        def fail(*a, **k):
            calls.append(1)
            raise TimeoutError("no response")

        monkeypatch.setattr(
            summarizer, "_configured_providers",
            lambda: [("cerebras", "k1", "https://a", "model-a")],
        )
        monkeypatch.setattr(summarizer, "_call_chat_api", fail)

        template = summarizer._template_summary(_alerts(), _root(), None)
        assert summarizer.summarize(_alerts(), _root(), None) == template
        assert len(calls) == 1

        # Second incident in the same batch: template again, without paying
        # the failure latency a second time.
        assert summarizer.summarize(_alerts(), _root(), None) == template
        assert len(calls) == 1

        # Once the cooldown lapses, the LLM path is tried again.
        summarizer._llm_down_until = time.monotonic() - 0.1
        assert summarizer.summarize(_alerts(), _root(), None) == template
        assert len(calls) == 2
