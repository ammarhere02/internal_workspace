"""
Durable pull-consumer loop. The handler decides the outcome per message; this loop only
translates the outcome into the right JetStream acknowledgement:
  ACK   -> processed (or already processed / terminally recorded) -> msg.ack()
  RETRY -> transient failure -> msg.nak(delay) so the broker redelivers with backoff
  TERM  -> non-retryable and a failure record is persisted -> msg.term() (no more redelivery)
Handlers must only return ACK after their database commit succeeded (PDF §8: ack after commit).
"""

import asyncio
import time
from collections.abc import Awaitable, Callable
from enum import Enum

from nats.aio.msg import Msg
from nats.errors import TimeoutError as NatsTimeout
from nats.js.client import JetStreamContext

from app.logging import get_logger
from app.state import ConsumerState

log = get_logger("consumer")


class Outcome(Enum):
    ACK = "ack"
    RETRY = "retry"
    TERM = "term"


Handler = Callable[[Msg], Awaitable[Outcome]]


def retry_delay_s(num_delivered: int) -> float:
    """Bounded exponential backoff: 1s, 2s, 4s ... capped at 30s."""
    return float(min(30, 2 ** max(0, num_delivered - 1)))


async def run(psub: JetStreamContext.PullSubscription, handler: Handler, state: ConsumerState, stop: asyncio.Event,
              *, batch: int = 10, fetch_timeout_s: float = 2.0) -> None:
    state.status = "running"
    while not stop.is_set():
        try:
            msgs = await psub.fetch(batch, timeout=fetch_timeout_s)
        except NatsTimeout:
            continue  # nothing pending; loop so we notice stop
        except Exception as e:
            state.last_error = type(e).__name__
            log.warning("consumer.fetch_failed", error=type(e).__name__)
            await asyncio.sleep(1)
            continue
        for msg in msgs:
            started = time.monotonic()
            meta = msg.metadata
            seq = meta.sequence.stream
            attempt = meta.num_delivered
            try:
                outcome = await handler(msg)
            except Exception as e:  # a bug in the handler must not crash the loop or lose the message
                state.last_error = type(e).__name__
                log.error("consumer.handler_crashed", seq=seq, attempt=attempt, error=type(e).__name__)
                outcome = Outcome.RETRY
            if outcome is Outcome.ACK:
                await msg.ack()
                state.mark_success(seq)
            elif outcome is Outcome.RETRY:
                state.failed += 1
                await msg.nak(delay=retry_delay_s(attempt))
            else:
                state.failed += 1
                await msg.term()
            log.info("consumer.handled", subject=msg.subject, seq=seq, attempt=attempt, outcome=outcome.value, latencyMs=int((time.monotonic() - started) * 1000),
                     correlationId=(msg.headers or {}).get("x-correlation-id"), eventId=(msg.headers or {}).get("Nats-Msg-Id"), aggregateId=(msg.headers or {}).get("x-aggregate-id"))
    state.status = "stopped"
