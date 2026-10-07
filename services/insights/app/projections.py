"""
Owned insights_db collections written by the event handler (PDF §8, §11):

  inbox                 one row per (eventId, consumer); unique index = the permanent dedup guard (D-04)
  activity              one readable row per event, _id = eventId (idempotent append); the feed for GET …/activity
  project_projections   one doc per project: identity, owning team, columns, workload counters, freshness
  item_projections      one doc per work item: latest snapshot + aggregate version (latest version wins)
  team_projections      one doc per team: roster {userId: {name, role}}
  processing_failures   durable quarantine/dead-letter records for messages the consumer gave up on

Everything a successful event produces (inbox + activity + projections) is written in ONE Atlas transaction;
the caller acknowledges the message only after that transaction committed.
A "projection set" suffix (PROJECTION_SET) renames every collection, which is how replay builds a clean set
next to the live one without touching it (app/replay.py).
No TTL on inbox or failures: they are needed for replay/dedup, not operational noise.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pymongo import ASCENDING, DESCENDING, AsyncMongoClient, IndexModel
from pymongo.asynchronous.database import AsyncDatabase
from pymongo.errors import DuplicateKeyError
from ulid import ULID

from app.reducers import apply_deltas, empty_workload, is_stale, item_deltas, item_snapshot

ApplyResult = Literal["applied", "duplicate"]


@dataclass(frozen=True)
class DeliveryMeta:
    consumer: str
    subject: str
    stream_seq: int
    num_delivered: int
    correlation_id: str | None


@dataclass(frozen=True)
class FailureRecord:
    consumer: str
    subject: str
    stream_seq: int
    num_delivered: int
    classification: str  # malformed | unsupported_schema | unknown_event_type | exhausted
    errors: list[str]
    event_id: str | None
    correlation_id: str | None
    raw_preview: str


class Store(Protocol):
    async def apply(self, event: dict[str, Any], meta: DeliveryMeta) -> ApplyResult: ...
    async def record_failure(self, failure: FailureRecord) -> None: ...


# ---- activity summaries -------------------------------------------------------------------------------


def _item(p: dict[str, Any]) -> dict[str, Any]:
    return p.get("item") or {}


def summarize(event: dict[str, Any]) -> str:
    """Human-readable one-liner for the activity feed; the structured fields stay alongside it."""
    t, p = event["eventType"], event["payload"]
    i = _item(p)
    match t:
        case "team.created":
            return f"created team {p['name']} ({p['code']})"
        case "team.updated":
            return f"updated team {p['name']}"
        case "team.archived":
            return f"archived team {p['name']}"
        case "team.member_added":
            return f"added {p['userName']} to {p['teamName']} as {p['role']}"
        case "team.member_removed":
            return f"removed {p['userName']} from {p['teamName']}"
        case "team.member_role_changed":
            return f"changed {p['userName']}'s role in {p['teamName']} from {p['previousRole']} to {p['role']}"
        case "project.created":
            return f"created project {p['name']} ({p['projectKey']})"
        case "project.updated":
            return f"updated project {p['name']} ({', '.join(p.get('changedFields', []))})"
        case "project.team_assigned":
            return f"assigned project {p['projectKey']} to team {p['teamId']}"
        case "board.created":
            return f"created board with {len(p['columns'])} columns"
        case "board.columns_updated":
            return f"reconfigured board columns ({', '.join(c['name'] for c in p['columns'])})"
        case "workitem.created":
            return f"created {i['issueKey']} \"{i['title']}\""
        case "workitem.assigned":
            return f"{'assigned' if i.get('assigneeId') else 'unassigned'} {i['issueKey']}" + (f" to {i['assigneeId']}" if i.get("assigneeId") else "")
        case "workitem.moved":
            return f"moved {i['issueKey']} from {p['fromColumnId']} to {p['toColumnId']}"
        case "workitem.updated":
            return f"edited {i['issueKey']} ({', '.join(p.get('changedFields', []))})"
        case "workitem.archived":
            return f"archived {i['issueKey']}"
    return t


def activity_doc(event: dict[str, Any], meta: DeliveryMeta, now: datetime) -> dict[str, Any]:
    p = event["payload"]
    i = _item(p)
    agg = event["aggregate"]
    return {
        "_id": event["eventId"],  # idempotent: the same event can never create two feed rows
        "workspaceId": event["workspaceId"],
        "projectId": i.get("projectId") or p.get("projectId"),
        "teamId": p.get("teamId") if agg["type"] == "Team" else None,
        "eventType": event["eventType"],
        "aggregate": agg,
        "actorId": event["actorId"],
        "occurredAt": datetime.fromisoformat(event["occurredAt"].replace("Z", "+00:00")),
        "summary": summarize(event),
        "item": {"itemId": i["itemId"], "issueKey": i["issueKey"], "title": i["title"]} if i else None,
        "correlationId": event["correlationId"],
        "streamSeq": meta.stream_seq,
        "recordedAt": now,
    }


# ---- MongoDB store ---------------------------------------------------------------------------------------


class MongoStore:
    def __init__(self, client: AsyncMongoClient, db: AsyncDatabase, projection_set: str = ""):
        self.client = client
        self.db = db
        self.projection_set = projection_set
        self.inbox = db["inbox" + projection_set]
        self.activity = db["activity" + projection_set]
        self.projects = db["project_projections" + projection_set]
        self.items = db["item_projections" + projection_set]
        self.teams = db["team_projections" + projection_set]
        self.failures = db["processing_failures" + projection_set]

    @property
    def collections(self) -> list:
        return [self.inbox, self.activity, self.projects, self.items, self.teams, self.failures]

    async def ensure_indexes(self) -> None:
        await self.inbox.create_indexes([
            IndexModel([("eventId", ASCENDING), ("consumer", ASCENDING)], name="uniq_event_consumer", unique=True),
            IndexModel([("consumer", ASCENDING), ("streamSeq", DESCENDING)], name="by_consumer_seq"),
        ])
        await self.activity.create_indexes([
            IndexModel([("workspaceId", ASCENDING), ("projectId", ASCENDING), ("occurredAt", DESCENDING), ("_id", DESCENDING)], name="feed_by_project"),
            IndexModel([("workspaceId", ASCENDING), ("teamId", ASCENDING), ("occurredAt", DESCENDING)], name="feed_by_team"),
        ])
        await self.failures.create_indexes([
            IndexModel([("consumer", ASCENDING), ("resolvedAt", ASCENDING), ("recordedAt", DESCENDING)], name="open_failures"),
        ])
        await self.projects.create_indexes([IndexModel([("workspaceId", ASCENDING), ("teamId", ASCENDING)], name="by_team")])
        await self.items.create_indexes([
            IndexModel([("workspaceId", ASCENDING), ("projectId", ASCENDING), ("archived", ASCENDING), ("assigneeId", ASCENDING)], name="by_project_assignee"),
        ])
        await self.teams.create_indexes([IndexModel([("workspaceId", ASCENDING)], name="by_workspace")])
        await _ensure_validator(self.db, self.inbox.name, {"bsonType": "object", "required": ["eventId", "consumer", "streamSeq", "receivedAt", "result"],
                                                           "properties": {"eventId": {"bsonType": "string"}, "consumer": {"bsonType": "string"}, "streamSeq": {"bsonType": ["int", "long"]}}})
        await _ensure_validator(self.db, self.projects.name, {"bsonType": "object", "required": ["workspaceId", "projectId", "workload"],
                                                              "properties": {"workload": {"bsonType": "object", "required": ["totalActive", "byColumn", "byPriority", "byAssignee"]}}})

    async def apply(self, event: dict[str, Any], meta: DeliveryMeta) -> ApplyResult:
        """
        One transaction: inbox row + activity row (+ phase-5 projections). The unique inbox index makes a
        concurrent or later duplicate abort with DuplicateKeyError (or WriteConflict while the first
        transaction is still open, which the caller retries and then sees as a duplicate).
        """
        now = datetime.now(UTC)
        inbox_row = {
            "_id": str(ULID()), "eventId": event["eventId"], "consumer": meta.consumer, "subject": meta.subject,
            "streamSeq": meta.stream_seq, "numDelivered": meta.num_delivered, "correlationId": meta.correlation_id,
            "receivedAt": now, "processedAt": None, "result": "processing",
        }
        async with self.client.start_session() as session:
            try:
                async with await session.start_transaction(max_commit_time_ms=10_000):
                    await self.inbox.insert_one(inbox_row, session=session)
                    await self.activity.replace_one({"_id": event["eventId"]}, activity_doc(event, meta, now), upsert=True, session=session)
                    result = await self._project(event, meta, session)
                    await self.inbox.update_one({"_id": inbox_row["_id"]}, {"$set": {"processedAt": datetime.now(UTC), "result": result}}, session=session)
            except DuplicateKeyError:
                return "duplicate"
        return "applied"

    # ---- reducers (run inside the transaction) ---------------------------------------------------------

    async def _project(self, event: dict[str, Any], meta: DeliveryMeta, session) -> str:
        """Dispatch by aggregate type. Returns 'applied' or 'applied_stale' (history kept, state untouched)."""
        agg = event["aggregate"]["type"]
        if agg == "WorkItem":
            return await self._reduce_item(event, meta, session)
        if agg == "Project":
            return await self._reduce_project(event, meta, session)
        if agg == "Board":
            return await self._reduce_board(event, meta, session)
        if agg == "Team":
            return await self._reduce_team(event, meta, session)
        return "applied"

    def _touch(self, event: dict[str, Any], meta: DeliveryMeta) -> dict[str, Any]:
        return {"lastEventId": event["eventId"], "lastEventOccurredAt": event["occurredAt"], "lastStreamSeq": meta.stream_seq, "updatedAt": datetime.now(UTC)}

    async def _ensure_project(self, workspace_id: str, project_id: str, session) -> dict[str, Any]:
        """Projects can receive item/board events before project.created (out-of-order): create a shell with zero counts."""
        doc = await self.projects.find_one({"_id": project_id, "workspaceId": workspace_id}, session=session)
        if doc is None:
            doc = {"_id": project_id, "workspaceId": workspace_id, "projectId": project_id, "projectKey": None, "name": None, "status": None,
                   "teamId": None, "ownerId": None, "columns": [], "projectVersion": 0, "boardVersion": 0, "workload": empty_workload(),
                   "lastEventId": None, "lastEventOccurredAt": None, "lastStreamSeq": None, "createdAt": datetime.now(UTC), "updatedAt": datetime.now(UTC)}
            await self.projects.insert_one(doc, session=session)
        return doc

    async def _reduce_item(self, event: dict[str, Any], meta: DeliveryMeta, session) -> str:
        new = item_snapshot(event)
        old = await self.items.find_one({"_id": new["_id"], "workspaceId": new["workspaceId"]}, session=session)
        if old is not None and is_stale(old.get("version"), new["version"]):
            return "applied_stale"
        project = await self._ensure_project(new["workspaceId"], new["projectId"], session)
        workload = apply_deltas(project["workload"], item_deltas(old, new))
        await self.items.replace_one({"_id": new["_id"]}, new, upsert=True, session=session)
        await self.projects.update_one({"_id": project["_id"]}, {"$set": {"workload": workload, **self._touch(event, meta)}}, session=session)
        return "applied"

    async def _reduce_project(self, event: dict[str, Any], meta: DeliveryMeta, session) -> str:
        p, v = event["payload"], event["aggregate"]["version"]
        project = await self._ensure_project(event["workspaceId"], p["projectId"], session)
        if is_stale(project.get("projectVersion") or None, v):
            return "applied_stale"
        fields: dict[str, Any] = {"projectVersion": v, **self._touch(event, meta)}
        for k in ("projectKey", "name", "status", "teamId", "ownerId"):
            if k in p:
                fields[k] = p[k]
        await self.projects.update_one({"_id": project["_id"]}, {"$set": fields}, session=session)
        return "applied"

    async def _reduce_board(self, event: dict[str, Any], meta: DeliveryMeta, session) -> str:
        p, v = event["payload"], event["aggregate"]["version"]
        project = await self._ensure_project(event["workspaceId"], p["projectId"], session)
        if is_stale(project.get("boardVersion") or None, v):
            return "applied_stale"
        columns = sorted(p["columns"], key=lambda c: c["order"])
        await self.projects.update_one({"_id": project["_id"]}, {"$set": {"boardId": p["boardId"], "columns": columns, "boardVersion": v, **self._touch(event, meta)}}, session=session)
        return "applied"

    async def _reduce_team(self, event: dict[str, Any], meta: DeliveryMeta, session) -> str:
        p, v, t = event["payload"], event["aggregate"]["version"], event["eventType"]
        team = await self.teams.find_one({"_id": p["teamId"], "workspaceId": event["workspaceId"]}, session=session)
        if team is None:
            team = {"_id": p["teamId"], "workspaceId": event["workspaceId"], "name": None, "code": None, "archived": False, "members": {}, "teamVersion": 0}
            await self.teams.insert_one(team, session=session)
        if is_stale(team.get("teamVersion") or None, v):
            return "applied_stale"
        set_: dict[str, Any] = {"teamVersion": v, **self._touch(event, meta)}
        unset: dict[str, Any] = {}
        if t in ("team.created", "team.updated", "team.archived"):
            set_.update({"name": p["name"], "code": p["code"], "archived": t == "team.archived"})
        elif t in ("team.member_added", "team.member_role_changed"):
            set_[f"members.{p['userId']}"] = {"name": p["userName"], "role": p["role"]}
            set_["name"] = p["teamName"]
        elif t == "team.member_removed":
            unset[f"members.{p['userId']}"] = ""
        update: dict[str, Any] = {"$set": set_}
        if unset:
            update["$unset"] = unset
        await self.teams.update_one({"_id": team["_id"]}, update, session=session)
        return "applied"

    # ---- query reads -----------------------------------------------------------------------------------

    async def project(self, workspace_id: str, project_id: str) -> dict[str, Any] | None:
        return await self.projects.find_one({"_id": project_id, "workspaceId": workspace_id})

    async def activity_page(self, workspace_id: str, project_id: str, limit: int, cursor: str | None) -> list[dict[str, Any]]:
        """Newest first, keyset on _id (= eventId, a time-ordered ULID). Returns limit+1 rows so the caller knows if more exist."""
        f: dict[str, Any] = {"workspaceId": workspace_id, "projectId": project_id}
        if cursor:
            f["_id"] = {"$lt": cursor}
        return await self.activity.find(f).sort("_id", DESCENDING).limit(limit + 1).to_list()

    async def team(self, workspace_id: str, team_id: str) -> dict[str, Any] | None:
        return await self.teams.find_one({"_id": team_id, "workspaceId": workspace_id})

    async def record_failure(self, f: FailureRecord) -> None:
        """Idempotent per (consumer, stream sequence) so a redelivered poison message updates its own record."""
        await self.failures.update_one(
            {"_id": f"{f.consumer}:{f.stream_seq}"},
            {
                "$set": {
                    "consumer": f.consumer, "subject": f.subject, "streamSeq": f.stream_seq, "numDelivered": f.num_delivered,
                    "classification": f.classification, "errors": f.errors[:20], "eventId": f.event_id,
                    "correlationId": f.correlation_id, "rawPreview": f.raw_preview[:2000], "lastSeenAt": datetime.now(UTC),
                },
                "$setOnInsert": {"recordedAt": datetime.now(UTC), "resolvedAt": None},
            },
            upsert=True,
        )

    async def open_failures(self, consumer: str) -> int:
        return await self.failures.count_documents({"consumer": consumer, "resolvedAt": None})


async def _ensure_validator(db: AsyncDatabase, name: str, schema: dict[str, Any]) -> None:
    """Collection validation where practical (PDF §11); moderate level so existing docs are not re-checked."""
    try:
        if name in await db.list_collection_names(filter={"name": name}):
            await db.command({"collMod": name, "validator": {"$jsonSchema": schema}, "validationLevel": "moderate"})
        else:
            await db.create_collection(name, validator={"$jsonSchema": schema}, validationLevel="moderate")
    except Exception:  # a concurrent creator or restricted privileges must not stop the service
        pass
