"""Handler policy without a broker or database: retry classification, failure records, ack-after-commit, duplicates."""

import json
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from pymongo.errors import AutoReconnect

from app.consumer import Outcome
from app.contracts import ContractValidator
from app.handler import EventHandler
from app.projections import FailureRecord, summarize
from app.state import ConsumerState

CONTRACTS = Path(__file__).resolve().parents[3] / "contracts"
validator = ContractValidator(CONTRACTS)
VALID = json.loads((CONTRACTS / "examples" / "valid" / "team.created.json").read_text())


@dataclass
class Seq:
    stream: int


@dataclass
class Meta:
    sequence: Seq
    num_delivered: int


class FakeMsg:
    def __init__(self, data: bytes, seq: int = 1, delivered: int = 1, headers=None, subject="tm.v1.team.created"):
        self.data, self.subject, self.headers = data, subject, headers or {"Nats-Msg-Id": "X", "x-correlation-id": "req_t"}
        self.metadata = Meta(Seq(seq), delivered)


@dataclass
class FakeStore:
    applied: list[str] = field(default_factory=list)
    failures: list[FailureRecord] = field(default_factory=list)
    apply_error: Exception | None = None
    failure_error: Exception | None = None

    async def apply(self, event, meta):
        if self.apply_error:
            raise self.apply_error
        if event["eventId"] in self.applied:
            return "duplicate"
        self.applied.append(event["eventId"])
        return "applied"

    async def record_failure(self, rec):
        if self.failure_error:
            raise self.failure_error
        self.failures.append(rec)


def make(store=None, max_deliver=5):
    store = store or FakeStore()
    state = ConsumerState()
    return EventHandler(validator, store, state, consumer="test", max_deliver=max_deliver), store, state


async def test_valid_event_is_applied_then_acked():
    h, store, state = make()
    assert await h.handle(FakeMsg(json.dumps(VALID).encode())) is Outcome.ACK
    assert store.applied == [VALID["eventId"]] and state.duplicates == 0


async def test_duplicate_delivery_is_acked_without_reapplying():
    h, store, state = make()
    msg = FakeMsg(json.dumps(VALID).encode())
    await h.handle(msg)
    assert await h.handle(FakeMsg(json.dumps(VALID).encode(), delivered=2)) is Outcome.ACK
    assert store.applied == [VALID["eventId"]] and state.duplicates == 1


@pytest.mark.parametrize("raw, classification", [
    (b"\xff{not json", "malformed"),
    (json.dumps({**VALID, "schemaVersion": 2}).encode(), "unsupported_schema"),
    (json.dumps({**VALID, "payload": {"teamId": "t"}}).encode(), "malformed"),
])
async def test_non_retryable_messages_get_a_failure_record_then_term(raw, classification):
    h, store, _ = make()
    assert await h.handle(FakeMsg(raw, seq=42)) is Outcome.TERM
    assert store.applied == []
    [rec] = store.failures
    assert rec.classification == classification and rec.stream_seq == 42 and rec.consumer == "test"
    assert rec.correlation_id == "req_t" and rec.raw_preview


async def test_unknown_schema_version_never_reaches_the_store():
    h, store, _ = make()
    await h.handle(FakeMsg(json.dumps({**VALID, "schemaVersion": 99}).encode()))
    assert store.applied == [] and store.failures[0].classification == "unsupported_schema"


async def test_transient_store_error_is_retried_until_the_final_delivery():
    h, store, state = make(FakeStore(apply_error=AutoReconnect("atlas hiccup")), max_deliver=3)
    data = json.dumps(VALID).encode()
    assert await h.handle(FakeMsg(data, delivered=1)) is Outcome.RETRY
    assert await h.handle(FakeMsg(data, delivered=2)) is Outcome.RETRY
    assert store.failures == []
    assert await h.handle(FakeMsg(data, seq=7, delivered=3)) is Outcome.TERM  # final delivery: exhausted
    [rec] = store.failures
    assert rec.classification == "exhausted" and rec.stream_seq == 7 and rec.num_delivered == 3 and "atlas hiccup" in rec.errors[0]
    assert state.last_error == "AutoReconnect"


async def test_handler_bug_is_treated_as_transient_not_as_poison():
    h, store, _ = make(FakeStore(apply_error=KeyError("oops")))
    assert await h.handle(FakeMsg(json.dumps(VALID).encode())) is Outcome.RETRY
    assert store.failures == []


async def test_failure_record_persistence_failure_never_terms_the_message():
    store = FakeStore(failure_error=AutoReconnect("insights_db down"))
    h, _, state = make(store)
    # non-retryable message, but the quarantine write fails: keep the message (RETRY), count it, so it is not lost silently
    assert await h.handle(FakeMsg(b"garbage")) is Outcome.RETRY
    # exhausted transient on the final attempt with a failing failure store: same rule
    store.apply_error = AutoReconnect("x")
    assert await h.handle(FakeMsg(json.dumps(VALID).encode(), delivered=5)) is Outcome.RETRY
    assert state.unrecorded_failures == 2 and state.last_error == "AutoReconnect"


def test_summaries_cover_every_event_type():
    moved = json.loads((CONTRACTS / "examples" / "valid" / "workitem.moved.json").read_text())
    assert summarize(VALID).startswith("created team")
    assert summarize(moved) == "moved PAY-104 from todo to doing"
