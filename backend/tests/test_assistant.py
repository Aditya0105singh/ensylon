"""ask_incident_assistant / ask_workspace_assistant call out to Cerebras/Groq.
Real network calls are never made here — `_configured_providers` and
`_call_chat_api` are monkeypatched so these tests exercise the real
fallback/retry orchestration deterministically."""

from app import assistant


def _state_with_one_cluster(cluster_id="0"):
    return {
        "clusters": [
            {
                "cluster_id": cluster_id,
                "root_cause": {"service": "postgres-primary", "alertname": "DBConnectionPoolExhausted", "severity": "critical"},
                "summary": "Postgres connection pool exhausted.",
                "risk": {"score": 0.85, "level": "high", "factors": {"growth_rate": 0.8, "severity_trend": 0.7, "service_spread": 0.5}},
                "raw_alert_count": 12,
                "size": 3,
                "dna_match": None,
                "alerts": [
                    {"timestamp": "2026-01-01T12:00:00", "service": "postgres-primary", "alertname": "DBConnectionPoolExhausted", "severity": "critical"},
                ],
            }
        ],
        "noise": [],
        "raw_alerts": [],
        "dedup_stats": {"reduction_pct": 92.0},
    }


class TestFindIncident:
    def test_finds_by_cluster_id(self):
        state = _state_with_one_cluster()
        assert assistant.find_incident(state, "0") is not None

    def test_returns_none_when_missing(self):
        state = _state_with_one_cluster()
        assert assistant.find_incident(state, "does-not-exist") is None


class TestTemplateAnswer:
    def _context(self):
        state = _state_with_one_cluster()
        return assistant.build_incident_context(state, state["clusters"][0])

    def test_risk_keyword_routes_to_risk_section(self):
        answer = assistant._template_answer("why is risk so high?", self._context())
        assert "Risk score" in answer

    def test_fix_keyword_routes_to_fix_section(self):
        answer = assistant._template_answer("what should I fix first?", self._context())
        assert "root cause" in answer.lower() or "fix" in answer.lower()

    def test_dna_keyword_with_no_match_says_novel(self):
        answer = assistant._template_answer("explain the alert dna match", self._context())
        assert "novel" in answer.lower()

    def test_business_keyword_routes_to_impact_section(self):
        answer = assistant._template_answer("what is the business impact?", self._context())
        assert "alerts" in answer.lower()

    def test_generic_question_gets_summary_plus_risk(self):
        answer = assistant._template_answer("tell me about this", self._context())
        assert "Postgres connection pool exhausted" in answer


class TestAskIncidentAssistant:
    def test_incident_not_found_returns_error(self):
        state = _state_with_one_cluster()
        payload = assistant.IncidentAssistantRequest(incident_id="missing", question="what happened?")
        result = assistant.ask_incident_assistant(state, payload)
        assert result["status"] == "error"
        assert result["available"] is False

    def test_no_providers_configured_returns_template_answer(self, monkeypatch):
        monkeypatch.setattr(assistant, "_configured_providers", lambda: [])
        state = _state_with_one_cluster()
        payload = assistant.IncidentAssistantRequest(incident_id="0", question="why is risk high?")
        result = assistant.ask_incident_assistant(state, payload)
        assert result["status"] == "ok"
        assert result["generated"] == "template"
        assert result["provider"] == "template"

    def test_provider_success_returns_real_answer(self, monkeypatch):
        monkeypatch.setattr(
            assistant, "_configured_providers",
            lambda: [("groq", "k1", "https://fake", "llama-3.3-70b")],
        )
        monkeypatch.setattr(assistant, "_call_chat_api", lambda *a, **k: "Real LLM answer about the incident.")
        state = _state_with_one_cluster()
        payload = assistant.IncidentAssistantRequest(incident_id="0", question="explain this")
        result = assistant.ask_incident_assistant(state, payload)
        assert result["answer"] == "Real LLM answer about the incident."
        assert result["provider"] == "groq"
        assert "generated" not in result

    def test_conversation_history_passed_through(self, monkeypatch):
        captured = {}

        def fake_call(api_key, url, model, messages):
            captured["messages"] = messages
            return "answer"

        monkeypatch.setattr(
            assistant, "_configured_providers",
            lambda: [("groq", "k1", "https://fake", "model")],
        )
        monkeypatch.setattr(assistant, "_call_chat_api", fake_call)
        state = _state_with_one_cluster()
        payload = assistant.IncidentAssistantRequest(
            incident_id="0", question="and then?",
            conversation=[assistant.ConversationTurn(role="user", content="first question")],
        )
        assistant.ask_incident_assistant(state, payload)
        roles = [m["role"] for m in captured["messages"]]
        assert "user" in roles
        assert captured["messages"][-1]["content"] == "and then?"


