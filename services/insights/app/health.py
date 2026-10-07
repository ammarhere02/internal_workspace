from fastapi import FastAPI
from fastapi.responses import JSONResponse

from app.state import ConsumerState


def build_app(deps) -> FastAPI:
    """deps exposes: nats_connected() -> bool, mongo_ping() -> awaitable bool, state: ConsumerState."""
    app = FastAPI(title="insights-service health")

    @app.get("/health/live")
    async def live():  # process-only, no dependency checks
        return {"status": "ok", "service": "insights-service"}

    @app.get("/health/ready")
    async def ready():
        nats_ok = deps.nats_connected()
        mongo_ok = await deps.mongo_ping()
        ok = nats_ok and mongo_ok
        return JSONResponse(status_code=200 if ok else 503, content={
            "status": "ok" if ok else "degraded",
            "checks": {"insights_db": "up" if mongo_ok else "down", "nats": "up" if nats_ok else "down"},
        })

    @app.get("/health/consumer")
    async def consumer():
        state: ConsumerState = deps.state
        store = getattr(deps, "store", None)
        name = getattr(deps, "consumer_name", None) or "activity-insights-v1"
        if store is not None:
            try:
                state.open_failures = await store.open_failures(name)
            except Exception:  # health must answer even when the database is down
                state.open_failures = None
        lag = await deps.consumer_lag() if hasattr(deps, "consumer_lag") else None
        return {"consumer": name, "projectionSet": getattr(store, "projection_set", "") or "(live)", **state.snapshot(), "lag": lag}

    return app
