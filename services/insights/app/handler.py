"""
Event handler = the policy between a JetStream message and the store (PDF §8–10, decisions D-04/D-09).

  parse/validate fails      -> non-retryable: durable failure record, then TERM
  store.apply == applied    -> ACK (the transaction committed before we get here)
  store.apply == duplicate  -> ACK (redelivery after a commit-before-ack crash, or a late broker duplicate)
  any other exception       -> transient: RETRY (NAK with backoff) ...
     ... on the FINAL delivery: failure record 'exhausted' first, then TERM, so nothing vanishes silently
  failure record cannot be written -> never TERM: RETRY, count it, log at error level (operator-visible)
"""

from __future__ import annotations

import json
from typing import Any

from nats.aio.msg import Msg

from app.consumer import Outcome
from app.contracts import ContractValidator
from app.logging import get_logger
from app.projections import DeliveryMeta, FailureRecord, Store
from app.state import ConsumerState

log = get_logger("handler")

NON_RETRYABLE = {"malformed", "unsupported_schema", "unknown_event_type"}


def classify_exception(e: BaseException) -> str:
    """Everything that is not a contract problem is retried: Mongo/NATS/network errors, timeouts, even handler bugs
    (a bug is fixed by a deploy, after which the redelivery succeeds; a TERM would lose the event)."""
    return "transient"


class EventHandler:
    def __init__(self, validator: ContractValidator, store: Store, state: ConsumerState, *, consumer: str, max_deliver: int):
        self.validator, self.store, self.state = validator, store, state
        self.consumer, self.max_deliver = consumer, max_deliver

    async def handle(self, msg: Msg) -> Outcome:
        md = msg.metadata
        headers = msg.headers or {}
        meta = DeliveryMeta(consumer=self.consumer, subject=msg.subject, stream_seq=md.sequence.stream,
                            num_delivered=md.num_delivered, correlation_id=headers.get("x-correlation-id"))
        raw = msg.data
        event: Any = None
        try:
            event = json.loads(raw)
        except (ValueError, UnicodeDecodeError) as e:
            return await self._reject(meta, raw, headers, "malformed", [f"not JSON: {e}"])
        check = self.validator.validate(event)
        if not check.ok:
            return await self._reject(meta, raw, headers, check.classification or "malformed", check.errors, event)

        try:
            result = await self.store.apply(event, meta)
        except Exception as e:  # noqa: BLE001 - classified below, never swallowed
            return await self._transient(meta, raw, headers, event, e)
        if result == "duplicate":
            self.state.duplicates += 1
            log.info("event.duplicate", eventId=event["eventId"], seq=meta.stream_seq, attempt=meta.num_delivered, correlationId=meta.correlation_id)
        else:
            log.info("event.applied", eventId=event["eventId"], eventType=event["eventType"], seq=meta.stream_seq,
                     attempt=meta.num_delivered, correlationId=meta.correlation_id)
        return Outcome.ACK

    async def _reject(self, meta: DeliveryMeta, raw: bytes, headers: dict, classification: str, errors: list[str], event: Any = None) -> Outcome:
        rec = self._failure(meta, raw, headers, classification, errors, event)
        if not await self._persist_failure(rec):
            return Outcome.RETRY
        log.warning("event.rejected", classification=classification, seq=meta.stream_seq, errors=errors[:3], correlationId=meta.correlation_id)
        return Outcome.TERM

    async def _transient(self, meta: DeliveryMeta, raw: bytes, headers: dict, event: Any, e: Exception) -> Outcome:
        err = f"{type(e).__name__}: {e}"
        self.state.last_error = type(e).__name__
        final = meta.num_delivered >= self.max_deliver
        if not final:
            log.warning("event.retry", seq=meta.stream_seq, attempt=meta.num_delivered, error=err, correlationId=meta.correlation_id)
            return Outcome.RETRY
        rec = self._failure(meta, raw, headers, "exhausted", [err], event)
        if not await self._persist_failure(rec):
            return Outcome.RETRY  # the broker stops after max_deliver anyway; the error log + counter are the last trace
        log.error("event.exhausted", seq=meta.stream_seq, attempts=meta.num_delivered, error=err, correlationId=meta.correlation_id)
        return Outcome.TERM

    async def _persist_failure(self, rec: FailureRecord) -> bool:
        try:
            await self.store.record_failure(rec)
            return True
        except Exception as e:  # noqa: BLE001
            self.state.unrecorded_failures += 1
            self.state.last_error = type(e).__name__
            log.error("failure_record.persist_failed", seq=rec.stream_seq, classification=rec.classification,
                      error=f"{type(e).__name__}: {e}", correlationId=rec.correlation_id)
            return False

    def _failure(self, meta: DeliveryMeta, raw: bytes, headers: dict, classification: str, errors: list[str], event: Any) -> FailureRecord:
        event_id = event.get("eventId") if isinstance(event, dict) else None
        return FailureRecord(consumer=meta.consumer, subject=meta.subject, stream_seq=meta.stream_seq, num_delivered=meta.num_delivered,
                             classification=classification, errors=errors, event_id=event_id or headers.get("Nats-Msg-Id"),
                             correlation_id=meta.correlation_id, raw_preview=raw[:2000].decode("utf-8", errors="replace"))
