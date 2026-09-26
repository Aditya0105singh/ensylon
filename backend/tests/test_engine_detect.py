"""Unit tests for DETECT — the three source-family treatments in isolation.

Golden-path tests already exercise detect() end-to-end against one scenario;
these pin the mechanisms directly: EWMA warmup and z-scoring, the zero-variance
guard, log template novelty vs. burst vs. plain error severity, and that a
pre-flagged signal (CloudWatch alarm, Grafana rule, span ERROR) is trusted
rather than re-judged.
"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.engine.detect import (  # noqa: E402
    BURST_MIN_COUNT,
    MIN_WARMUP,
    Z_THRESHOLD,
    DetectorState,
    LogTemplateMiner,
    SeriesBaseline,
    _crude_template,
    detect,
)
from app.engine.signal import Severity, Signal, SignalSource  # noqa: E402

T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)


def sig(
    service="svc",
    seconds=0,
    source=SignalSource.APP_LOG,
    severity=Severity.HIGH,
    message="something happened",
    metric=None,
    value=None,
    is_anomaly=False,
    detection_reason="",
    occurrence_count=1,
) -> Signal:
    return Signal(
        id=f"{service}-{source}-{seconds}-{message[:8]}",
        source=source,
        service=service,
        severity=severity,
        timestamp=T0 + timedelta(seconds=seconds),
        message=message,
        metric=metric,
        value=value,
        is_anomaly=is_anomaly,
        detection_reason=detection_reason,
        occurrence_count=occurrence_count,
    )


# --------------------------------------------------------------------------
# SeriesBaseline
# --------------------------------------------------------------------------


class TestSeriesBaseline:
    def test_z_score_is_none_during_warmup(self):
        b = SeriesBaseline()
        for i in range(MIN_WARMUP - 1):
            b.update(100.0)
        assert b.z_score(100.0) is None

    def test_z_score_available_once_warmed_up(self):
        b = SeriesBaseline()
        for _ in range(MIN_WARMUP):
            b.update(100.0)
        # A constant series has zero variance, so this still returns None -
        # the explicit zero-variance guard, tested separately below.
        for _ in range(20):
            b.update(100.0 + (1 if _ % 2 == 0 else -1))  # inject some variance
        z = b.z_score(200.0)
        assert z is not None and z > 0

    def test_zero_variance_series_returns_none_not_infinity(self):
        b = SeriesBaseline()
        for _ in range(MIN_WARMUP + 5):
            b.update(50.0)
        assert b.std == 0.0
        assert b.z_score(999.0) is None  # would be +inf without the guard

    def test_deviation_above_mean_is_positive_below_is_negative(self):
        b = SeriesBaseline()
        for _ in range(20):
            b.update(100.0 + (2 if _ % 2 == 0 else -2))
        assert b.z_score(300.0) > 0
        assert b.z_score(-100.0) < 0

    def test_update_after_scoring_shifts_the_mean(self):
        b = SeriesBaseline()
        for _ in range(10):
            b.update(10.0)
        mean_before = b.mean
        b.update(1000.0)
        assert b.mean > mean_before


# --------------------------------------------------------------------------
# _crude_template (the drain3 fallback, always unit-testable on its own)
# --------------------------------------------------------------------------


class TestCrudeTemplate:
    def test_digits_are_blanked(self):
        assert _crude_template("connection pool 196/200 in use") == "connection pool <*>/<*> in use"

    def test_two_messages_differing_only_by_number_collapse_to_the_same_template(self):
        a = _crude_template("waiters=14")
        b = _crude_template("waiters=91")
        assert a == b

    def test_hex_and_uuid_are_blanked(self):
        assert "<*>" in _crude_template("request id deadbeefcafebabe1234 failed")
        assert "<*>" in _crude_template("id 12345678-1234-1234-1234-123456789012 not found")


# --------------------------------------------------------------------------
# detect(): CloudWatch metrics
# --------------------------------------------------------------------------


class TestDetectMetrics:
    def test_cold_start_series_is_never_flagged(self):
        """No baseline yet -> no evidence -> correctly left unflagged, not guessed at."""
        signals = [sig(source=SignalSource.CLOUDWATCH_METRIC, metric="m", value=100.0, seconds=i) for i in range(3)]
        out, report, _ = detect(signals)
        assert all(not s.is_anomaly for s in out)
        assert report.anomalous == 0

    def test_a_genuine_spike_after_warmup_is_flagged(self):
        warmup = [
            sig(source=SignalSource.CLOUDWATCH_METRIC, metric="m", value=100.0 + (1 if i % 2 else -1), seconds=i)
            for i in range(MIN_WARMUP + 5)
        ]
        spike = sig(source=SignalSource.CLOUDWATCH_METRIC, metric="m", value=10000.0, seconds=MIN_WARMUP + 6)
        out, report, _ = detect(warmup + [spike])
        assert out[-1].is_anomaly is True
        assert "σ from baseline" in out[-1].detection_reason
        assert report.anomalous == 1

    def test_state_carries_the_baseline_across_calls(self):
        """A restart must not forget what 'normal' looks like for this series."""
        warmup = [
            sig(source=SignalSource.CLOUDWATCH_METRIC, metric="m", value=100.0 + (1 if i % 2 else -1), seconds=i)
            for i in range(MIN_WARMUP + 5)
        ]
        _, _, state = detect(warmup)
        spike = sig(source=SignalSource.CLOUDWATCH_METRIC, metric="m", value=10000.0, seconds=999)
        out, _, _ = detect([spike], state)
        assert out[0].is_anomaly is True

    def test_pre_flagged_alarm_is_trusted_and_enriched_not_re_judged(self):
        """A CloudWatch alarm in ALARM state is already a decision; DETECT adds
        baseline context where it has any, it never overrules it."""
        warmup = [
            sig(source=SignalSource.CLOUDWATCH_METRIC, metric="m", value=100.0 + (1 if i % 2 else -1), seconds=i)
            for i in range(MIN_WARMUP + 5)
        ]
        alarm = sig(
            source=SignalSource.CLOUDWATCH_METRIC, metric="m", value=100.0, seconds=999,
            is_anomaly=True, detection_reason="CloudWatch alarm X in ALARM state",
        )
        out, report, _ = detect(warmup + [alarm])
        assert out[-1].is_anomaly is True
        assert out[-1].detection_reason.startswith("CloudWatch alarm")
        assert report.pre_flagged == 1
        assert report.anomalous == report.pre_flagged  # only the alarm, warmup stayed quiet


# --------------------------------------------------------------------------
# detect(): logs
# --------------------------------------------------------------------------


class TestDetectLogs:
    def test_a_brand_new_template_is_flagged_as_novel(self):
        out, report, _ = detect([sig(message="a totally new error we've never seen")])
        assert out[0].is_anomaly is True
        assert "novel" in out[0].detection_reason
        assert report.novel_templates == 1

    def test_info_severity_repeating_is_never_flagged(self):
        """A healthy heartbeat line repeating is just a working system."""
        signals = [sig(severity=Severity.INFO, message="heartbeat ok", seconds=i) for i in range(10)]
        out, report, _ = detect(signals)
        assert all(not s.is_anomaly for s in out)
        assert report.novel_templates == 0

    def test_a_burst_of_a_known_template_is_flagged_once_baseline_exists(self):
        quiet = [sig(message="disk read slow", seconds=i * 100) for i in range(3)]
        _, _, state = detect(quiet)

        burst = [sig(message="disk read slow", seconds=i) for i in range(BURST_MIN_COUNT + 5)]
        out, report, _ = detect(burst, state)
        assert any(s.is_anomaly and "burst" in s.detection_reason for s in out)

    def test_plain_error_severity_is_flagged_even_without_a_burst_or_novelty(self):
        quiet = [sig(message="db timeout", seconds=i * 100) for i in range(3)]
        _, _, state = detect(quiet)
        single = sig(message="db timeout", severity=Severity.CRITICAL, seconds=9999)
        out, _, _ = detect([single], state)
        assert out[0].is_anomaly is True
        assert "error-severity" in out[0].detection_reason

    def test_occurrence_count_weights_the_burst_not_just_signal_count(self):
        """A deduplicated signal standing in for 12 collapsed originals must
        still register as a burst, not a single unremarkable line."""
        quiet = [sig(message="pool exhausted", seconds=i * 100) for i in range(3)]
        _, _, state = detect(quiet)
        collapsed = sig(message="pool exhausted", occurrence_count=12, seconds=9999)
        out, _, _ = detect([collapsed], state)
        assert out[0].is_anomaly is True


# --------------------------------------------------------------------------
# detect(): everything else (traces etc.) falls back to severity
# --------------------------------------------------------------------------


class TestDetectOther:
    def test_non_metric_non_log_source_flags_purely_on_severity(self):
        out, _, _ = detect([
            sig(source=SignalSource.TRACE_SPAN, severity=Severity.HIGH),
            sig(source=SignalSource.TRACE_SPAN, severity=Severity.INFO),
        ])
        assert out[0].is_anomaly is True
        assert out[1].is_anomaly is False


# --------------------------------------------------------------------------
# LogTemplateMiner
# --------------------------------------------------------------------------


class TestLogTemplateMiner:
    def test_empty_message_gets_a_stable_empty_template(self):
        miner = LogTemplateMiner()
        tid, text = miner.add("")
        assert tid == "empty" and text == ""

    def test_repeated_message_accumulates_the_configured_weight(self):
        miner = LogTemplateMiner()
        tid1, _ = miner.add("connection refused", weight=5)
        tid2, _ = miner.add("connection refused", weight=3)
        assert tid1 == tid2
        assert miner.template_counts[tid1] == 8

    def test_backend_reports_which_engine_is_actually_running(self):
        miner = LogTemplateMiner()
        assert miner.backend in ("drain3", "regex-fallback")
