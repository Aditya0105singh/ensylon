from datetime import datetime, timedelta, timezone


class TestAlertsPersistence:
    def test_save_and_load_round_trip(self, isolated_db, alert_factory):
        db = isolated_db
        alerts = [alert_factory(id="a1"), alert_factory(id="a2")]
        db.save_alerts(alerts)
        loaded = db.load_alerts()
        assert {a["id"] for a in loaded} == {"a1", "a2"}

    def test_save_empty_list_is_noop(self, isolated_db):
        db = isolated_db
        db.save_alerts([])
        assert db.load_alerts() == []

    def test_save_upserts_existing_id(self, isolated_db, alert_factory):
        db = isolated_db
        db.save_alerts([alert_factory(id="a1", severity="info")])
        db.save_alerts([alert_factory(id="a1", severity="critical")])
        loaded = db.load_alerts()
        assert len(loaded) == 1
        assert loaded[0]["severity"] == "critical"

    def test_clear_alerts_empties_table(self, isolated_db, alert_factory):
        db = isolated_db
        db.save_alerts([alert_factory(id="a1")])
        db.clear_alerts()
        assert db.load_alerts() == []

    def test_clear_alerts_preserves_actions(self, isolated_db, alert_factory):
        """Documented contract in db.py: clear_alerts() must NOT wipe
        alert_actions, so a restart replaying the same persisted batch keeps
        user actions (ack/assign/etc) intact."""
        db = isolated_db
        db.save_alerts([alert_factory(id="a1")])
        db.set_ack("a1", True)
        db.clear_alerts()
        assert db.get_actions()["a1"]["acked"] is True

    def test_load_alerts_sorted_newest_first(self, isolated_db, alert_factory):
        db = isolated_db
        base = datetime(2026, 1, 1, tzinfo=timezone.utc)
        db.save_alerts([
            alert_factory(id="old", ts=base),
            alert_factory(id="new", ts=base + timedelta(hours=1)),
        ])
        loaded = db.load_alerts()
        assert [a["id"] for a in loaded] == ["new", "old"]


class TestAlertActions:
    def test_get_actions_empty_by_default(self, isolated_db):
        assert isolated_db.get_actions() == {}

    def test_set_ack_creates_action_row(self, isolated_db):
        db = isolated_db
        db.set_ack("a1", True)
        actions = db.get_actions()
        assert actions["a1"]["acked"] is True
        assert actions["a1"]["assignee"] is None

    def test_set_assignee_and_ack_are_independent_fields_on_same_row(self, isolated_db):
        db = isolated_db
        db.set_ack("a1", True)
        db.set_assignee("a1", "Aditya")
        action = db.get_actions()["a1"]
        assert action["acked"] is True
        assert action["assignee"] == "Aditya"

    def test_set_status_override_and_clear(self, isolated_db):
        db = isolated_db
        db.set_status_override("a1", "suppressed")
        assert db.get_actions()["a1"]["status_override"] == "suppressed"
        db.set_status_override("a1", None)
        assert db.get_actions()["a1"]["status_override"] is None

    def test_set_escalated(self, isolated_db):
        db = isolated_db
        db.set_escalated("a1", True)
        assert db.get_actions()["a1"]["escalated"] is True


class TestMaintenanceWindows:
    def test_create_and_list(self, isolated_db):
        db = isolated_db
        now = datetime.utcnow()
        window = db.create_maintenance_window(
            "w1", "DB maintenance", "postgres-primary",
            now - timedelta(minutes=5), now + timedelta(minutes=30),
        )
        assert window["id"] == "w1"
        assert len(db.list_maintenance_windows()) == 1

    def test_active_window_flag_true_when_within_range(self, isolated_db):
        db = isolated_db
        now = datetime.utcnow()
        db.create_maintenance_window(
            "w1", "Active", None, now - timedelta(minutes=5), now + timedelta(minutes=30),
        )
        windows = db.list_maintenance_windows()
        assert windows[0]["active"] is True

    def test_active_flag_false_when_in_future(self, isolated_db):
        db = isolated_db
        now = datetime.utcnow()
        db.create_maintenance_window(
            "w1", "Future", None, now + timedelta(hours=1), now + timedelta(hours=2),
        )
        windows = db.list_maintenance_windows()
        assert windows[0]["active"] is False

    def test_active_flag_false_when_in_past(self, isolated_db):
        db = isolated_db
        now = datetime.utcnow()
        db.create_maintenance_window(
            "w1", "Past", None, now - timedelta(hours=2), now - timedelta(hours=1),
        )
        windows = db.list_maintenance_windows()
        assert windows[0]["active"] is False

    def test_active_flag_false_when_disabled_even_if_in_range(self, isolated_db):
        db = isolated_db
        now = datetime.utcnow()
        db.create_maintenance_window(
            "w1", "Disabled", None, now - timedelta(minutes=5), now + timedelta(minutes=30),
            enabled=False,
        )
        windows = db.list_maintenance_windows()
        assert windows[0]["active"] is False

    def test_list_active_maintenance_windows_filters_correctly(self, isolated_db):
        db = isolated_db
        now = datetime.utcnow()
        db.create_maintenance_window("active", "A", None, now - timedelta(minutes=5), now + timedelta(minutes=5))
        db.create_maintenance_window("future", "F", None, now + timedelta(hours=1), now + timedelta(hours=2))
        db.create_maintenance_window("past", "P", None, now - timedelta(hours=2), now - timedelta(hours=1))
        active = db.list_active_maintenance_windows()
        assert [w["id"] for w in active] == ["active"]

    def test_set_enabled_and_delete(self, isolated_db):
        db = isolated_db
        now = datetime.utcnow()
        db.create_maintenance_window("w1", "A", None, now, now + timedelta(hours=1))
        updated = db.set_maintenance_window_enabled("w1", False)
        assert updated["enabled"] is False
        db.delete_maintenance_window("w1")
        assert db.list_maintenance_windows() == []

    def test_set_enabled_missing_window_returns_none(self, isolated_db):
        assert isolated_db.set_maintenance_window_enabled("nonexistent", True) is None
