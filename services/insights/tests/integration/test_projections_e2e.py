"""
Phase 5 on REAL infrastructure (local NATS + Atlas insights_db), in an isolated stream and projection set:
  1. a full project journey (create, board, items, assign, reassign, move, out-of-order, stale duplicate, archive,
     team reassignment) flows through the durable consumer into one transaction per event; the workload and
     item projections are checked step by step, including the reassignment trace and "duplicate changes nothing"
  2. the query subjects are answered through the OFFICIAL NestJS NATS client (interop-request.mjs): ready,
     not_ready, bad request, activity pagination — every reply validated against the shared JSON Schemas
  3. replay rebuilds an identical projection set from the stream under a new consumer name, without touching
     the first set; the internal consistency check (counters == recomputed from snapshots) passes
Cleanup drops only the two test projection sets and the test stream.
"""

import asyncio
import json
import os
from pathlib import Path

import nats
import pytest
from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app import consumer, mongo, nats_client, replay
from app.contracts import ContractValidator
from app.handler import EventHandler
from app.projections import MongoStore
from app.queries import QueryHandlers
from app.query_responder import serve
from app.reducers import rebuild_workload, workload_view
from app.settings import Settings
from app.state import ConsumerState
from tests.events import WS, Journey, item_state

pytestmark = pytest.mark.integration
STREAM = "TEAM_EVENTS_PROJ_TEST"
PREFIX = "tmproj.v1"
SET, REPLAY_SET = "_projtest", "_projtest_replay"
CONSUMER = f"activity-insights{SET}"
Q = Path(__file__).resolve().parents[4] / "contracts" / "schemas" / "queries"
_ins = json.loads((Q / "project_insights.response.schema.json").read_text())
_reg = Registry().with_resource(_ins["$id"], Resource.from_contents(_ins))
INSIGHTS = Draft202012Validator(_ins, registry=_reg, format_checker=FormatChecker())
ACTIVITY = Draft202012Validator(json.loads((Q / "project_activity.response.schema.json").read_text()), registry=_reg, format_checker=FormatChecker())


@pytest.fixture
async def infra(nats_url):
    if not os.environ.get("MONGODB_URI") and not os.path.exists(".env"):
        pytest.skip("needs services/insights/.env (MONGODB_URI)")
    settings = Settings()
    client = mongo.make_client(settings)
    db = mongo.owned_db(client, settings)
    stores = [MongoStore(client, db, SET), MongoStore(client, db, REPLAY_SET)]
    for s in stores:
        for c in s.collections:
            await db.drop_collection(c.name)
    await stores[0].ensure_indexes()
    nc = await nats.connect(nats_url)
    try:
        await nc.jetstream().delete_stream(STREAM)
    except Exception:
        pass
    await nc.close()
    yield settings, client, stores[0]
    for s in stores:
        for c in s.collections:
            await db.drop_collection(c.name)
    nc = await nats.connect(nats_url)
    try:
        await nc.jetstream().delete_stream(STREAM)
    except Exception:
        pass
    await nc.close()
    await client.close()


async def publish(js, events):
    for e in events:
        await js.publish(f"{PREFIX}.{e['eventType']}", json.dumps(e).encode(), headers={"Nats-Msg-Id": e["eventId"], "x-correlation-id": e["correlationId"]})


async def drain(js, psub, handler, state, expected_total):
    """Run the consumer loop until `expected_total` deliveries were acked (stale ones included), then stop."""
    stop = asyncio.Event()
    count = 0

    async def h(msg):
        nonlocal count
        out = await handler.handle(msg)
        count += 1
        if count >= expected_total:
            stop.set()
        return out

    task = asyncio.create_task(consumer.run(psub, h, state, stop, batch=10, fetch_timeout_s=1))
    await asyncio.wait_for(stop.wait(), timeout=60)
    await task


