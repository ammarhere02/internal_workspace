"""Core NATS request/reply responder for tm.query.v1.* subjects (synchronous insight queries)."""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

from nats.aio.client import Client as NATS
from nats.aio.msg import Msg

from app import nest_rpc
from app.logging import get_logger

log = get_logger("query")
Handler = Callable[[Any, str | None], Awaitable[Any]]  # (data, correlationId) -> response dict


class QueryError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


async def serve(nc: NATS, subject: str, handler: Handler, *, queue: str = "insights", handler_timeout_s: float = 2.0):
    """
    queue group: several Python replicas can share a subject and NATS picks one responder per request.
    handler_timeout_s bounds our own work so a stuck Mongo call cannot hold the requester past its deadline.
    """

    async def on_msg(msg: Msg):
        request_id = None
        try:
            req = nest_rpc.parse_request(msg.data)
            request_id = req.id
            corr = (msg.headers or {}).get("x-correlation-id") or (req.data or {}).get("correlationId") if isinstance(req.data, dict) else None
            response = await asyncio.wait_for(handler(req.data, corr), timeout=handler_timeout_s)
            await msg.respond(nest_rpc.reply(request_id, response))
            log.info("query.answered", subject=subject, correlationId=corr, status=response.get("status") if isinstance(response, dict) else None)
        except nest_rpc.BadRequestPacket as e:
            await msg.respond(nest_rpc.error_reply(request_id, "bad_request", str(e)))
        except QueryError as e:
            await msg.respond(nest_rpc.error_reply(request_id, e.code, str(e)))
        except TimeoutError:
            await msg.respond(nest_rpc.error_reply(request_id, "timeout", "insights handler timed out"))
        except Exception as e:  # never leave the requester hanging; never leak internals
            log.error("query.failed", subject=subject, error=type(e).__name__)
            await msg.respond(nest_rpc.error_reply(request_id, "internal", "insights query failed"))

    sub = await nc.subscribe(subject, queue=queue, cb=on_msg)
    await nc.flush()  # make sure the server knows about the subscription before anyone sends
    return sub
