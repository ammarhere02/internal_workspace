"""Query handlers: typed replies validated against the shared JSON Schemas; bad requests never raise."""

import json
from datetime import UTC, datetime
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from app.queries import QueryHandlers
from app.reducers import empty_workload
from app.state import ConsumerState

Q = Path(__file__).resolve().parents[3] / "contracts" / "schemas" / "queries"
_ins = json.loads((Q / "project_insights.response.schema.json").read_text())
_reg = Registry().with_resource(_ins["$id"], Resource.from_contents(_ins))
INSIGHTS = Draft202012Validator(_ins, registry=_reg, format_checker=FormatChecker())
ACTIVITY = Draft202012Validator(json.loads((Q / "project_activity.response.schema.json").read_text()), registry=_reg, format_checker=FormatChecker())
INS_REQ = Draft202012Validator(json.loads((Q / "project_insights.request.schema.json").read_text()))
ACT_REQ = Draft202012Validator(json.loads((Q / "project_activity.request.schema.json").read_text()))


class FakeStore:
    def __init__(self, project=None, rows=None, down=False):
        self.p, self.rows, self.down = project, rows or [], down

    async def project(self, ws, pid):
        if self.down:
            raise ConnectionError("atlas")
        return self.p if self.p and self.p["workspaceId"] == ws and self.p["_id"] == pid else None

    async def activity_page(self, ws, pid, limit, cursor):
        rows = [r for r in self.rows if r["workspaceId"] == ws and r["projectId"] == pid and (not cursor or r["_id"] < cursor)]
        return sorted(rows, key=lambda r: r["_id"], reverse=True)[: limit + 1]


def project(ws="ws_1"):
    w = empty_workload()
    w.update({"totalActive": 2, "byColumn": {"todo": 2}, "byPriority": {"HIGH": 2}, "byAssignee": {"usr_a": {"total": 1, "byColumn": {"todo": 1}}, "unassigned": {"total": 1, "byColumn": {"todo": 1}}}})
    return {"_id": "prj_1", "workspaceId": ws, "workload": w, "lastStreamSeq": 42, "lastEventOccurredAt": "2026-10-07T09:00:00Z"}


def row(i):
    return {"_id": f"01J9Q3Z8K2V4N6P8R0T2W4Y6{i:02d}", "workspaceId": "ws_1", "projectId": "prj_1", "eventType": "workitem.created", "actorId": "u",
            "occurredAt": datetime(2026, 10, 7, 9, 0, i, tzinfo=UTC), "summary": f"created PAY-{i}", "aggregate": {"type": "WorkItem", "id": f"wi_{i}", "version": 1},
            "item": {"itemId": f"wi_{i}", "issueKey": f"PAY-{i}", "title": "t"}, "correlationId": "req"}


def state_with_progress():
    s = ConsumerState()
    s.mark_success(42)
    return s


async def test_insights_ready_matches_schema_and_carries_correlation_id():
    q = QueryHandlers(FakeStore(project()), state_with_progress())
    req = {"workspaceId": "ws_1", "projectId": "prj_1", "correlationId": "req_9"}
    INS_REQ.validate(req)
    r = await q.insights(req, "req_9")
    INSIGHTS.validate(r)
    assert r["status"] == "ready" and r["correlationId"] == "req_9"
    assert r["workload"]["byAssignee"][0] == {"assigneeId": "usr_a", "total": 1, "byColumn": {"todo": 1}}
    assert r["workload"]["byAssignee"][1]["assigneeId"] is None
    assert r["freshness"]["lastStreamSeq"] == 42 and r["freshness"]["processingAgeMs"] is not None


async def test_insights_not_ready_for_unknown_project_and_for_other_workspace():
    q = QueryHandlers(FakeStore(project()), ConsumerState())
    for ws, pid in (("ws_1", "prj_404"), ("ws_other", "prj_1")):
        r = await q.insights({"workspaceId": ws, "projectId": pid, "correlationId": "c"}, "c")
        INSIGHTS.validate(r)
        assert r["status"] == "not_ready" and "workload" not in r


async def test_insights_bad_request_and_store_down_are_typed_errors():
    r = await QueryHandlers(FakeStore(project()), ConsumerState()).insights({"projectId": "prj_1"}, "c")
    INSIGHTS.validate(r)
    assert r["status"] == "error" and r["error"]["code"] == "bad_request"
    r = await QueryHandlers(FakeStore(project(), down=True), ConsumerState()).insights({"workspaceId": "ws_1", "projectId": "prj_1", "correlationId": "c"}, "c")
    INSIGHTS.validate(r)
    assert r["status"] == "error" and r["error"]["code"] == "unavailable"
    r = await QueryHandlers(FakeStore(project()), ConsumerState()).insights("not a dict", None)
    assert r["status"] == "error"


async def test_activity_pagination_is_keyset_newest_first_and_scoped():
    rows = [row(i) for i in range(1, 8)]
    q = QueryHandlers(FakeStore(project(), rows), state_with_progress())
    req = {"workspaceId": "ws_1", "projectId": "prj_1", "correlationId": "c", "limit": 3}
    ACT_REQ.validate(req)
    page1 = await q.activity(req, "c")
    ACTIVITY.validate(page1)
    assert [i["summary"] for i in page1["items"]] == ["created PAY-7", "created PAY-6", "created PAY-5"]
    assert page1["nextCursor"] == page1["items"][-1]["eventId"]
    page2 = await q.activity({**req, "cursor": page1["nextCursor"]}, "c")
    page3 = await q.activity({**req, "cursor": page2["nextCursor"]}, "c")
    assert [i["summary"] for i in page2["items"]] == ["created PAY-4", "created PAY-3", "created PAY-2"]
    assert [i["summary"] for i in page3["items"]] == ["created PAY-1"] and page3["nextCursor"] is None
    other = await q.activity({**req, "workspaceId": "ws_2"}, "c")
    assert other["status"] == "not_ready" and "items" not in other, "another workspace sees nothing, not even a hint"
    assert (await q.activity({**req, "limit": 1000}, "c"))["status"] == "error"
