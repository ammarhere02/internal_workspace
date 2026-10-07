"""
Typed query contracts (Pydantic) for the Core NATS request/reply subjects. The JSON Schemas in
/contracts/schemas/queries are the cross-language source of truth; these models mirror them and
produce replies with exactly the documented shape (tests validate model output against the schema).
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.reducers import workload_view


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class InsightsRequest(Strict):
    workspaceId: str = Field(min_length=1)
    projectId: str = Field(min_length=1)
    correlationId: str = Field(min_length=1)


class ActivityRequest(InsightsRequest):
    limit: int = Field(default=25, ge=1, le=100)
    cursor: str | None = None


class Freshness(Strict):
    lastProcessedAt: str | None
    lastStreamSeq: int | None
    lastEventOccurredAt: str | None
    processingAgeMs: int | None


class AssigneeWorkload(Strict):
    assigneeId: str | None
    total: int = Field(ge=0)
    byColumn: dict[str, int]


class Workload(Strict):
    totalActive: int = Field(ge=0)
    byColumn: dict[str, int]
    byPriority: dict[str, int]
    byAssignee: list[AssigneeWorkload]


class QueryErrorBody(Strict):
    code: str
    message: str


class InsightsResponse(Strict):
    status: Literal["ready", "not_ready", "error"]
    projectId: str
    correlationId: str
    freshness: Freshness
    workload: Workload | None = None
    error: QueryErrorBody | None = None


class ActivityItem(Strict):
    eventId: str
    eventType: str
    actorId: str
    occurredAt: str
    summary: str
    aggregate: dict[str, Any]
    item: dict[str, Any] | None
    correlationId: str


class ActivityResponse(Strict):
    status: Literal["ready", "not_ready", "error"]
    projectId: str
    correlationId: str
    freshness: Freshness
    items: list[ActivityItem] | None = None
    nextCursor: str | None = None
    error: QueryErrorBody | None = None


def dump(model: BaseModel) -> dict[str, Any]:
    return model.model_dump(exclude_unset=True)  # optional sections appear only when set; explicit nulls (nextCursor, freshness fields) are kept


class QueryHandlers:
    """Answers both query subjects from the projection store. Never raises for a bad request: replies status=error."""

    def __init__(self, store, state):
        self.store, self.state = store, state

    def _freshness(self, project: dict[str, Any] | None) -> Freshness:
        return Freshness(
            lastProcessedAt=self.state.last_success_at.isoformat() if self.state.last_success_at else None,
            lastStreamSeq=(project or {}).get("lastStreamSeq"),
            lastEventOccurredAt=(project or {}).get("lastEventOccurredAt"),
            processingAgeMs=self.state.processing_age_ms(),
        )

    @staticmethod
    def _bad(model, data: Any, correlation_id: str | None, e: ValidationError) -> dict[str, Any]:
        pid = data.get("projectId", "") if isinstance(data, dict) else ""
        return dump(model(status="error", projectId=str(pid or ""), correlationId=str(correlation_id or ""),
                          freshness=Freshness(lastProcessedAt=None, lastStreamSeq=None, lastEventOccurredAt=None, processingAgeMs=None),
                          error=QueryErrorBody(code="bad_request", message=f"invalid request: {e.error_count()} error(s)")))

    async def insights(self, data: Any, correlation_id: str | None) -> dict[str, Any]:
        try:
            req = InsightsRequest.model_validate(data)
        except ValidationError as e:
            return self._bad(InsightsResponse, data, correlation_id, e)
        try:
            project = await self.store.project(req.workspaceId, req.projectId)
        except Exception as e:  # store down: typed error, the BFF shows "temporarily unavailable"
            return dump(InsightsResponse(status="error", projectId=req.projectId, correlationId=req.correlationId, freshness=self._freshness(None),
                                         error=QueryErrorBody(code="unavailable", message=f"projection store unavailable: {type(e).__name__}")))
        if project is None:
            return dump(InsightsResponse(status="not_ready", projectId=req.projectId, correlationId=req.correlationId, freshness=self._freshness(None)))
        return dump(InsightsResponse(status="ready", projectId=req.projectId, correlationId=req.correlationId, freshness=self._freshness(project),
                                     workload=Workload.model_validate(workload_view(project.get("workload") or {}))))

    async def activity(self, data: Any, correlation_id: str | None) -> dict[str, Any]:
        try:
            req = ActivityRequest.model_validate(data)
        except ValidationError as e:
            return self._bad(ActivityResponse, data, correlation_id, e)
        try:
            project = await self.store.project(req.workspaceId, req.projectId)
            rows = await self.store.activity_page(req.workspaceId, req.projectId, req.limit, req.cursor)
        except Exception as e:
            return dump(ActivityResponse(status="error", projectId=req.projectId, correlationId=req.correlationId, freshness=self._freshness(None),
                                         error=QueryErrorBody(code="unavailable", message=f"projection store unavailable: {type(e).__name__}")))
        if project is None and not rows:
            return dump(ActivityResponse(status="not_ready", projectId=req.projectId, correlationId=req.correlationId, freshness=self._freshness(None)))
        items = [ActivityItem(eventId=r["_id"], eventType=r["eventType"], actorId=r["actorId"], occurredAt=r["occurredAt"].isoformat().replace("+00:00", "Z"),
                              summary=r["summary"], aggregate=r["aggregate"], item=r.get("item"), correlationId=r["correlationId"]) for r in rows[: req.limit]]
        next_cursor = items[-1].eventId if len(rows) > req.limit else None
        return dump(ActivityResponse(status="ready", projectId=req.projectId, correlationId=req.correlationId, freshness=self._freshness(project),
                                     items=items, nextCursor=next_cursor))
