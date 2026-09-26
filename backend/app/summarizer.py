"""Cluster summarization — real LLM call via Cerebras or Groq (both speak the
same OpenAI-compatible chat completions API), with the original deterministic
template kept as a fallback so a missing key or a blocked network path never
breaks the pipeline.

Both providers are tried in order at request time (not just once at startup)
— if one's network path is blocked (e.g. a host's outbound IP range flagged
by a provider's WAF) the next configured provider is tried automatically.

Interface is unchanged: ``summarize(cluster_alerts, root_cause, dna_match)``
returns a short incident description. Everything else in the pipeline is
untouched by this file.
"""

from __future__ import annotations

import json
import time
import os
import urllib.request
from pathlib import Path

# (env var, chat completions URL, model) — same provider list and priority
# as app/assistant.py.
PROVIDERS = [
    ("CEREBRAS_API_KEY", "https://api.cerebras.ai/v1/chat/completions", "gpt-oss-120b"),
    ("GROQ_API_KEY", "https://api.groq.com/openai/v1/chat/completions", "llama-3.3-70b-versatile"),
]

# Repo-root .env — same file and convention app/assistant.py uses, so both
# AI features share one config file instead of two conflicting ones.
_ENV_PATH = Path(__file__).resolve().parents[2] / ".env"
_ENV_LOADED = False


def _load_env_file() -> None:
    global _ENV_LOADED
    if _ENV_LOADED or not _ENV_PATH.exists():
        return
    _ENV_LOADED = True
    for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and not os.environ.get(key):
            os.environ[key] = value


def _configured_providers() -> list[tuple[str, str, str, str]]:
    """(provider_name, api_key, url, model) for every provider with a real
    key set, in priority order."""
    _load_env_file()
    out = []
    for env_var, url, model in PROVIDERS:
        key = os.environ.get(env_var, "").strip()
        if key:
            name = "cerebras" if "cerebras" in url else "groq"
            out.append((name, key, url, model))
    return out


def _template_summary(cluster_alerts: list[dict], root_cause: dict,
                       dna_match: dict | None = None) -> str:
    services = sorted({a["service"] for a in cluster_alerts})
    n_critical = sum(1 for a in cluster_alerts if a["severity"] == "critical")

    text = (f"Suspected root cause: {root_cause['alertname']} on {root_cause['service']} — "
            f"{len(cluster_alerts)} related alerts ({n_critical} critical) across "
            f"{len(services)} service(s): {', '.join(services)}.")
    if dna_match:
        text += (f" Resembles {dna_match['incident_id']} ({dna_match['similarity_pct']}% similar) — "
                 f"previous fix: {dna_match['resolution']} ({dna_match['resolution_minutes']} min).")
    return text


def _build_prompt(cluster_alerts: list[dict], root_cause: dict,
                   dna_match: dict | None) -> str:
    services = sorted({a["service"] for a in cluster_alerts})
    n_critical = sum(1 for a in cluster_alerts if a["severity"] == "critical")
    sample_msgs = [a["message"] for a in cluster_alerts[:5]]

    lines = [
        "You are an SRE incident summarizer. Using ONLY the facts below, write a "
        "single tight paragraph (max 2 sentences) an on-call engineer would read "
        "in a 3-second glance: what broke, how big is the blast radius. "
        "Do not invent metrics, timings, or causes not listed below.",
        "",
        f"Root cause alert: {root_cause['alertname']} on service {root_cause['service']}",
        f"Cluster size: {len(cluster_alerts)} alerts ({n_critical} critical) across "
        f"{len(services)} service(s): {', '.join(services)}",
        "Sample alert messages:",
    ]
    lines += [f"- {m}" for m in sample_msgs]
    if dna_match:
        lines.append(
            f"Similar past incident: {dna_match['incident_id']} "
            f"({dna_match['similarity_pct']}% similar), resolved by: "
            f"{dna_match['resolution']} in {dna_match['resolution_minutes']} min."
        )
    return "\n".join(lines)


def _call_chat_api(api_key: str, url: str, model: str, prompt: str) -> str:
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": 120,
        "temperature": 0.2,
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            # Cloudflare (fronting both providers) blocks the bare
            # "Python-urllib/x.y" default User-Agent as a bot signature
            # (error code 1010) — a normal-looking one sails through.
            "User-Agent": "Mozilla/5.0 (compatible; AlertLens-Backend/1.0)",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=6) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    return (data["choices"][0]["message"]["content"] or "").strip()


# After every configured provider fails (quota, outage, timeouts), skip LLM
# calls for a while: a large batch would otherwise pay the full failure
# latency once per incident before falling back to the template anyway.
_LLM_COOLDOWN_SEC = 60.0
_llm_down_until = 0.0


def _llm_summary(cluster_alerts: list[dict], root_cause: dict,
                  dna_match: dict | None) -> str | None:
    global _llm_down_until
    providers = _configured_providers()
    if not providers or time.monotonic() < _llm_down_until:
        return None
    prompt = _build_prompt(cluster_alerts, root_cause, dna_match)
    for provider, api_key, url, model in providers:
        try:
            text = _call_chat_api(api_key, url, model, prompt)
            if text:
                return text
        # Deliberately broad, matching assistant.py's provider loop: the LLM
        # summary is an optional enhancement over _template_summary, and
        # run_pipeline() maps summarize_with_source() over the top incidents
        # in a thread pool, so ANY exception escaping here re-raises out of
        # pool.map and fails the whole dataset load with a 500. A flaky
        # provider must degrade to the template, never take the pipeline
        # down. The old narrow tuple (URLError, HTTPError, KeyError,
        # IndexError, TimeoutError, ValueError) missed real failure modes:
        # urlopen lets http.client.RemoteDisconnected, IncompleteRead and
        # ConnectionReset/AbortedError through unwrapped from getresponse()/
        # read(), and a malformed body like {"choices": null} raises
        # TypeError. Only the provider call is inside the try, so a genuine
        # bug in _build_prompt/_template_summary still surfaces; the type
        # name is logged so a bug here isn't silent either.
        except Exception as e:
            print(f"[summarizer] {provider} call failed ({type(e).__name__}: {e}), "
                  f"trying next provider")
    print("[summarizer] all configured providers failed, falling back to template")
    _llm_down_until = time.monotonic() + _LLM_COOLDOWN_SEC
    return None


def summarize_with_source(cluster_alerts: list[dict], root_cause: dict,
                          dna_match: dict | None = None,
                          use_llm: bool = True) -> tuple[str, str]:
    """(text, source) where source is "llm" or "template" - which path actually
    produced the text, so callers never have to guess or hardcode it."""
    llm_text = _llm_summary(cluster_alerts, root_cause, dna_match) if use_llm else None
    if llm_text:
        return llm_text, "llm"
    return _template_summary(cluster_alerts, root_cause, dna_match), "template"


def summarize(cluster_alerts: list[dict], root_cause: dict,
              dna_match: dict | None = None, use_llm: bool = True) -> str:
    return summarize_with_source(cluster_alerts, root_cause, dna_match, use_llm)[0]
