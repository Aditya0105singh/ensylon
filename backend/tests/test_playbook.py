"""Playbook tests.

Written against the original playbook and rewritten for the honest one
(app/playbook.py): the step list is derived from the incident's own alert text
instead of a fixed web-service template, so it has a variable length; the time
estimate and confidence exist only when a matched past incident supplies them;
and "business_impact" (which carried an invented revenue figure) is now
"impact", carrying only counts and service names taken from the alerts.

Each test keeps the intent of the version it replaces. Classification itself,
and the absence of the fabricated content, are covered in
test_alertlens_incidents.py and deliberately not repeated here.
"""

from app.playbook import generate_playbook

# The keys every playbook carries, empty incident or not — consumers
# (incident_ticket.py, the AlertLens UI) index these directly.
PLAYBOOK_KEYS = {
    "title", "priority", "failure_family", "estimated_resolution",
    "resolution_basis", "confidence", "steps", "validation", "rollback", "impact",
}


class TestGeneratePlaybook:
    def test_falsy_cluster_returns_generic_playbook(self):
        result = generate_playbook({})
        assert result["title"] == "No incident"
        assert result["steps"] == []
        # Same shape as a real playbook, so consumers never KeyError on the
        # placeholder, and nothing is asserted about an incident that isn't there.
        assert set(result.keys()) == PLAYBOOK_KEYS
        assert result["failure_family"] is None
        assert result["estimated_resolution"] is None
        assert result["confidence"] is None
        assert result["validation"] == [] and result["rollback"] == []
        assert result["priority"] in {"Critical P1", "High P2"}  # incident_ticket.py parses this

    def test_none_cluster_does_not_crash(self):
        result = generate_playbook(None)
        assert result["steps"] == []

    def test_result_shape(self, cluster_factory):
        result = generate_playbook(cluster_factory())
        assert set(result.keys()) == PLAYBOOK_KEYS
        assert result["failure_family"] is None or isinstance(result["failure_family"], str)
        assert result["estimated_resolution"] is None or isinstance(result["estimated_resolution"], str)
        assert isinstance(result["resolution_basis"], str) and result["resolution_basis"]
        assert all(isinstance(v, str) for v in result["validation"] + result["rollback"])
        # The UI reads exactly these three fields off every step.
        for step in result["steps"]:
            assert {"step_number", "title", "description"} <= set(step)
        assert set(result["impact"]) == {"services_affected", "signals", "raw_alerts"}

    def test_core_steps_always_present_and_numbered(self, cluster_factory, dna_match_factory):
        """Was test_four_steps_always_present: the step count is no longer fixed
        (it follows the failure family and whether a past fix is known), so the
        invariant is the skeleton — confirm the root cause, investigate, confirm
        recovery — contiguously numbered from 1."""
        clusters = [
            cluster_factory(),                                        # classified
            cluster_factory(root_alertname="BackupCompleted"),        # unclassified
            cluster_factory(n_alerts=1, n_services=1),                # single service
            cluster_factory(dna_match=dna_match_factory()),           # with a past fix
        ]
        for cluster in clusters:
            steps = generate_playbook(cluster)["steps"]
            assert len(steps) >= 3, "root-cause step, at least one check, recovery check"
            assert [s["step_number"] for s in steps] == list(range(1, len(steps) + 1))
            assert steps[0]["title"] == f"Confirm the root cause on {cluster['root_cause']['service']}"
            assert steps[-1]["title"] == "Confirm the alerts stop"
            assert all(s["title"] and s["description"] for s in steps)

    def test_high_risk_or_critical_gets_p1_priority(self, cluster_factory):
        result = generate_playbook(cluster_factory(risk_level="high", root_severity="critical"))
        assert result["priority"] == "Critical P1"

    def test_low_risk_non_critical_gets_p2_priority(self, cluster_factory):
        result = generate_playbook(cluster_factory(risk_level="low", root_severity="info"))
        assert result["priority"] == "High P2"

    def test_dna_match_supplies_real_resolution_step(self, cluster_factory, dna_match_factory):
        dna = dna_match_factory(resolution="Restarted the connection pool")
        result = generate_playbook(cluster_factory(dna_match=dna))
        steps = result["steps"]
        # The recovery step is no longer at a fixed index (the checks before it
        # depend on the failure family), so find it by the fix it carries.
        matching = [s for s in steps if "Restarted the connection pool" in s["description"]]
        assert len(matching) == 1
        recovery_step = matching[0]
        assert dna["incident_id"] in recovery_step["title"]
        # Applied after the root cause is confirmed and before recovery is checked.
        assert 0 < steps.index(recovery_step) < len(steps) - 1

    def test_dna_match_without_a_recorded_fix_invents_none(self, cluster_factory, dna_match_factory):
        """The old playbook filled the recovery step with a made-up action
        ("restart the worker pool and flush stale connection queues") whenever
        history had none. Now there is simply no such step."""
        result = generate_playbook(cluster_factory(dna_match=dna_match_factory(resolution=None)))
        assert not any("Apply the fix" in s["title"] for s in result["steps"])

    def test_dna_resolution_minutes_drive_estimated_resolution(self, cluster_factory, dna_match_factory):
        cluster = cluster_factory(dna_match=dna_match_factory(resolution_minutes=20))
        assert cluster["est_triage_minutes_saved"], "fixture still carries the quantity that must not leak"
        result = generate_playbook(cluster)
        assert result["estimated_resolution"] == "~20 minutes"
        assert cluster["dna_match"]["incident_id"] in result["resolution_basis"]

    def test_estimate_is_not_derived_from_triage_minutes_saved(self, cluster_factory):
        """est_triage_minutes_saved is triage time *saved*, not time to resolve;
        the old playbook reused it as the estimate when no past incident matched."""
        cluster = cluster_factory(dna_match=None)
        cluster["est_triage_minutes_saved"] = 12
        result = generate_playbook(cluster)
        assert result["estimated_resolution"] is None
        assert "12" not in result["resolution_basis"]

    def test_no_dna_match_falls_back_to_generic_resolution(self, cluster_factory):
        """Without a past incident there is no recorded fix to apply, so the
        playbook must still give family guidance about the root service and
        must not invent an "Apply the fix that resolved ..." step. (Was
        `steps[2]`, which only passed because that index happened to be a
        family step; the step list is variable-length now.)"""
        result = generate_playbook(cluster_factory(dna_match=None, root_service="worker-node-3"))
        text = " ".join(f"{s['title']} {s['description']}" for s in result["steps"])
        assert "worker-node-3" in text
        assert not any(s["title"].startswith("Apply the fix that resolved") for s in result["steps"])
        assert result["estimated_resolution"] is None

    def test_match_without_resolution_minutes_is_not_reported_as_no_match(self, cluster_factory):
        """The basis used to say "no similar past incident" even when one did
        match but recorded no resolution time, which is false."""
        dna = {"incident_id": "INC-0412", "similarity_pct": 64.0, "resolution": "Restarted the pool"}
        result = generate_playbook(cluster_factory(dna_match=dna))
        assert result["estimated_resolution"] is None
        assert "INC-0412" in result["resolution_basis"]
        assert "no similar past incident" not in result["resolution_basis"]

    def test_long_service_list_says_how_many_were_left_out(self, cluster_factory):
        """A list cut at four services must say so, never read as complete."""
        result = generate_playbook(cluster_factory(n_services=7, n_alerts=7))
        closing = result["steps"][-1]["description"]
        assert "and 3 more" in closing
        assert "across 7 service(s)" in closing
        assert "and 3 more" in " ".join(result["validation"])

    def test_impact_lists_all_affected_services(self, cluster_factory):
        """Was test_business_impact_lists_all_affected_services. The invented
        "$14,000 per affected service revenue risk" is gone; what remains, and
        is worth pinning, is that every service the alerts name is listed."""
        cluster = cluster_factory(n_services=3, n_alerts=3)
        result = generate_playbook(cluster)
        affected = {a["service"] for a in cluster["alerts"]}
        services = result["impact"]["services_affected"]
        assert set(services) == affected
        assert len(services) == len(affected), "no duplicates"
        assert services[0] == cluster["root_cause"]["service"], "root service first"
        assert result["impact"]["signals"] == cluster["size"]
        assert result["impact"]["raw_alerts"] == cluster["raw_alert_count"]

    def test_confidence_uses_dna_similarity_when_present(self, cluster_factory, dna_match_factory):
        dna = dna_match_factory(similarity_pct=93.0)
        result = generate_playbook(cluster_factory(dna_match=dna))
        assert result["confidence"] == 93

    def test_single_service_cluster_downstream_falls_back_to_root(self, cluster_factory):
        cluster = cluster_factory(n_services=1, n_alerts=1)
        result = generate_playbook(cluster)
        root_svc = cluster["root_cause"]["service"]
        # No downstream services beyond the root — the closing verification step
        # must still say where to watch, without an empty join or a dangling count.
        closing = result["steps"][-1]
        assert closing["title"] == "Confirm the alerts stop"
        assert root_svc in closing["description"]
        assert "0 service" not in closing["description"]
        assert "other service(s)" not in result["steps"][0]["description"]
        assert root_svc in result["validation"][1]

    def test_cluster_with_no_alerts_still_names_the_root_service(self, cluster_factory):
        """Nothing to derive a service list from: the verification step names the
        root service rather than claiming "across 0 service(s)"."""
        cluster = cluster_factory()
        cluster["alerts"] = []
        result = generate_playbook(cluster)
        closing = result["steps"][-1]
        assert cluster["root_cause"]["service"] in closing["description"]
        assert "0 service" not in closing["description"]
