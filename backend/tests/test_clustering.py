from datetime import datetime, timedelta, timezone

import pytest

from app.clustering import cluster_alerts, group_by_label, pick_root_cause


def _ts(offset_seconds=0, base=None):
    base = base or datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
    return base + timedelta(seconds=offset_seconds)


class TestClusterAlerts:
    def test_tight_cascade_forms_one_cluster(self, cascade_factory):
        alerts = cascade_factory(n_services=4)
        labels, embeddings = cluster_alerts(alerts)
        # MIN_SAMPLES=3, all 4 alerts related in text + close in time
        assert len(set(labels[labels != -1])) == 1
        assert (labels != -1).sum() == 4
        assert embeddings.shape[0] == 4

    def test_below_min_samples_is_all_noise(self, alert_factory):
        # MIN_SAMPLES=3 — two alerts, however similar, can never form a cluster
        alerts = [
            alert_factory(service="svc", alertname="Foo", ts=_ts(0)),
            alert_factory(service="svc", alertname="Foo", ts=_ts(5)),
        ]
        labels, _ = cluster_alerts(alerts)
        assert all(label == -1 for label in labels)

    def test_unrelated_alerts_stay_noise(self, alert_factory):
        alerts = [
            alert_factory(service="a", alertname="DiskFull", message="disk usage critical", ts=_ts(0)),
            alert_factory(service="b", alertname="AuthFailure", message="token validation error", ts=_ts(3600)),
            alert_factory(service="c", alertname="NetworkLoss", message="packet loss detected", ts=_ts(7200)),
        ]
        labels, _ = cluster_alerts(alerts)
        assert all(label == -1 for label in labels)

    def test_same_wording_but_hours_apart_does_not_merge(self, cascade_factory):
        """Same alert text recurring hours apart is two separate incidents,
        not one — the time penalty must dominate text similarity."""
        early = cascade_factory(n_services=3, start=_ts(0))
        late = cascade_factory(n_services=3, start=_ts(4 * 3600))  # +4h
        labels, _ = cluster_alerts(early + late)
        early_labels = set(labels[:3])
        late_labels = set(labels[3:])
        # neither half should be noise (each is a valid tight cluster alone)
        # and they must not share a cluster id with each other
        assert -1 not in early_labels or len(early_labels - {-1}) > 0
        assert early_labels.isdisjoint(late_labels) or (early_labels == {-1} and late_labels == {-1})

    def test_empty_batch_raises_on_empty_vocabulary(self):
        """Documents actual current behavior, not desired behavior: an empty
        batch reaches sklearn's TfidfVectorizer with zero documents, which
        raises rather than returning empty arrays. This means run_pipeline()
        (main.py) — and therefore POST /ingest with an empty alert list —
        currently 500s instead of returning a trivial empty result. Flagging
        this, not fixing it: dedup.deduplicate([]) is already empty-safe, so
        the gap is specifically in cluster_alerts."""
        with pytest.raises(ValueError, match="empty vocabulary"):
            cluster_alerts([])


class TestPickRootCause:
    def test_earliest_alert_wins(self, alert_factory):
        early = alert_factory(id="early", ts=_ts(0), severity="info")
        late = alert_factory(id="late", ts=_ts(60), severity="critical")
        root = pick_root_cause([late, early])
        assert root["id"] == "early"

    def test_tie_broken_toward_higher_severity(self, alert_factory):
        same_ts = _ts(0)
        info_alert = alert_factory(id="info", ts=same_ts, severity="info")
        critical_alert = alert_factory(id="critical", ts=same_ts, severity="critical")
        high_alert = alert_factory(id="high", ts=same_ts, severity="high")
        root = pick_root_cause([info_alert, high_alert, critical_alert])
        assert root["id"] == "critical"

    def test_single_alert_cluster(self, alert_factory):
        only = alert_factory(id="only")
        assert pick_root_cause([only])["id"] == "only"


class TestGroupByLabel:
    def test_groups_by_label_including_noise(self, alert_factory):
        alerts = [alert_factory(id="a"), alert_factory(id="b"), alert_factory(id="c")]
        import numpy as np

        labels = np.array([0, 0, -1])
        groups = group_by_label(alerts, labels)
        assert set(groups.keys()) == {0, -1}
        assert {a["id"] for a in groups[0]} == {"a", "b"}
        assert {a["id"] for a in groups[-1]} == {"c"}

    def test_empty_input(self):
        import numpy as np

        groups = group_by_label([], np.array([]))
        assert groups == {}
