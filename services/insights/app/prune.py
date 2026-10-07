"""
Operator tool: prune demo/test data from the LIVE projection set of insights_db (this service owns that database).

    python -m app.prune --keep keep.json                  # dry run: prints what would be deleted
    python -m app.prune --keep keep.json --apply --backup backup_dir

keep.json (written by services/management/scripts/prune-demo-data.mjs) lists what stays:
    {"workspaceId": "ws_dev", "projects": ["prj_…"], "teams": ["team_…"]}
Everything in other workspaces goes; inside the workspace only the listed projects/teams survive (activity rows
are matched by projectId, or by teamId for team events). Inbox rows of deleted events go with them so the
deduplication state stays consistent. processing_failures are kept (operator records).
The JetStream stream is NOT touched: a later full replay would recreate deleted entities from retained events
(7 day retention, D-08); use `--set` replays with care after a prune.
"""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path

from bson import json_util

from app import mongo
from app.logging import configure_logging
from app.projections import MongoStore
from app.settings import Settings


async def prune(settings: Settings, keep: dict, *, apply: bool, backup: Path | None) -> dict:
    ws, projects, teams = keep["workspaceId"], list(keep["projects"]), list(keep["teams"])
    client = mongo.make_client(settings)
    store = MongoStore(client, mongo.owned_db(client, settings), settings.projection_set)
    report: dict[str, dict[str, int]] = {}

    # (collection, filter selecting what to DELETE)
    plans = [
        (store.activity, {"$or": [{"workspaceId": {"$ne": ws}},
                                  {"workspaceId": ws, "projectId": {"$nin": projects, "$ne": None}},
                                  {"workspaceId": ws, "projectId": None, "teamId": {"$nin": teams}}]}),
        (store.projects, {"$or": [{"workspaceId": {"$ne": ws}}, {"_id": {"$nin": projects}}]}),
        (store.items, {"$or": [{"workspaceId": {"$ne": ws}}, {"projectId": {"$nin": projects}}]}),
        (store.teams, {"$or": [{"workspaceId": {"$ne": ws}}, {"_id": {"$nin": teams}}]}),
    ]
    # inbox rows follow the activity rows that are being deleted (one inbox row per applied event)
    doomed_events = [d["_id"] async for d in store.activity.find(plans[0][1], {"_id": 1})]
    plans.append((store.inbox, {"eventId": {"$in": doomed_events}}))

    if apply and backup:
        backup.mkdir(parents=True, exist_ok=True)
    for coll, flt in plans:
        count = await coll.count_documents(flt)
        total = await coll.estimated_document_count()
        report[coll.name] = {"delete": count, "keep": total - count}
        if apply and count:
            if backup:
                with (backup / f"insights.{coll.name}.jsonl").open("w") as fh:
                    async for doc in coll.find(flt):
                        fh.write(json_util.dumps(doc) + "\n")
            # chunked $in deletes keep each command small
            if coll is store.inbox:
                for i in range(0, len(doomed_events), 500):
                    await coll.delete_many({"eventId": {"$in": doomed_events[i:i + 500]}})
            else:
                await coll.delete_many(flt)
    await client.close()
    return {"applied": apply, "workspace": ws, "collections": report}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--keep", required=True, help="keep.json written by the management prune script")
    ap.add_argument("--apply", action="store_true", help="actually delete (default: dry run)")
    ap.add_argument("--backup", type=Path, help="directory for jsonl backups of deleted documents (with --apply)")
    args = ap.parse_args(argv)
    settings = Settings()
    configure_logging(settings.log_level, service="insights-prune")
    print(json.dumps(asyncio.run(prune(settings, json.loads(Path(args.keep).read_text()), apply=args.apply, backup=args.backup))))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
