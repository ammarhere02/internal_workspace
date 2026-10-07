"""Event factory for tests: builds contract-valid envelopes the way the NestJS producer does."""

from datetime import UTC, datetime, timedelta
from typing import Any

from ulid import ULID

WS = "ws_test"


def envelope(event_type: str, agg_type: str, agg_id: str, version: int, payload: dict[str, Any], *, at: datetime | None = None, actor="usr_test", corr="req_test") -> dict[str, Any]:
    return {
        "eventId": str(ULID()), "eventType": event_type, "schemaVersion": 1,
        "occurredAt": (at or datetime.now(UTC)).isoformat().replace("+00:00", "Z"), "producer": "management-service",
        "workspaceId": WS, "aggregate": {"type": agg_type, "id": agg_id, "version": version},
        "correlationId": corr, "causationId": "cmd_test", "actorId": actor, "payload": payload,
    }


def item_state(item_id="wi_1", key="PAY-1", project_id="prj_1", column="backlog", priority="MEDIUM", assignee=None, archived=False, title="Refund endpoint", **extra) -> dict[str, Any]:
    return {"itemId": item_id, "issueKey": key, "projectId": project_id, "boardId": "brd_1", "columnId": column, "rank": "n", "type": "TASK",
            "priority": priority, "title": title, "reporterId": "usr_test", "assigneeId": assignee, "labels": [], "dueDate": None, "archived": archived, **extra}


class Journey:
    """A deterministic project story with monotonically increasing timestamps."""

    def __init__(self, project_id="prj_1", key="PAY"):
        self.project_id, self.key = project_id, key
        self.t = datetime(2026, 10, 7, 9, 0, tzinfo=UTC)

    def _at(self):
        self.t += timedelta(seconds=1)
        return self.t

    def project_created(self, version=1):
        return envelope("project.created", "Project", self.project_id, version, {"projectId": self.project_id, "projectKey": self.key, "name": "Payments", "teamId": "team_1", "ownerId": "usr_blake", "status": "ACTIVE"}, at=self._at())

    def board_created(self):
        cols = [{"columnId": c, "name": c.title(), "order": i, "wipLimit": None} for i, c in enumerate(["backlog", "todo", "in_progress", "review", "done"])]
        return envelope("board.created", "Board", "brd_1", 1, {"boardId": "brd_1", "projectId": self.project_id, "columns": cols}, at=self._at())

    def item(self, event_type: str, version: int, state: dict[str, Any], **payload_extra):
        return envelope(event_type, "WorkItem", state["itemId"], version, {"item": state, **payload_extra}, at=self._at())

    def team_assigned(self, version, team_id, previous):
        return envelope("project.team_assigned", "Project", self.project_id, version, {"projectId": self.project_id, "projectKey": self.key, "teamId": team_id, "previousTeamId": previous}, at=self._at())
