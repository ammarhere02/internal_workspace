"""
Replay / rebuild (PDF §10, checklist §5): build a CLEAN projection set from the retained stream without
touching Management data or the live projection.

    python -m app.replay --set _rebuild_20261007            # build; stops when the consumer has nothing pending
    python -m app.replay --set _rebuild_20261007 --compare   # also diff workloads against the live set
    python -m app.replay --set _rebuild_20261007 --drop      # delete that set's collections and its durable consumer
    python -m app.replay --set _rebuild_20261007 --adopt prj_a,prj_b   # copy those projects' rebuilt projections into the LIVE set

What it does
  * a NEW durable consumer `activity-insights-<set>` from sequence 1 (DeliverPolicy.ALL) — its inbox key
    (eventId, consumer) is distinct, so dedup state is coherent for the new set and untouched for the live one
  * the SAME handler and store code as production, pointed at collections suffixed with <set>
  * reads only the stream; never publishes, never writes management_db
Activation (documented, manual): restart the service with PROJECTION_SET=<set> CONSUMER_NAME=activity-insights-<set>.
The old set stays for rollback; delete it when satisfied. Limit: only events still retained by the stream
(7 days / 100 MB, D-08) can be replayed — the report prints the stream's first sequence so truncation is visible.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

from app import consumer, mongo, nats_client
from app.contracts import ContractValidator
from app.handler import EventHandler
from app.logging import configure_logging, get_logger
from app.projections import MongoStore
from app.reducers import rebuild_workload, workload_view
from app.settings import STREAM_NAME, Settings
from app.state import ConsumerState


async def build(settings: Settings, projection_set: str, *, stream: str = STREAM_NAME, filter_subject: str = "tm.v1.>", idle_rounds: int = 3) -> dict:
    log = get_logger("replay")
    if not projection_set.startswith("_"):
        raise SystemExit("--set must start with '_' (it is a collection suffix)")
    consumer_name = f"activity-insights{projection_set}"
    client = mongo.make_client(settings)
    db = mongo.owned_db(client, settings)
    store = MongoStore(client, db, projection_set)
    await store.ensure_indexes()
    nc = await nats_client.connect(settings.nats_url, name=f"insights-replay{projection_set}")
    js = nc.jetstream()
    sinfo = await js.stream_info(stream)
    psub = await nats_client.ensure_consumer(js, stream=stream, durable=consumer_name, filter_subject=filter_subject, max_deliver=settings.consumer_max_deliver, ack_wait_s=settings.consumer_ack_wait_s)
    state = ConsumerState()
    handler = EventHandler(ContractValidator(settings.contracts_path()), store, state, consumer=consumer_name, max_deliver=settings.consumer_max_deliver)
    stop = asyncio.Event()
    task = asyncio.create_task(consumer.run(psub, handler.handle, state, stop, batch=settings.consumer_batch, fetch_timeout_s=1))

    idle = 0
    while not stop.is_set():
        await asyncio.sleep(1)
        info = await js.consumer_info(stream, consumer_name)
        idle = idle + 1 if info.num_pending == 0 and info.num_ack_pending == 0 else 0
        if idle >= idle_rounds:
            stop.set()
    await task
    report = {
        "projectionSet": projection_set, "consumer": consumer_name,
        "stream": {"firstSeq": sinfo.state.first_seq, "lastSeq": sinfo.state.last_seq, "messages": sinfo.state.messages},
        "truncated": sinfo.state.first_seq > 1,
        "processed": state.processed, "duplicates": state.duplicates, "failed": state.failed, "lastStreamSeq": state.last_stream_seq,
        "projects": await store.projects.count_documents({}), "items": await store.items.count_documents({}), "activity": await store.activity.count_documents({}),
    }
    log.info("replay.done", **report)
    await nc.drain()
    await client.close()
    return report


async def compare(settings: Settings, projection_set: str, live_set: str | None = None) -> dict:
    """Workload of every project in the new set vs the live set, plus an internal consistency check
    (counters recomputed from item snapshots must equal the stored counters)."""
    client = mongo.make_client(settings)
    db = mongo.owned_db(client, settings)
    live, new = MongoStore(client, db, settings.projection_set if live_set is None else live_set), MongoStore(client, db, projection_set)
    diffs, inconsistent, compared = [], [], 0
    async for p in new.projects.find({}):
        compared += 1
        lp = await live.projects.find_one({"_id": p["_id"]})
        if lp is None or workload_view(lp["workload"]) != workload_view(p["workload"]):
            diffs.append(p["_id"])
        items = await new.items.find({"projectId": p["_id"]}).to_list()
        if workload_view(rebuild_workload(items)) != workload_view(p["workload"]):
            inconsistent.append(p["_id"])
    await client.close()
    return {"projectsCompared": compared, "differing": diffs, "inconsistent": inconsistent}


async def adopt(settings: Settings, projection_set: str, project_ids: list[str]) -> dict:
    """Repair specific projects in the live set from a rebuilt set (project + item snapshots + their team documents).
    Activity rows and inbox state of the live set are untouched; only derived counters/snapshots are replaced."""
    if not projection_set.startswith("_") or projection_set == settings.projection_set:
        raise SystemExit("--adopt needs a rebuilt set ('_' suffix) different from the live one")
    client = mongo.make_client(settings)
    db = mongo.owned_db(client, settings)
    src, live = MongoStore(client, db, projection_set), MongoStore(client, db, settings.projection_set)
    out = {"projects": 0, "items": 0, "teams": 0, "missing": []}
    team_ids: set[str] = set()
    for pid in project_ids:
        proj = await src.projects.find_one({"_id": pid})
        if proj is None:
            out["missing"].append(pid)
            continue
        await live.projects.replace_one({"_id": pid}, proj, upsert=True)
        out["projects"] += 1
        if proj.get("teamId"):
            team_ids.add(proj["teamId"])
        async for item in src.items.find({"projectId": pid}):
            await live.items.replace_one({"_id": item["_id"]}, item, upsert=True)
            out["items"] += 1
    for tid in team_ids:
        team = await src.teams.find_one({"_id": tid})
        if team is not None:
            await live.teams.replace_one({"_id": tid}, team, upsert=True)
            out["teams"] += 1
    await client.close()
    return out


async def drop(settings: Settings, projection_set: str, *, stream: str = STREAM_NAME) -> dict:
    """Remove a REBUILT set (collections + its durable consumer). Refuses the live set and anything that is not a '_' suffix."""
    if not projection_set.startswith("_") or projection_set == settings.projection_set:
        raise SystemExit("refusing to drop: the set must start with '_' and must not be the live projection set")
    client = mongo.make_client(settings)
    store = MongoStore(client, mongo.owned_db(client, settings), projection_set)
    dropped = []
    for coll in store.collections:
        await coll.drop()
        dropped.append(coll.name)
    nc = await nats_client.connect(settings.nats_url, name=f"insights-replay-drop{projection_set}")
    try:
        await nc.jetstream().delete_consumer(stream, f"activity-insights{projection_set}")
        consumer_deleted = True
    except Exception:
        consumer_deleted = False
    await nc.drain()
    await client.close()
    return {"dropped": dropped, "consumerDeleted": consumer_deleted}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--set", required=True, help="projection set suffix, e.g. _rebuild_20261007")
    ap.add_argument("--compare", action="store_true", help="diff workloads against the live projection set afterwards")
    ap.add_argument("--adopt", help="comma-separated project ids: copy their rebuilt projections from --set into the live set (no rebuild)")
    ap.add_argument("--drop", action="store_true", help="delete a previously built set (collections + durable consumer) instead of building")
    args = ap.parse_args(argv)
    settings = Settings()
    configure_logging(settings.log_level, service="insights-replay")
    if args.drop:
        print(json.dumps(asyncio.run(drop(settings, args.set))))
        return 0
    if args.adopt:
        print(json.dumps(asyncio.run(adopt(settings, args.set, [x for x in args.adopt.split(",") if x]))))
        return 0
    report = asyncio.run(build(settings, args.set))
    if args.compare:
        report["compare"] = asyncio.run(compare(settings, args.set))
    print(json.dumps(report, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
