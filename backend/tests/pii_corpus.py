"""A corpus of PII in the shapes logs, alarms and alerts actually carry it.

Each case is (text, secrets, keep):
  secrets - substrings that must NOT survive redaction
  keep    - substrings that must survive (service names, hosts, numbers): the
            other half of the job is not destroying the evidence.

The brief's classes: email, IP, session id, account id, personal name, service
account. Cloud account ids, phones and secrets are added because the sample
payloads carry them. Cases marked KNOWN_GAPS are real misses, listed so they are
visible and asserted to stay failing until fixed (strict xfail).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Case:
    id: str
    text: str
    secrets: tuple[str, ...]
    keep: tuple[str, ...] = ()
    note: str = ""


def C(id, text, secrets, keep=(), note=""):
    return Case(id, text, tuple(secrets), tuple(keep), note)


CASES: list[Case] = [
    # ---- email ---------------------------------------------------------------
    C("email-plain", "Refund sent to neha.joshi@acmecorp.com today", ["neha.joshi@acmecorp.com", "acmecorp.com"]),
    C("email-plus-tag", "notify priya+billing@example.co.in now", ["priya+billing@example.co.in"]),
    C("email-upper", "Contact: RAHUL.VERMA@ACMECORP.COM", ["RAHUL.VERMA@ACMECORP.COM"]),
    C("email-subdomain", "sent to a.b@mail.eu-west-1.acme.internal ok", ["a.b@mail.eu-west-1.acme.internal"]),
    C("email-url-query", "GET /unsubscribe?email=asha.rao@acmecorp.com&list=3", ["asha.rao@acmecorp.com"], ["/unsubscribe"]),
    C("email-json", '{"email":"vikram.singh@acmecorp.com","plan":"gold"}', ["vikram.singh@acmecorp.com"], ['"plan":"gold"']),
    C("email-angle", "From: Ops <ops.desk@acmecorp.com> to team", ["ops.desk@acmecorp.com"]),
    C("email-mailto", "click mailto:kiran.p@acmecorp.com to reply", ["kiran.p@acmecorp.com"]),
    C("email-trailing-dot", "Email to sana.m@acmecorp.com. Retry scheduled", ["sana.m@acmecorp.com"], ["Retry scheduled"]),
    C("email-quoted", "user='dev.k@acmecorp.com' failed", ["dev.k@acmecorp.com"]),
    # ---- service accounts ----------------------------------------------------
    C("svc-dash", "affects svc-payments@internal.corp.com", ["svc-payments@internal.corp.com", "internal.corp.com"]),
    C("svc-underscore", "run as svc_batch@internal.corp.com", ["svc_batch@internal.corp.com"]),
    C("svc-dot", "token for svc.reports@ops.acme.internal", ["svc.reports@ops.acme.internal"]),
    # ---- IPv4 ----------------------------------------------------------------
    C("ip-private", "client 10.0.2.83 refused", ["10.0.2.83"], ["refused"]),
    C("ip-192", "from 192.168.1.5 to db", ["192.168.1.5"]),
    C("ip-public", "peer 203.0.113.9 reset", ["203.0.113.9"]),
    C("ip-port", "connect 10.0.2.83:8443 timed out", ["10.0.2.83"], ["8443"]),
    C("ip-kv", "ip:172.16.4.200 host:enrollment-prod-02", ["172.16.4.200"], ["enrollment-prod-02"]),
    C("ip-cidr", "allow 10.20.0.0/16 and 10.20.1.7", ["10.20.1.7"]),
    C("ip-in-url", "http://10.1.1.9:9200/_bulk failed", ["10.1.1.9"]),
    # ---- IPv6 ----------------------------------------------------------------
    C("ipv6-full", "peer 2001:0db8:85a3:0000:0000:8a2e:0370:7334 closed", ["2001:0db8:85a3:0000:0000:8a2e:0370:7334"]),
    C("ipv6-compressed", "peer 2001:db8::8a2e:370:7334 closed", ["2001:db8::8a2e:370:7334"], note="compressed IPv6"),
    C("ipv6-loopback-ish", "client fe80::1ff:fe23:4567:890a dropped", ["fe80::1ff:fe23:4567:890a"], note="link-local, compressed"),
    # ---- session / secrets ---------------------------------------------------
    C("sess-token", "session sess_kd3dxt expired", ["sess_kd3dxt"], ["expired"]),
    C("sess-kv", "session:a1B2c3D4e5 invalid", ["a1B2c3D4e5"]),
    C("sess-eq", "session=9f8e7d6c5b4a expired", ["9f8e7d6c5b4a"]),
    C("sess-id", "sessionId: 7c1d2e3f4a5b6c7d ended", ["7c1d2e3f4a5b6c7d"]),
    C("jwt", "auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk failed",
      ["eyJhbGciOiJIUzI1NiJ9"]),
    C("bearer", "Authorization: Bearer abcdEFGH1234567890xyz rejected", ["abcdEFGH1234567890xyz"]),
    C("aws-key", "key AKIAIOSFODNN7EXAMPLE leaked", ["AKIAIOSFODNN7EXAMPLE"]),
    C("api-key-kv", "api_key=sk_live_51H8abcdEFGH used", ["sk_live_51H8abcdEFGH"]),
    C("password-kv", "password: Hunter2!secret rotated", ["Hunter2!secret"]),
    # ---- account ids ---------------------------------------------------------
    C("acc-token", "acc ACC-10000055 blocked", ["ACC-10000055"]),
    C("acc-kv", "acc:ACC-10000181 credited", ["ACC-10000181"]),
    C("acc-kv-plain", "account: 4599120037 closed", ["4599120037"]),
    C("acc-id-kv", "accountId=88120044 not found", ["88120044"]),
    C("acc-lower", "Member acc: acc-20000345 delayed", ["acc-20000345"], note="lower-case ACC prefix"),
    C("acc-word-space", "refund for account 4599120037 failed", ["4599120037"], ["refund", "failed"]),
    C("acc-no", "acc no. 88120044 not found", ["88120044"]),
    C("acc-small-number-kept", "account 42 requests throttled", [], ["account 42 requests"]),
    C("aws-12", "accountId 456789012345 denied", ["456789012345"]),
    C("aws-arn", "assume arn:aws:iam::456789012345:role/payments-svc failed", ["456789012345"], ["payments-svc"]),
    # ---- phones --------------------------------------------------------------
    C("phone-in-spaced", "call +91 98765 43210 now", ["98765 43210", "98765"]),
    C("phone-in-dash", "call +91-9876543210 now", ["9876543210"]),
    C("phone-in-plain", "SMS to 9876543210 failed", ["9876543210"]),
    C("phone-us-paren", "reach (555) 123-4567 today", ["123-4567"]),
    C("phone-us-dash", "reach 555-123-4567 today", ["123-4567"]),
    C("phone-uk-national", "sms to 07911 123456 failed", ["07911 123456", "7911 123456"]),
    C("phone-uk-national-bare", "sms to 7911 123456 failed", ["7911 123456"]),
    C("phone-intl-uk", "call +44 7911 123456 now", ["7911 123456"], note="UK mobile"),
    # ---- cards / ids ---------------------------------------------------------
    C("card-luhn", "card 4111 1111 1111 1111 declined", ["4111 1111 1111 1111", "4111"]),
    C("ssn", "ssn 123-45-6789 on file", ["123-45-6789"]),
    # ---- names: cued ---------------------------------------------------------
    C("name-customer", "customer Priya Sharma called", ["Priya Sharma", "Priya"], ["called"]),
    C("name-user-colon", "user: Neha Joshi locked out", ["Neha Joshi"]),
    C("name-member", "Member Rahul Verma delayed", ["Rahul Verma"]),
    C("name-title", "Mr. Anil Kumar requested", ["Anil Kumar"]),
    C("name-dr", "Dr Meera Nair reviewed", ["Meera Nair"]),
    C("name-three-part", "insured Arjun Kumar Reddy notified", ["Arjun Kumar Reddy"]),
    # ---- names: learned from an email in the same text ----------------------
    C("name-learned", "Email to neha.joshi@acmecorp.com failed. Neha Joshi asked to retry", ["Neha Joshi", "neha.joshi@acmecorp.com"]),
    C("name-learned-underscore", "mail asha_rao@acmecorp.com; Asha Rao is affected", ["Asha Rao"]),
    # ---- names: no cue, no email (real misses) ------------------------------
    C("name-for-uncued", "Premium collection failed for Priya Nair - no DB connection", ["Priya Nair"], ["Premium collection failed"],
      note="'for <Name>' with no cue word and no earlier email"),
    C("name-sms-uncued", "SMS fallback for Rohan Mehta to 9876543210 failed", ["Rohan Mehta"], note="no cue"),
    C("name-after-capitalised-word", "Call Rohan Mehta on 9876543210 about the refund", ["Rohan Mehta"], ["Call", "refund"],
      note="the pair 'Call Rohan' must not swallow 'Rohan Mehta'"),
    C("name-two-in-a-row", "Priya Sharma and Anil Kumar were notified", ["Priya Sharma", "Anil Kumar"], ["notified"]),
    C("name-apostrophe", "customer Sean O'Brien called", ["O'Brien"], note="apostrophe surname"),
    C("name-uppercase", "customer PRIYA SHARMA called", ["PRIYA SHARMA"], note="upper-case name"),
    C("name-inverted", "insured: Sharma, Priya called", ["Sharma, Priya"], note="surname first"),
    # ---- must survive (evidence, not PII) -----------------------------------
    C("keep-services", "Circuit breaker OPEN for payments-service after 27 consecutive failures", [],
      ["payments-service", "Circuit breaker OPEN", "27 consecutive failures"]),
    C("keep-hosts", "host:enrollment-prod-02 smtp.relay.internal:587 refused", [], ["enrollment-prod-02", "smtp.relay.internal", "587"]),
    C("keep-metrics", "P99 4785ms above the 4000ms threshold; pool 100/100; waiting threads: 22", [],
      ["4785ms", "4000ms", "100/100", "waiting threads: 22"]),
    C("keep-ids", "deploy cfg-0926-1 job rules_rescore_nightly template#118 retry 3/3", [],
      ["cfg-0926-1", "rules_rescore_nightly", "template#118", "3/3"]),
    C("keep-float", "DBConnectionCount = 91.3 (threshold 90) 5xx rate 30.4%", [], ["91.3", "30.4%"]),
    C("keep-time", "2026-09-26T10:01:05Z ERROR payments-service db-connection-pool", [],
      ["2026-09-26T10:01:05Z", "payments-service", "db-connection-pool"]),
    C("keep-title-case-phrases", "Circuit Breaker Open and Connection Pool Exhausted in Payment Service", [],
      ["Circuit Breaker Open", "Connection Pool Exhausted"]),
    C("keep-version", "agent v2.14.3 build 20260926 started", [], ["v2.14.3", "20260926"]),
]

# Cases the current redactor does not handle. Kept as strict xfails: fixing one
# makes its test pass and the xfail then fails loudly, so the list stays honest.
KNOWN_GAPS: dict[str, str] = {
    # filled in by test_pii_redaction.py from what actually fails - see GAP_REASONS there
}