async def test_journey_queries_and_replay(nats_url, node_runner, infra):
    settings, client, store = infra
    j = Journey()
    nc = await nats_client.connect(nats_url, name="proj-test")
    js = nc.jetstream()
    await nats_client.ensure_stream(js, STREAM, [f"{PREFIX}.>"])
    psub = await nats_client.ensure_consumer(js, stream=STREAM, durable=CONSUMER, filter_subject=f"{PREFIX}.>", max_deliver=3, ack_wait_s=10)
    state = ConsumerState()
    handler = EventHandler(ContractValidator(settings.contracts_path()), store, state, consumer=CONSUMER, max_deliver=3)

    # ---- 1. journey -------------------------------------------------------------------------------------
    wi1_v1 = item_state("wi_1", "PAY-1", column="backlog", priority="MEDIUM")
    wi1_v2 = {**wi1_v1, "assigneeId": "usr_a"}
    wi1_v3 = {**wi1_v2, "columnId": "todo"}
    wi1_v4 = {**wi1_v3, "assigneeId": "usr_b"}                       # the reassignment
    wi2_v1 = item_state("wi_2", "PAY-2", column="backlog", priority="HIGH", assignee="usr_a")
    wi2_v2 = {**wi2_v1, "columnId": "todo"}
    wi2_v3 = {**wi2_v2, "columnId": "review"}
    wi2_v4 = {**wi2_v3, "archived": True}
    batch1 = [j.project_created(), j.board_created(),
              j.item("workitem.created", 1, wi1_v1), j.item("workitem.assigned", 2, wi1_v2, previousAssigneeId=None),
              j.item("workitem.created", 1, wi2_v1), j.item("workitem.moved", 3, wi1_v3, fromColumnId="backlog", toColumnId="todo")]
    await publish(js, batch1)
    await drain(js, psub, handler, state, len(batch1))
    p = await store.project(WS, "prj_1")
    assert p["projectKey"] == "PAY" and p["teamId"] == "team_1" and [c["columnId"] for c in p["columns"]][:2] == ["backlog", "todo"]
    assert workload_view(p["workload"]) == {"totalActive": 2, "byColumn": {"todo": 1, "backlog": 1}, "byPriority": {"MEDIUM": 1, "HIGH": 1},
                                            "byAssignee": [{"assigneeId": "usr_a", "total": 2, "byColumn": {"todo": 1, "backlog": 1}}]}

    # reassignment: one unit moves usr_a -> usr_b, totals unchanged
    reassign = j.item("workitem.assigned", 4, wi1_v4, previousAssigneeId="usr_a")
    await publish(js, [reassign])
    await drain(js, psub, handler, state, 1)
    w = workload_view((await store.project(WS, "prj_1"))["workload"])
    assert w["totalActive"] == 2 and w["byAssignee"] == [{"assigneeId": "usr_a", "total": 1, "byColumn": {"backlog": 1}}, {"assigneeId": "usr_b", "total": 1, "byColumn": {"todo": 1}}]

    # a duplicate of the reassignment with a NEW eventId (beyond the broker window) is stale by version: nothing changes
    dup = {**reassign, "eventId": j.item("workitem.assigned", 4, wi1_v4)["eventId"]}
    await publish(js, [dup])
    await drain(js, psub, handler, state, 1)
    assert workload_view((await store.project(WS, "prj_1"))["workload"]) == w
    assert (await store.inbox.find_one({"eventId": dup["eventId"]}))["result"] == "applied_stale"
    assert await store.activity.count_documents({"_id": dup["eventId"]}) == 1, "history is still recorded"

    # out of order: v3 (review) arrives before v2 (todo); then archive v4; then project team reassigned
    batch3 = [j.item("workitem.moved", 3, wi2_v3, fromColumnId="todo", toColumnId="review"),
              j.item("workitem.moved", 2, wi2_v2, fromColumnId="backlog", toColumnId="todo"),
              j.item("workitem.archived", 4, wi2_v4), j.team_assigned(2, "team_2", "team_1")]
    await publish(js, batch3)
    await drain(js, psub, handler, state, len(batch3))
    p = await store.project(WS, "prj_1")
    wi2 = await store.items.find_one({"_id": "wi_2"})
    assert wi2["version"] == 4 and wi2["archived"] is True and wi2["columnId"] == "review"
    assert p["teamId"] == "team_2" and p["projectVersion"] == 2
    final = workload_view(p["workload"])
    assert final == {"totalActive": 1, "byColumn": {"todo": 1}, "byPriority": {"MEDIUM": 1}, "byAssignee": [{"assigneeId": "usr_b", "total": 1, "byColumn": {"todo": 1}}]}
    items = await store.items.find({"projectId": "prj_1"}).to_list()
    assert workload_view(rebuild_workload(items)) == final, "counters equal a recount from the snapshots"
    assert await store.activity.count_documents({"workspaceId": WS, "projectId": "prj_1"}) == 12, "every project/board/item event, the stale duplicate included"
    assert p["lastStreamSeq"] == (await js.stream_info(STREAM)).state.last_seq

    # ---- 2. queries through the official NestJS NATS client ------------------------------------------------
    q = QueryHandlers(store, state)
    subs = [await serve(nc, "tmproj.query.v1.project_insights", q.insights), await serve(nc, "tmproj.query.v1.project_activity", q.activity)]
    try:
        r = await node_runner("interop-request.mjs", "tmproj.query.v1.project_insights", json.dumps({"workspaceId": WS, "projectId": "prj_1", "correlationId": "req_q1"}), "3000")
        assert r["ok"], r
        INSIGHTS.validate(r["response"])
        assert r["response"]["status"] == "ready" and r["response"]["correlationId"] == "req_q1" and r["response"]["workload"] == final
        assert r["response"]["freshness"]["lastStreamSeq"] == p["lastStreamSeq"] and r["response"]["freshness"]["processingAgeMs"] >= 0

        r = await node_runner("interop-request.mjs", "tmproj.query.v1.project_insights", json.dumps({"workspaceId": "ws_other", "projectId": "prj_1", "correlationId": "req_q2"}), "3000")
        INSIGHTS.validate(r["response"])
        assert r["response"]["status"] == "not_ready"

        r = await node_runner("interop-request.mjs", "tmproj.query.v1.project_insights", json.dumps({"projectId": "prj_1"}), "3000")
        assert r["ok"] and r["response"]["status"] == "error" and r["response"]["error"]["code"] == "bad_request"

        r = await node_runner("interop-request.mjs", "tmproj.query.v1.project_activity", json.dumps({"workspaceId": WS, "projectId": "prj_1", "correlationId": "req_q3", "limit": 4}), "3000")
        ACTIVITY.validate(r["response"])
        page1 = r["response"]
        assert page1["status"] == "ready" and len(page1["items"]) == 4 and page1["nextCursor"] == page1["items"][-1]["eventId"]
        assert page1["items"][0]["summary"] == "assigned project PAY to team team_2"
        r = await node_runner("interop-request.mjs", "tmproj.query.v1.project_activity", json.dumps({"workspaceId": WS, "projectId": "prj_1", "correlationId": "req_q3", "limit": 4, "cursor": page1["nextCursor"]}), "3000")
        page2 = r["response"]
        assert [i["eventId"] for i in page2["items"]] < [i["eventId"] for i in page1["items"]] and len({i["eventId"] for i in page1["items"] + page2["items"]}) == 8
    finally:
        for s in subs:
            await s.unsubscribe()
    await nc.close()

    # ---- 3. replay into a clean set ----------------------------------------------------------------------
    report = await replay.build(settings, REPLAY_SET, stream=STREAM, filter_subject=f"{PREFIX}.>", idle_rounds=2)
    assert report["processed"] == 12 and report["failed"] == 0 and report["projects"] == 1 and report["items"] == 2 and report["truncated"] is False
    cmp = await replay.compare(settings, REPLAY_SET, live_set=SET)
    assert cmp == {"projectsCompared": 1, "differing": [], "inconsistent": []}
    new = MongoStore(client, mongo.owned_db(client, settings), REPLAY_SET)
    assert workload_view((await new.project(WS, "prj_1"))["workload"]) == final
    assert await new.inbox.count_documents({"consumer": f"activity-insights{REPLAY_SET}"}) == 12
    assert await store.inbox.count_documents({"consumer": f"activity-insights{REPLAY_SET}"}) == 0, "the live set was not touched"
