from datetime import datetime, timedelta, timezone

import pytest

from app.dedup import deduplicate, fingerprint


def _ts(offset_seconds=0, base=None):
    base = base or datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    return base + timedelta(seconds=offset_seconds)


class TestFingerprint:
    def test_same_service_alertname_close_time_same_fingerprint(self, alert_factory):
        a = alert_factory(service="svc", alertname="Foo", ts=_ts(0))
        b = alert_factory(service="svc", alertname="Foo", ts=_ts(60))
        assert fingerprint(a) == fingerprint(b)

    def test_different_service_different_fingerprint(self, alert_factory):
        a = alert_factory(service="svc-a", alertname="Foo", ts=_ts(0))
        b = alert_factory(service="svc-b", alertname="Foo", ts=_ts(0))
        assert fingerprint(a) != fingerprint(b)

    def test_different_alertname_different_fingerprint(self, alert_factory):
        a = alert_factory(service="svc", alertname="Foo", ts=_ts(0))
        b = alert_factory(service="svc", alertname="Bar", ts=_ts(0))
        assert fingerprint(a) != fingerprint(b)

    def test_alerts_outside_window_get_different_fingerprint(self, alert_factory):
        a = alert_factory(service="svc", alertname="Foo", ts=_ts(0))
        b = alert_factory(service="svc", alertname="Foo", ts=_ts(600))  # 10 min later
        assert fingerprint(a) != fingerprint(b)


class TestDeduplicate:
    def test_empty_input(self):
        unique, stats = deduplicate([])
        assert unique == []
        assert stats["raw_count"] == 0
        assert stats["unique_count"] == 0
        assert stats["reduction_pct"] == 0.0

    def test_single_alert_passes_through(self, alert_factory):
        alerts = [alert_factory()]
        unique, stats = deduplicate(alerts)
        assert len(unique) == 1
        assert unique[0]["duplicate_count"] == 1
        assert stats["raw_count"] == 1
        assert stats["unique_count"] == 1

    def test_collapses_true_duplicates(self, alert_factory):
        alerts = [
            alert_factory(service="svc", alertname="Foo", ts=_ts(0)),
            alert_factory(service="svc", alertname="Foo", ts=_ts(30)),
            alert_factory(service="svc", alertname="Foo", ts=_ts(60)),
        ]
        unique, stats = deduplicate(alerts)
        assert len(unique) == 1
        assert unique[0]["duplicate_count"] == 3
        assert stats["raw_count"] == 3
        assert stats["unique_count"] == 1
        assert stats["reduction_pct"] == pytest.approx(66.7, rel=1e-2)

    def test_keeps_earliest_of_duplicate_group(self, alert_factory):
        first = alert_factory(service="svc", alertname="Foo", ts=_ts(0), id="first")
        second = alert_factory(service="svc", alertname="Foo", ts=_ts(30), id="second")
        unique, _ = deduplicate([second, first])  # fed out of order
        assert unique[0]["id"] == "first"

    def test_distinct_alerts_all_kept(self, alert_factory):
        alerts = [
            alert_factory(service="a", alertname="X", ts=_ts(0)),
            alert_factory(service="b", alertname="Y", ts=_ts(0)),
            alert_factory(service="c", alertname="Z", ts=_ts(0)),
        ]
        unique, stats = deduplicate(alerts)
        assert len(unique) == 3
        assert stats["reduction_pct"] == 0.0

    def test_result_sorted_by_timestamp(self, alert_factory):
        alerts = [
            alert_factory(service="a", alertname="X", ts=_ts(120)),
            alert_factory(service="b", alertname="Y", ts=_ts(0)),
            alert_factory(service="c", alertname="Z", ts=_ts(60)),
        ]
        unique, _ = deduplicate(alerts)
        timestamps = [u["timestamp"] for u in unique]
        assert timestamps == sorted(timestamps)

    def test_custom_window_seconds_respected(self, alert_factory):
        a = alert_factory(service="svc", alertname="Foo", ts=_ts(0))
        b = alert_factory(service="svc", alertname="Foo", ts=_ts(50))
        # default 300s window collapses these; a tight 10s window must not
        unique, _ = deduplicate([a, b], window_seconds=10)
        assert len(unique) == 2

    def test_groups_stat_reflects_fingerprint_sizes(self, alert_factory):
        alerts = [
            alert_factory(service="svc", alertname="Foo", ts=_ts(0)),
            alert_factory(service="svc", alertname="Foo", ts=_ts(30)),
        ]
        _, stats = deduplicate(alerts)
        assert len(stats["groups"]) == 1
        assert list(stats["groups"].values()) == [2]
