"""
Cross-language proof against a REAL local NATS server (docker compose up nats):
  1. NestJS publisher -> JetStream (file stream) -> Python durable pull consumer, explicit ack,
     redelivery after NAK, broker-side Nats-Msg-Id suppression, and durable position after restart.
  2. NestJS NATS transport client (request/reply) -> Python responder: success, typed error, timeout.
Everything lives in an isolated stream/consumer (TEAM_EVENTS_INTEROP) and is deleted afterwards.
"""

import asyncio
import json

import nats
import pytest

from app import consumer, nats_client
from app.consumer import Outcome
from app.query_responder import QueryError, serve
from app.state import ConsumerState

pytestmark = pytest.mark.integration
STREAM = "TEAM_EVENTS_INTEROP"
PREFIX = "tminterop.v1"


async def _cleanup(url):
    nc = await nats.connect(url)
    try:
        await nc.jetstream().delete_stream(STREAM)
    except Exception:
        pass
    await nc.close()


@pytest.fixture
async def clean_stream(nats_url):
    await _cleanup(nats_url)
    yield
    await _cleanup(nats_url)


async def test_jetstream_publish_consume_ack_redeliver(nats_url, node_runner, clean_stream):
    published = await node_runner("interop-publish.mjs", STREAM, PREFIX, "3")
    assert len(published["eventIds"]) == 3
    assert published["duplicateSuppressed"] is True, "broker did not suppress the re-publish with the same Nats-Msg-Id"

    nc = await nats_client.connect(nats_url, name="interop-consumer")
    js = nc.jetstream()
    psub = await nats_client.ensure_consumer(js, stream=STREAM, durable="interop-consumer", filter_subject=f"{PREFIX}.>", max_deliver=3, ack_wait_s=5)

    seen: list[tuple[str, int]] = []  # (eventId, num_delivered)
    stop = asyncio.Event()

    async def handler(msg):
        event = json.loads(msg.data)
        seen.append((event["eventId"], msg.metadata.num_delivered))
        if event["eventId"] == published["eventIds"][1] and msg.metadata.num_delivered == 1:
            return Outcome.RETRY  # simulate a transient failure once -> expect redelivery
        if len({e for e, _ in seen}) == 3 and len(seen) >= 4:
            stop.set()
        return Outcome.ACK

    state = ConsumerState()
    task = asyncio.create_task(consumer.run(psub, handler, state, stop, batch=5, fetch_timeout_s=1))
    await asyncio.wait_for(stop.wait(), timeout=30)
    await task

    ids = [e for e, _ in seen]
    assert set(ids) == set(published["eventIds"]), "every published event reached Python exactly as sent"
    assert ids.count(published["eventIds"][1]) == 2, "the NAK'd event was redelivered"
    assert len(seen) == 4, "only the NAK'd event was redelivered; the broker-suppressed duplicate never arrived"
    assert state.processed == 3 and state.last_stream_seq == published["seqs"][1], "last acked = the redelivered event"

    # durable position survives: a fresh pull subscription on the same durable has nothing pending
    psub2 = await js.pull_subscribe(f"{PREFIX}.>", durable="interop-consumer", stream=STREAM)
    with pytest.raises(nats.errors.TimeoutError):
        await psub2.fetch(1, timeout=1)
    info = await js.consumer_info(STREAM, "interop-consumer")
    assert info.num_pending == 0 and info.num_ack_pending == 0
    await nc.close()


async def test_nest_request_reply_success_error_timeout(nats_url, node_runner):
    nc = await nats_client.connect(nats_url, name="interop-responder")
    subject = "tminterop.query.echo"

    async def handler(data, correlation_id):
        if data.get("fail"):
            raise QueryError("not_ready", "projection not built yet")
        if data.get("hang"):
            await asyncio.sleep(10)
        return {"status": "ready", "echo": data, "correlationId": correlation_id}

    sub = await serve(nc, subject, handler, handler_timeout_s=1.0)
    try:
        ok = await node_runner("interop-request.mjs", subject, json.dumps({"projectId": "p1", "correlationId": "req_1"}), "3000")
        assert ok["ok"] is True, ok
        assert ok["response"] == {"status": "ready", "echo": {"projectId": "p1", "correlationId": "req_1"}, "correlationId": "req_1"}

        err = await node_runner("interop-request.mjs", subject, json.dumps({"fail": True}), "3000")
        assert err["ok"] is False and err["error"]["code"] == "not_ready"

        slow = await node_runner("interop-request.mjs", subject, json.dumps({"hang": True}), "5000")
        assert slow["ok"] is False and slow["error"]["code"] == "timeout", "responder bounded its own work"

        nobody = await node_runner("interop-request.mjs", "tminterop.query.nobody_listens", json.dumps({}), "1500")
        # NATS answers a request with no subscriber immediately ("no responders"); Nest surfaces it as an
        # empty-response error, so the BFF fails fast instead of waiting out its timeout. Either is acceptable.
        assert nobody["ok"] is False
        assert nobody["error"]["name"] == "TimeoutError" or "Empty response" in nobody["error"]["message"], nobody
    finally:
        await sub.unsubscribe()
        await nc.close()
