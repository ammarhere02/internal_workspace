import nats
from nats.aio.client import Client as NATS
from nats.js import JetStreamContext
from nats.js.api import AckPolicy, ConsumerConfig, DeliverPolicy, RetentionPolicy, StorageType, StreamConfig

from app.settings import CONSUMER_NAME, STREAM_NAME, STREAM_SUBJECTS

SEVEN_DAYS_S = 7 * 24 * 60 * 60


async def connect(url: str, name: str = "insights-service") -> NATS:
    return await nats.connect(url, name=name, max_reconnect_attempts=-1)


async def ensure_stream(js: JetStreamContext, name: str = STREAM_NAME, subjects: list[str] | None = None) -> None:
    """Same configuration as NestJS NatsService.ensureStream, so either side can bootstrap first."""
    cfg = StreamConfig(
        name=name,
        subjects=subjects or STREAM_SUBJECTS,
        storage=StorageType.FILE,
        retention=RetentionPolicy.LIMITS,
        max_age=SEVEN_DAYS_S,
        max_bytes=100 * 1024 * 1024,
        duplicate_window=120,
        num_replicas=1,
    )
    try:
        await js.stream_info(name)
        await js.update_stream(cfg)
    except nats.js.errors.NotFoundError:
        await js.add_stream(cfg)


def consumer_config(durable: str, filter_subject: str, max_deliver: int, ack_wait_s: int) -> ConsumerConfig:
    """
    Explicit acks, bounded redelivery with backoff. After max_deliver the broker stops redelivering;
    our handler records a failure document BEFORE that happens (see consumer.py), so nothing vanishes silently.
    """
    return ConsumerConfig(
        durable_name=durable,
        filter_subject=filter_subject,
        ack_policy=AckPolicy.EXPLICIT,
        deliver_policy=DeliverPolicy.ALL,
        max_deliver=max_deliver,
        ack_wait=ack_wait_s,
        # NB: the server sets ack_wait = backoff[0]; start at ack_wait_s so a slow Atlas batch is not redelivered mid-flight
        backoff=[ack_wait_s, ack_wait_s * 2, ack_wait_s * 4, ack_wait_s * 8][: max(1, max_deliver - 1)],
        max_ack_pending=100,
    )


async def ensure_consumer(js: JetStreamContext, *, stream: str = STREAM_NAME, durable: str = CONSUMER_NAME,
                          filter_subject: str = "tm.v1.>", max_deliver: int = 5, ack_wait_s: int = 30):
    cfg = consumer_config(durable, filter_subject, max_deliver, ack_wait_s)
    try:
        await js.consumer_info(stream, durable)
    except nats.js.errors.NotFoundError:
        await js.add_consumer(stream, cfg)
    return await js.pull_subscribe(filter_subject, durable=durable, stream=stream, config=cfg)
