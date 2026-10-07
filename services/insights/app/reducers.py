"""
Pure projection reducers (no I/O) — decisions D-05: every workitem.* event carries the FULL post-event
item state plus the aggregate version, so the projection is "latest version wins":

  * an event whose aggregate.version is <= the stored version is STALE: it changes no counts and no
    item state (but its activity row is still recorded, history is never erased)
  * a duplicate is just the stale case with equal version: it changes nothing
  * counts are updated from the DIFFERENCE between the previous item snapshot and the new one, so a
    reassignment moves exactly one unit from the old assignee to the new one, in one step

Workload document shape (one per project):
  { totalActive, byColumn: {col: n}, byPriority: {prio: n}, byAssignee: {key: {total, byColumn: {col: n}}} }
  key = assigneeId or UNASSIGNED.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

UNASSIGNED = "unassigned"


def assignee_key(assignee_id: str | None) -> str:
    return assignee_id or UNASSIGNED


def empty_workload() -> dict[str, Any]:
    return {"totalActive": 0, "byColumn": {}, "byPriority": {}, "byAssignee": {}}


@dataclass(frozen=True)
class Delta:
    """One unit added (+1) or removed (-1) from the counters of (column, priority, assignee)."""
    sign: int
    column_id: str
    priority: str
    assignee_id: str | None


def item_deltas(old: dict[str, Any] | None, new: dict[str, Any]) -> list[Delta]:
    """Counter movements caused by replacing snapshot `old` with `new`. Archived items count nowhere."""
    deltas: list[Delta] = []
    if old and not old.get("archived"):
        deltas.append(Delta(-1, old["columnId"], old["priority"], old.get("assigneeId")))
    if not new.get("archived"):
        deltas.append(Delta(+1, new["columnId"], new["priority"], new.get("assigneeId")))
    # a no-op pair (same column/priority/assignee) cancels out: nothing to write
    if len(deltas) == 2 and (deltas[0].column_id, deltas[0].priority, deltas[0].assignee_id) == (deltas[1].column_id, deltas[1].priority, deltas[1].assignee_id):
        return []
    return deltas


def _bump(d: dict[str, int], key: str, n: int) -> None:
    v = d.get(key, 0) + n
    if v < 0:
        raise ValueError(f"counter {key} would go negative ({v}); projection is corrupt, rebuild it")
    if v == 0:
        d.pop(key, None)
    else:
        d[key] = v


def apply_deltas(workload: dict[str, Any], deltas: list[Delta]) -> dict[str, Any]:
    """Returns the updated workload (mutates and returns the same dict for convenience)."""
    for d in deltas:
        workload["totalActive"] = workload.get("totalActive", 0) + d.sign
        _bump(workload.setdefault("byColumn", {}), d.column_id, d.sign)
        _bump(workload.setdefault("byPriority", {}), d.priority, d.sign)
        by_assignee = workload.setdefault("byAssignee", {})
        a = by_assignee.setdefault(assignee_key(d.assignee_id), {"total": 0, "byColumn": {}})
        a["total"] += d.sign
        _bump(a["byColumn"], d.column_id, d.sign)
        if a["total"] == 0:
            by_assignee.pop(assignee_key(d.assignee_id), None)
    if workload["totalActive"] < 0:
        raise ValueError("totalActive negative; projection is corrupt, rebuild it")
    return workload


def is_stale(stored_version: int | None, incoming_version: int) -> bool:
    return stored_version is not None and incoming_version <= stored_version


def item_snapshot(event: dict[str, Any]) -> dict[str, Any]:
    """The projected item row: the event's full item state + the aggregate version that produced it."""
    i = event["payload"]["item"]
    return {
        "_id": i["itemId"], "workspaceId": event["workspaceId"], "projectId": i["projectId"], "issueKey": i["issueKey"],
        "columnId": i["columnId"], "priority": i["priority"], "type": i["type"], "title": i["title"], "assigneeId": i.get("assigneeId"),
        "reporterId": i["reporterId"], "labels": i.get("labels", []), "dueDate": i.get("dueDate"), "rank": i["rank"],
        "archived": bool(i.get("archived")), "version": event["aggregate"]["version"], "lastEventId": event["eventId"],
        "lastEventType": event["eventType"], "lastEventAt": event["occurredAt"],
    }


def workload_view(workload: dict[str, Any]) -> dict[str, Any]:
    """Contract shape (project_insights.response.schema.json): byAssignee as a list, null for unassigned."""
    return {
        "totalActive": workload.get("totalActive", 0),
        "byColumn": dict(workload.get("byColumn", {})),
        "byPriority": dict(workload.get("byPriority", {})),
        "byAssignee": sorted(
            ({"assigneeId": None if k == UNASSIGNED else k, "total": v["total"], "byColumn": dict(v["byColumn"])} for k, v in workload.get("byAssignee", {}).items()),
            key=lambda a: (-a["total"], a["assigneeId"] is None, a["assigneeId"] or ""),  # busiest first, unassigned last on ties
        ),
    }


def rebuild_workload(items: list[dict[str, Any]]) -> dict[str, Any]:
    """Recompute counters from item snapshots (used by tests and the consistency check in replay)."""
    w = empty_workload()
    for i in items:
        apply_deltas(w, item_deltas(None, i))
    return w
