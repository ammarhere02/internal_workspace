"""
Phase 4 proof on REAL infrastructure: NestJS publisher -> JetStream (isolated stream) -> Python durable
consumer -> real Atlas insights_db transaction -> ack after commit. Shows, separately from the broker's
Nats-Msg-Id suppression (test_nats_interop), that the INBOX makes repeated delivery produce exactly one
activity record:
  1. the same message delivered twice through the broker (commit-before-ack crash simulated by returning
     RETRY after the transaction committed) -> second delivery hits the inbox -> ACK, 1 activity row
  2. two concurrent attempts to apply the same event -> one applied, one duplicate/write-conflict
  3. a poison message -> processing_failures row, TERM, no activity row, nothing acked twice
Needs: services/insights/.env with MONGODB_URI and a running NATS. Cleans up only its own consumer's rows.
"""

import asyncio
import json
import os

import nats
import pytest
from nats.js.api import StreamConfig

from app import consumer, mongo, nats_client
from app.consumer import Outcome
from app.contracts import ContractValidator
from app.handler import EventHandler
from app.projections import DeliveryMeta, MongoStore
from app.settings import Settings
from app.state import ConsumerState

pytestmark = pytest.mark.integration
STREAM = "TEAM_EVENTS_INBOX_TEST"
PREFIX = "tminbox.v1"
CONSUMER = "inbox-test-consumer"


async def _clean(store):
    """Only this suite's rows: its consumer name and the fictional ws_test workspace."""
    for coll in (store.inbox, store.failures):
        await coll.delete_many({"consumer": CONSUMER})
    for coll in (store.activity, store.projects, store.items, store.teams):
        await coll.delete_many({"workspaceId": "ws_test"})


@pytest.fixture
async def infra(nats_url):
    if not os.environ.get("MONGODB_URI") and not os.path.exists(".env"):
        pytest.skip("needs services/insights/.env (MONGODB_URI)")
    settings = Settings()
    client = mongo.make_client(settings)
    db = mongo.owned_db(client, settings)
    store = MongoStore(client, db)
    await store.ensure_indexes()
    await _clean(store)
    nc = await nats.connect(nats_url)
    try:
        await nc.jetstream().delete_stream(STREAM)
    except Exception:
        pass
    await nc.close()
    yield settings, client, store
    await _clean(store)
    nc = await nats.connect(nats_url)
    try:
        await nc.jetstream().delete_stream(STREAM)
    except Exception:
        pass
    await nc.close()
    await client.close()


