"""Trust-boundary tests — the controls in app/security.py, asserted not assumed.

The engine's functional constraints (no auto-publish, no duplicate tickets) have
had tests since Phase 1. These cover the other half: who is allowed to reach
those endpoints at all, how much a single caller may spend, and what a malformed
request is allowed to destroy.

`203.0.113.x` is TEST-NET-3 (RFC 5737) — reserved for documentation, so it can
never be a real client and reads unambiguously as "not this machine".
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import security

REMOTE = ("203.0.113.10", 51000)


@pytest.fixture(autouse=True)
def _reset_limits():
    """Rate-limit counters are process-global; never leak them between tests."""
    security.reset_rate_limits()
    yield
    security.reset_rate_limits()


@pytest.fixture
def remote_client(isolated_db, monkeypatch):
    """A client that does not appear to come from the loopback interface."""
    import app.main as main_module

    monkeypatch.setattr(main_module, "_initial_load", lambda: None)
    with TestClient(main_module.app, client=REMOTE) as c:
        yield c


# --------------------------------------------------------------------------
# authentication
# --------------------------------------------------------------------------


def test_health_is_reachable_without_a_key(client):
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_health_stays_reachable_for_a_remote_probe(remote_client):
    """A locked-down deployment must still be health-checkable by its host."""
    assert remote_client.get("/health").status_code == 200


def test_health_leaks_nothing_beyond_liveness(client):
    assert set(client.get("/health").json()) == {"status"}


def test_local_request_allowed_when_no_key_is_configured(client, monkeypatch):
    monkeypatch.delenv("ALERTLENS_API_KEY", raising=False)
    assert client.get("/pipeline").status_code == 200


def test_remote_request_refused_when_no_key_is_configured(remote_client, monkeypatch):
    """The insecure-by-default trap: an unconfigured deployment that is
    nonetheless reachable must fail closed rather than serve everyone."""
    monkeypatch.delenv("ALERTLENS_API_KEY", raising=False)
    response = remote_client.get("/pipeline")
    assert response.status_code == 403
    assert "ALERTLENS_API_KEY" in response.json()["detail"]


def test_remote_request_allowed_with_the_correct_key(remote_client, monkeypatch):
    monkeypatch.setenv("ALERTLENS_API_KEY", "correct-horse-battery-staple")
    response = remote_client.get(
        "/pipeline", headers={"X-API-Key": "correct-horse-battery-staple"}
    )
    assert response.status_code == 200


def test_remote_request_rejected_with_a_wrong_key(remote_client, monkeypatch):
    monkeypatch.setenv("ALERTLENS_API_KEY", "correct-horse-battery-staple")
    response = remote_client.get("/pipeline", headers={"X-API-Key": "guess"})
    assert response.status_code == 401


def test_remote_request_rejected_with_no_key_header(remote_client, monkeypatch):
    monkeypatch.setenv("ALERTLENS_API_KEY", "correct-horse-battery-staple")
    assert remote_client.get("/pipeline").status_code == 401


def test_configuring_a_key_also_locks_out_unauthenticated_local_calls(client, monkeypatch):
    """Once a key exists it is the only way in, including from this machine —
    otherwise anything running locally inherits full write access."""
    monkeypatch.setenv("ALERTLENS_API_KEY", "correct-horse-battery-staple")
    assert client.get("/pipeline").status_code == 401
    assert client.get(
        "/pipeline", headers={"X-API-Key": "correct-horse-battery-staple"}
    ).status_code == 200


def test_write_endpoints_are_behind_the_same_gate(remote_client, monkeypatch):
    """The review gate proves a human approved a draft; this proves a stranger
    cannot be that human."""
    monkeypatch.delenv("ALERTLENS_API_KEY", raising=False)
    assert remote_client.post("/engine/golden").status_code == 403
    assert remote_client.post("/incidents/0/ticket/approve").status_code == 403
    assert remote_client.post("/ingest", json=[]).status_code == 403
    assert remote_client.post("/maintenance", json={}).status_code == 403


def test_a_non_ascii_key_header_does_not_crash_the_comparison(remote_client, monkeypatch):
    """Headers are latin-1 on the wire, so a hostile client can send bytes no
    browser would. compare_digest raises on non-ASCII `str`, which would turn a
    rejected key into a 500 — comparing encoded bytes is what keeps it a 401."""
    monkeypatch.setenv("ALERTLENS_API_KEY", "ascii-key")
    response = remote_client.get(
        "/pipeline", headers={"X-API-Key": "ключ".encode("utf-8")}
    )
    assert response.status_code == 401


# --------------------------------------------------------------------------
# rate limiting
# --------------------------------------------------------------------------


def test_llm_backed_route_is_rate_limited(remote_client, monkeypatch):
    monkeypatch.setenv("ALERTLENS_API_KEY", "k")
    monkeypatch.setenv("ALERTLENS_EXPENSIVE_RATE_LIMIT", "3")
    headers = {"X-API-Key": "k"}
    body = {"incident_id": "0", "question": "what happened?"}

    codes = [
        remote_client.post("/assistant", json=body, headers=headers).status_code
        for _ in range(5)
    ]
    assert codes.count(429) == 2, codes


def test_expensive_and_default_budgets_are_separate(remote_client, monkeypatch):
    """Draining the LLM budget must not lock a reviewer out of reading the queue."""
    monkeypatch.setenv("ALERTLENS_API_KEY", "k")
    monkeypatch.setenv("ALERTLENS_EXPENSIVE_RATE_LIMIT", "1")
    headers = {"X-API-Key": "k"}
    body = {"incident_id": "0", "question": "q"}

    remote_client.post("/assistant", json=body, headers=headers)
    assert remote_client.post("/assistant", json=body, headers=headers).status_code == 429
    assert remote_client.get("/pipeline", headers=headers).status_code == 200


def test_local_traffic_is_exempt_unless_forced(client, monkeypatch):
    monkeypatch.delenv("ALERTLENS_API_KEY", raising=False)
    monkeypatch.setenv("ALERTLENS_RATE_LIMIT", "2")
    for _ in range(6):
        assert client.get("/pipeline").status_code == 200

    monkeypatch.setenv("ALERTLENS_RATE_LIMIT_FORCE", "1")
    security.reset_rate_limits()
    codes = [client.get("/pipeline").status_code for _ in range(4)]
    assert 429 in codes


# --------------------------------------------------------------------------
# request size
# --------------------------------------------------------------------------


def test_oversized_declared_body_is_rejected(client, monkeypatch):
    monkeypatch.setenv("ALERTLENS_MAX_BODY_BYTES", "200")
    response = client.post("/ingest", json=[{"padding": "x" * 5_000}])
    assert response.status_code == 413


def test_ingest_batch_size_is_capped(client, monkeypatch, alert_factory):
    monkeypatch.setattr("app.main.MAX_INGEST_ALERTS", 3)
    alerts = [alert_factory(id=f"a-{i}") for i in range(4)]
    assert client.post("/ingest", json=alerts).status_code == 413


# --------------------------------------------------------------------------
# malformed input must not be destructive
# --------------------------------------------------------------------------


def test_malformed_ingest_does_not_destroy_existing_alerts(client, isolated_db, alert_factory):
    """The regression that motivated _validate_ingest: the pipeline clears the
    alerts table before writing, and save_alerts indexes `id` directly — so an
    unvalidated `[{}]` used to wipe the table and only then raise."""
    seeded = [alert_factory(id="keep-me-1"), alert_factory(id="keep-me-2")]
    assert client.post("/ingest", json=seeded).status_code == 200
    assert len(isolated_db.load_alerts()) == 2

    assert client.post("/ingest", json=[{}]).status_code == 422

    surviving = {a["id"] for a in isolated_db.load_alerts()}
    assert surviving == {"keep-me-1", "keep-me-2"}


def test_ingest_rejects_a_missing_timestamp(client, alert_factory):
    alert = alert_factory()
    del alert["timestamp"]
    response = client.post("/ingest", json=[alert])
    assert response.status_code == 422
    assert "timestamp" in response.json()["detail"]


def test_ingest_rejects_an_unparseable_timestamp(client, alert_factory):
    alert = alert_factory()
    alert["timestamp"] = "last tuesday"
    assert client.post("/ingest", json=[alert]).status_code == 422


def test_ingest_rejects_a_non_object_entry(client):
    assert client.post("/ingest", json=["not-an-alert"]).status_code == 422


def test_ingest_rejects_duplicate_ids_within_a_batch(client, alert_factory):
    alerts = [alert_factory(id="same"), alert_factory(id="same")]
    assert client.post("/ingest", json=alerts).status_code == 422


# --------------------------------------------------------------------------
# redaction covers the dict pipeline too
# --------------------------------------------------------------------------


def test_ingest_redacts_pii_before_it_reaches_storage(client, isolated_db, alert_factory):
    """"No PII stored" has to hold for the pipeline that actually stores things."""
    alert = alert_factory(
        id="pii-1",
        message="paged ops@example.com after card 4111111111111111 was declined",
    )
    assert client.post("/ingest", json=[alert]).status_code == 200

    stored = isolated_db.load_alerts()
    assert len(stored) == 1
    message = stored[0]["message"]
    assert "ops@example.com" not in message
    assert "4111111111111111" not in message
    assert "[REDACTED:EMAIL]" in message
    assert "[REDACTED:CARD]" in message


def test_redaction_preserves_the_fields_the_pipeline_keys_on(client, isolated_db, alert_factory):
    alert = alert_factory(id="structural-1", service="postgres-primary")
    assert client.post("/ingest", json=[alert]).status_code == 200

    stored = isolated_db.load_alerts()[0]
    assert stored["id"] == "structural-1"
    assert stored["service"] == "postgres-primary"
    assert stored["timestamp"] == alert["timestamp"]


def test_private_addresses_are_redacted(client, isolated_db, alert_factory):
    """The challenge rules name IP addresses as PII, private ranges included."""
    alert = alert_factory(id="ip-1", message="upstream 10.0.3.14 refused the connection")
    assert client.post("/ingest", json=[alert]).status_code == 200
    stored = isolated_db.load_alerts()[0]["message"]
    assert "10.0.3.14" not in stored and "[REDACTED:IPV4]" in stored


# --------------------------------------------------------------------------
# LLM input bounds
# --------------------------------------------------------------------------


def test_assistant_rejects_an_oversized_question(client):
    response = client.post(
        "/assistant", json={"incident_id": "0", "question": "x" * 5_000}
    )
    assert response.status_code == 422


def test_assistant_rejects_an_oversized_conversation_turn(client):
    response = client.post(
        "/assistant",
        json={
            "incident_id": "0",
            "question": "ok",
            "conversation": [{"role": "user", "content": "x" * 10_000}],
        },
    )
    assert response.status_code == 422


def test_assistant_rejects_too_many_conversation_turns(client):
    response = client.post(
        "/assistant",
        json={
            "incident_id": "0",
            "question": "ok",
            "conversation": [{"role": "user", "content": "hi"}] * 100,
        },
    )
    assert response.status_code == 422


def test_workspace_assistant_rejects_an_oversized_context(client):
    response = client.post(
        "/assistant/workspace",
        json={"question": "ok", "workspace_context": {"blob": "x" * 20_000}},
    )
    assert response.status_code == 422


def test_assistant_still_accepts_a_normal_question(client):
    response = client.post(
        "/assistant/workspace", json={"question": "what is the top incident?"}
    )
    assert response.status_code == 200


# --------------------------------------------------------------------------
# CORS
# --------------------------------------------------------------------------


def test_cors_is_never_wildcard():
    assert "*" not in security.allowed_origins()


def test_cors_defaults_to_local_development_origins(monkeypatch):
    monkeypatch.delenv("ALERTLENS_ALLOWED_ORIGINS", raising=False)
    assert all("localhost" in o or "127.0.0.1" in o for o in security.allowed_origins())


def test_cors_origins_are_configurable(monkeypatch):
    monkeypatch.setenv("ALERTLENS_ALLOWED_ORIGINS", "https://a.example, https://b.example")
    assert security.allowed_origins() == ["https://a.example", "https://b.example"]


# --------------------------------------------------------------------------
# loopback is spelled several ways
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "host",
    [
        "127.0.0.1",        # curl, and anything using IPv4 directly
        "::1",              # a client that resolved localhost to IPv6
        "::ffff:127.0.0.1", # IPv4-mapped IPv6 — what Node, and so the Next proxy, sends
        "127.0.0.2",        # the whole 127/8 block is loopback, not just .1
    ],
)
def test_every_loopback_spelling_counts_as_local(isolated_db, monkeypatch, host):
    """The frontend proxies server-side, so its calls reach the backend as
    IPv4-mapped IPv6. Matching loopback as a list of strings missed that
    spelling and refused the default local demo — with all other tests green,
    because TestClient's own host is none of these."""
    import app.main as main_module

    monkeypatch.delenv("ALERTLENS_API_KEY", raising=False)
    monkeypatch.setattr(main_module, "_initial_load", lambda: None)
    with TestClient(main_module.app, client=(host, 40000)) as c:
        assert c.get("/pipeline").status_code == 200


@pytest.mark.parametrize("host", ["203.0.113.10", "10.1.2.3", "192.168.1.9", "not-an-ip"])
def test_non_loopback_hosts_are_not_local(isolated_db, monkeypatch, host):
    """Private-range addresses are still someone else's machine."""
    import app.main as main_module

    monkeypatch.delenv("ALERTLENS_API_KEY", raising=False)
    monkeypatch.setattr(main_module, "_initial_load", lambda: None)
    with TestClient(main_module.app, client=(host, 40000)) as c:
        assert c.get("/pipeline").status_code == 403
