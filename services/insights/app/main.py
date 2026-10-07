"""
Entry point: connect, bootstrap stream + durable consumer, run the event handler loop (phase 4),
serve health and the insights responder (phase 5 fills in the real answer).
"""

import asyncio
import signal

import uvicorn

from app import consumer, mongo, nats_client
from app.contracts import ContractValidator
from app.handler import EventHandler
from app.projections import MongoStore
from app.health import build_app
from app.logging import configure_logging, get_logger
from app.queries import QueryHandlers
from app.query_responder import serve
from app.settings import ACTIVITY_QUERY_SUBJECT, INSIGHTS_QUERY_SUBJECT, STREAM_NAME, Settings
from app.state import ConsumerState


class Deps:
    def __init__(self, nc, db, state, store=None, js=None, consumer_name=None):
        self.nc, self.db, self.state, self.store, self.js, self.consumer_name = nc, db, state, store, js, consumer_name

    def nats_connected(self) -> bool:
        return self.nc.is_connected

    async def mongo_ping(self) -> bool:
        return await mongo.ping(self.db)

    async def consumer_lag(self) -> dict | None:
        """Broker-side view: how far behind the durable consumer is (PDF §10/§13)."""
        if self.js is None:
            return None
        try:
            info = await self.js.consumer_info(STREAM_NAME, self.consumer_name)
            return {"pending": info.num_pending, "ackPending": info.num_ack_pending, "redelivered": info.num_redelivered,
                    "streamSeqDelivered": info.delivered.stream_seq, "streamSeqAcked": info.ack_floor.stream_seq}
        except Exception:
            return None


async def main() -> None:
    settings = Settings()
    configure_logging(settings.log_level)
    log = get_logger("main")
    state = ConsumerState()

    client = mongo.make_client(settings)
    db = mongo.owned_db(client, settings)
    nc = await nats_client.connect(settings.nats_url)
    js = nc.jetstream()
    await nats_client.ensure_stream(js)
    psub = await nats_client.ensure_consumer(js, durable=settings.consumer_name, max_deliver=settings.consumer_max_deliver, ack_wait_s=settings.consumer_ack_wait_s)
    store = MongoStore(client, db, settings.projection_set)
    await store.ensure_indexes()
    log.info("bootstrap.done", stream=STREAM_NAME, consumer=settings.consumer_name, projectionSet=settings.projection_set or "(live)", mongo_ready=await mongo.ping(db))

    queries = QueryHandlers(store, state)
    await serve(nc, INSIGHTS_QUERY_SUBJECT, queries.insights, handler_timeout_s=settings.query_timeout_s)
    await serve(nc, ACTIVITY_QUERY_SUBJECT, queries.activity, handler_timeout_s=settings.query_timeout_s)
    handler = EventHandler(ContractValidator(settings.contracts_path()), store, state,
                           consumer=settings.consumer_name, max_deliver=settings.consumer_max_deliver)
    stop = asyncio.Event()
    consumer_task = asyncio.create_task(consumer.run(psub, handler.handle, state, stop, batch=settings.consumer_batch))

    deps = Deps(nc, db, state, store, js, settings.consumer_name)
    server = uvicorn.Server(uvicorn.Config(build_app(deps), host="0.0.0.0", port=settings.health_port, log_level="warning"))
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    http_task = asyncio.create_task(server.serve())
    await stop.wait()
    log.info("shutdown.begin")
    server.should_exit = True
    await asyncio.gather(http_task, consumer_task)  # the loop finishes its current batch (ack after commit) before we drain
    await nc.drain()
    await client.close()
    log.info("shutdown.done")


if __name__ == "__main__":
    asyncio.run(main())
