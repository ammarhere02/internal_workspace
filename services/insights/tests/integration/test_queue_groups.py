"""
Phase 7, PDF §14 "queue group" and "request/reply timeout" on a REAL NATS server, distinguishing the two
load-balancing mechanisms the assignment asks about:
  1. Core NATS queue group: two responders subscribe to the same query subject with the same queue name;
     every request is answered exactly once and the work is shared.
  2. JetStream shared durable pull consumer: two worker tasks fetch from ONE durable consumer; each message
     is delivered to exactly one worker (and acked once), the union covers the stream.
  3. Request/reply timeout: no responder -> NoRespondersError at once; a slow responder -> the requester's
     own timeout fires (bounded wait), the responder's own handler_timeout_s bounds its work.
Cleans up its own stream only.
"""

import asyncio

import nats
import pytest
from nats.errors import NoRespondersError, TimeoutError as NatsTimeout

import json

from app import consumer, nats_client
from app.consumer import Outcome
from app.query_responder import serve
from app.state import ConsumerState

pytestmark = pytest.mark.integration
STREAM = "TEAM_EVENTS_QG_TEST"
PREFIX = "tmqg.v1"


@pytest.fixture
async def clean_stream(nats_url):
    async def drop():
        nc = await nats.connect(nats_url)
        try:
            await nc.jetstream().delete_stream(STREAM)
        except Exception:
            pass
        await nc.close()
    await drop()
    yield
    await drop()


async def test_core_queue_group_answers_each_request_once(nats_url):
    nc = await nats_client.connect(nats_url, name="qg-test")
    subject = "tmqg.query.v1.echo"
    answered = {"a": 0, "b": 0}

    packet = lambda n: json.dumps({"pattern": "tmqg", "data": {"n": n}, "id": f"r{n}"}).encode()  # Nest transport wire format

    def responder(name):
        async def handler(data, corr):
            answered[name] += 1
            return {"status": "ready", "by": name, "n": data["n"]}
        return handler

    sa = await serve(nc, subject, responder("a"), queue="insights-test")
    sb = await serve(nc, subject, responder("b"), queue="insights-test")
    try:
        replies = []
        for n in range(30):
            msg = await nc.request(subject, packet(n), timeout=2)
            replies.append(json.loads(msg.data)["response"])
        assert sorted(r["n"] for r in replies) == list(range(30)), "every request answered exactly once"
        assert answered["a"] + answered["b"] == 30 and answered["a"] > 0 and answered["b"] > 0, f"shared between responders: {answered}"
    finally:
        await sa.unsubscribe()
        await sb.unsubscribe()
        await nc.close()


async def test_shared_pull_consumer_delivers_each_message_to_one_worker(nats_url, node_runner, clean_stream):
    published = await node_runner("interop-publish.mjs", STREAM, PREFIX, "20")
    nc = await nats_client.connect(nats_url, name="qg-workers")
    js = nc.jetstream()
    psub = await nats_client.ensure_consumer(js, stream=STREAM, durable="qg-shared", filter_subject=f"{PREFIX}.>", max_deliver=3, ack_wait_s=10)
    psub2 = await js.pull_subscribe(f"{PREFIX}.>", durable="qg-shared", stream=STREAM)  # second worker bound to the SAME durable
    seen = {"w1": [], "w2": []}
    stop = asyncio.Event()
    state1, state2 = ConsumerState(), ConsumerState()

    def worker(name):
        async def handler(msg):
            seen[name].append(msg.headers["Nats-Msg-Id"])
            await asyncio.sleep(0.02)  # keep both busy so the broker spreads the load
            if len(seen["w1"]) + len(seen["w2"]) >= 20:
                stop.set()
            return Outcome.ACK
        return handler

    t1 = asyncio.create_task(consumer.run(psub, worker("w1"), state1, stop, batch=3, fetch_timeout_s=1))
    t2 = asyncio.create_task(consumer.run(psub2, worker("w2"), state2, stop, batch=3, fetch_timeout_s=1))
    try:
        await asyncio.wait_for(stop.wait(), timeout=30)
    finally:
        stop.set()
        await asyncio.gather(t1, t2, return_exceptions=True)
    all_ids = seen["w1"] + seen["w2"]
    assert sorted(all_ids) == sorted(published["eventIds"]), "union = every published event, nothing twice"
    assert not set(seen["w1"]) & set(seen["w2"]), "no message went to both workers"
    assert seen["w1"] and seen["w2"], f"both workers took part: {len(seen['w1'])}/{len(seen['w2'])}"
    assert state1.processed + state2.processed == 20
    info = await js.consumer_info(STREAM, "qg-shared")
    assert info.num_pending == 0 and info.num_ack_pending == 0, "everything acked exactly once"
    await nc.close()


async def test_request_reply_timeouts_are_bounded(nats_url):
    nc = await nats_client.connect(nats_url, name="qg-timeout")
    with pytest.raises(NoRespondersError):
        await nc.request("tmqg.query.v1.nobody", b"{}", timeout=1)  # no responder: fails immediately, no waiting
    slow_subject = "tmqg.query.v1.slow"

    async def slow(data, corr):
        await asyncio.sleep(5)
        return {"status": "ready"}

    sub = await serve(nc, slow_subject, slow, queue="insights-test", handler_timeout_s=0.5)
    try:
        # the responder bounds its own work (0.5 s) and replies with a typed timeout error instead of hanging
        msg = await nc.request(slow_subject, json.dumps({"pattern": "tmqg", "data": {}, "id": "slow1"}).encode(), timeout=2)
        reply = json.loads(msg.data)
        assert reply["err"]["code"] == "timeout"
    finally:
        await sub.unsubscribe()
    # and a requester never waits longer than its own deadline even if nobody ever replies
    sub2 = await nc.subscribe("tmqg.query.v1.silent")  # subscriber exists but never responds
    try:
        with pytest.raises(NatsTimeout):
            await asyncio.wait_for(nc.request("tmqg.query.v1.silent", b"{}", timeout=0.3), timeout=2)
    finally:
        await sub2.unsubscribe()
        await nc.close()
