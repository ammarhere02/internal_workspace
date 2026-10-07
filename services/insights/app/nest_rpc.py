"""
Wire format of the NestJS NATS transport (ClientNats, @nestjs/microservices 12):
  request : {"pattern": "<subject>", "data": {...}, "id": "<packet id>"}  with a reply inbox
  response: {"id": "<same id>", "response": {...}, "isDisposed": true}
  error   : {"id": "<same id>", "err": {...}, "isDisposed": true}
Verified against node_modules/@nestjs/microservices/{serializers,deserializers}.
"""

import json
from dataclasses import dataclass
from typing import Any


class BadRequestPacket(ValueError):
    pass


@dataclass
class NestRequest:
    id: str | None
    pattern: str | None
    data: Any


def parse_request(raw: bytes) -> NestRequest:
    try:
        packet = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as e:
        raise BadRequestPacket(f"request is not JSON: {e}") from e
    if not isinstance(packet, dict):
        raise BadRequestPacket("request packet is not an object")
    return NestRequest(id=packet.get("id"), pattern=packet.get("pattern"), data=packet.get("data"))


def reply(request_id: str | None, response: Any) -> bytes:
    return json.dumps({"id": request_id, "response": response, "isDisposed": True}).encode()


def error_reply(request_id: str | None, code: str, message: str) -> bytes:
    return json.dumps({"id": request_id, "err": {"code": code, "message": message}, "isDisposed": True}).encode()