class TestWorkspaceSnapshot:
    def test_no_data_loaded_flag(self):
        snap = assistant.build_workspace_snapshot({"clusters": [], "raw_alerts": [], "noise": [], "dedup_stats": {}})
        assert snap["data_loaded"] is False

    def test_data_loaded_true_when_alerts_present(self):
        state = _state_with_one_cluster()
        state["raw_alerts"] = [{"service": "postgres-primary", "status": "firing"}]
        snap = assistant.build_workspace_snapshot(state)
        assert snap["data_loaded"] is True
        assert snap["active_incidents"] == 1

    def test_top_incidents_capped_at_max_context_clusters(self):
        state = {
            "clusters": [
                {"cluster_id": i, "root_cause": {"service": f"svc-{i}", "alertname": "X"},
                 "risk": {"level": "low", "score": 0.1}, "raw_alert_count": 1, "summary": ""}
                for i in range(assistant.MAX_CONTEXT_CLUSTERS + 5)
            ],
            "raw_alerts": [{"service": "svc-0", "status": "firing"}],
            "noise": [],
            "dedup_stats": {},
        }
        snap = assistant.build_workspace_snapshot(state)
        assert len(snap["top_incidents"]) == assistant.MAX_CONTEXT_CLUSTERS


class TestTemplateWorkspaceAnswer:
    def test_no_data_loaded_returns_project_brief(self):
        snap = {"data_loaded": False}
        answer = assistant._template_workspace_answer("what is this?", snap)
        assert assistant.PROJECT_BRIEF in answer

    def test_top_keyword_lists_top_incidents(self):
        snap = {
            "data_loaded": True,
            "top_incidents": [
                {"incident_id": 0, "service": "postgres-primary", "alertname": "X", "risk_level": "high", "risk_score": 0.8, "alert_count": 5},
            ],
        }
        answer = assistant._template_workspace_answer("what's the top risk?", snap)
        assert "postgres-primary" in answer

    def test_noise_keyword_reports_reduction_pct(self):
        snap = {"data_loaded": True, "top_incidents": [], "noise_reduction_pct": 91.5, "noise_alerts": 3, "unique_alert_count": 10}
        answer = assistant._template_workspace_answer("how much noise was removed?", snap)
        assert "91.5" in answer


class TestAskWorkspaceAssistant:
    def test_with_incident_id_delegates_to_incident_path(self):
        state = _state_with_one_cluster()
        payload = assistant.WorkspaceAssistantRequest(incident_id="missing-id", question="explain")
        result = assistant.ask_workspace_assistant(state, payload)
        # delegated to ask_incident_assistant's not-found path
        assert result["status"] == "error"

    def test_without_incident_id_no_providers_uses_workspace_template(self, monkeypatch):
        monkeypatch.setattr(assistant, "_configured_providers", lambda: [])
        state = _state_with_one_cluster()
        state["raw_alerts"] = [{"service": "postgres-primary", "status": "firing"}]
        payload = assistant.WorkspaceAssistantRequest(question="what's going on?")
        result = assistant.ask_workspace_assistant(state, payload)
        assert result["status"] == "ok"
        assert result["mode"] == "workspace"
        assert result["generated"] == "template"

    def test_no_data_loaded_and_no_providers_still_answers(self, monkeypatch):
        """The fallback guarantee: even with zero pipeline data AND no LLM
        key configured, the workspace assistant must still respond (with the
        static project description) rather than erroring out."""
        monkeypatch.setattr(assistant, "_configured_providers", lambda: [])
        empty_state = {"clusters": [], "raw_alerts": [], "noise": [], "dedup_stats": {}}
        payload = assistant.WorkspaceAssistantRequest(question="what is AlertLens?")
        result = assistant.ask_workspace_assistant(empty_state, payload)
        assert result["status"] == "ok"
        assert assistant.PROJECT_BRIEF in result["answer"]

    def test_provider_success_returns_real_answer(self, monkeypatch):
        monkeypatch.setattr(
            assistant, "_configured_providers",
            lambda: [("groq", "k1", "https://fake", "model")],
        )
        monkeypatch.setattr(assistant, "_call_chat_api", lambda *a, **k: "Real workspace answer.")
        state = _state_with_one_cluster()
        payload = assistant.WorkspaceAssistantRequest(question="summarize")
        result = assistant.ask_workspace_assistant(state, payload)
        assert result["answer"] == "Real workspace answer."
        assert result["mode"] == "workspace"