async def test_repeated_delivery_yields_exactly_one_activity_record(nats_url, node_runner, infra):
    settings, client, store = infra
    published = await node_runner("interop-publish.mjs", STREAM, PREFIX, "2")
    e1, e2 = published["eventIds"]

    nc = await nats_client.connect(nats_url, name="inbox-test")
    js = nc.jetstream()
    psub = await nats_client.ensure_consumer(js, stream=STREAM, durable=CONSUMER, filter_subject=f"{PREFIX}.>", max_deliver=4, ack_wait_s=5)
    state = ConsumerState()
    handler = EventHandler(ContractValidator(settings.contracts_path()), store, state, consumer=CONSUMER, max_deliver=4)

    deliveries: list[tuple[str, int, str]] = []
    stop = asyncio.Event()

    async def crash_after_commit_once(msg):
        event = json.loads(msg.data)
        outcome = await handler.handle(msg)  # commits inbox + activity
        deliveries.append((event["eventId"], msg.metadata.num_delivered, outcome.value))
        if event["eventId"] == e1 and msg.metadata.num_delivered == 1:
            return Outcome.RETRY  # "process died before msg.ack()": the broker must redeliver
        if {d[0] for d in deliveries} == {e1, e2} and any(d == (e1, 2, "ack") for d in deliveries):
            stop.set()
        return outcome

    task = asyncio.create_task(consumer.run(psub, crash_after_commit_once, state, stop, batch=5, fetch_timeout_s=1))
    await asyncio.wait_for(stop.wait(), timeout=40)
    await task

    assert (e1, 1, "ack") in deliveries and (e1, 2, "ack") in deliveries, deliveries
    assert state.duplicates == 1, "second delivery of e1 was recognised by the inbox, not re-applied"
    assert await store.activity.count_documents({"_id": {"$in": [e1, e2]}}) == 2, "exactly one activity row per event"
    assert await store.inbox.count_documents({"consumer": CONSUMER}) == 2, "exactly one inbox row per (eventId, consumer)"
    row = await store.inbox.find_one({"eventId": e1, "consumer": CONSUMER})
    assert row["result"] == "applied" and row["processedAt"] is not None and row["correlationId"] == "req_interop_1"
    info = await js.consumer_info(STREAM, CONSUMER)
    assert info.num_pending == 0 and info.num_ack_pending == 0, "everything acknowledged after commit"

    # concurrent duplicate attempts (not only sequential): both race on the unique inbox index inside transactions
    meta = DeliveryMeta(consumer=CONSUMER, subject=f"{PREFIX}.team.created", stream_seq=99, num_delivered=1, correlation_id="req_race")
    event = {**json.loads((await js.get_msg(STREAM, published["seqs"][1])).data), "eventId": "01J9Q3Z8K2V4N6P8R0T2W4Y6ZZ"}
    results = await asyncio.gather(*(store.apply(event, meta) for _ in range(4)), return_exceptions=True)
    applied = [r for r in results if r == "applied"]
    others = [r for r in results if r != "applied"]
    assert len(applied) == 1, results
    assert all(r == "duplicate" or isinstance(r, Exception) for r in others), "losers are duplicates or transient write conflicts (retried by the loop)"
    assert await store.activity.count_documents({"_id": event["eventId"]}) == 1
    await nc.close()


async def test_poison_message_is_quarantined_and_termed(nats_url, infra):
    settings, client, store = infra
    nc = await nats_client.connect(nats_url, name="inbox-test-poison")
    js = nc.jetstream()
    await js.add_stream(StreamConfig(name=STREAM, subjects=[f"{PREFIX}.>"]))
    bad = {"eventId": "01J9Q3Z8K2V4N6P8R0T2W4Y6B1", "eventType": "team.created", "schemaVersion": 7, "payload": {}}
    ack = await js.publish(f"{PREFIX}.team.created", json.dumps(bad).encode(), headers={"Nats-Msg-Id": bad["eventId"], "x-correlation-id": "req_poison"})
    await js.publish(f"{PREFIX}.team.created", b"\xff\xfe not json", headers={"Nats-Msg-Id": "garbage-1"})

    psub = await nats_client.ensure_consumer(js, stream=STREAM, durable=CONSUMER, filter_subject=f"{PREFIX}.>", max_deliver=3, ack_wait_s=5)
    state = ConsumerState()
    handler = EventHandler(ContractValidator(settings.contracts_path()), store, state, consumer=CONSUMER, max_deliver=3)
    stop = asyncio.Event()
    seen = []

    async def h(msg):
        out = await handler.handle(msg)
        seen.append(out.value)
        if len(seen) == 2:
            stop.set()
        return out

    task = asyncio.create_task(consumer.run(psub, h, state, stop, batch=5, fetch_timeout_s=1))
    await asyncio.wait_for(stop.wait(), timeout=30)
    await task
    assert seen == ["term", "term"]
    failures = await store.failures.find({"consumer": CONSUMER}).sort("streamSeq", 1).to_list()
    assert [f["classification"] for f in failures] == ["unsupported_schema", "malformed"]
    assert failures[0]["eventId"] == bad["eventId"] and failures[0]["correlationId"] == "req_poison" and failures[0]["streamSeq"] == ack.seq
    assert failures[0]["resolvedAt"] is None and await store.open_failures(CONSUMER) == 2
    assert await store.activity.count_documents({"_id": bad["eventId"]}) == 0
    assert await store.inbox.count_documents({"consumer": CONSUMER}) == 0
    info = await js.consumer_info(STREAM, CONSUMER)
    assert info.num_pending == 0 and info.num_ack_pending == 0, "TERM settled both messages; no endless redelivery"
    await nc.close()
