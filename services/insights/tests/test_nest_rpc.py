import json

import pytest

from app import nest_rpc
from app.consumer import retry_delay_s


def test_parse_nest_packet():
    req = nest_rpc.parse_request(json.dumps({"pattern": "tm.query.v1.project_insights", "data": {"projectId": "p1"}, "id": "abc"}).encode())
    assert req.id == "abc" and req.pattern == "tm.query.v1.project_insights" and req.data == {"projectId": "p1"}


def test_reply_shapes_match_nest_deserializer():
    assert json.loads(nest_rpc.reply("abc", {"x": 1})) == {"id": "abc", "response": {"x": 1}, "isDisposed": True}
    err = json.loads(nest_rpc.error_reply("abc", "not_found", "no"))
    assert err["id"] == "abc" and err["err"]["code"] == "not_found" and err["isDisposed"] is True


def test_bad_packet():
    with pytest.raises(nest_rpc.BadRequestPacket):
        nest_rpc.parse_request(b"\xff not json")
    with pytest.raises(nest_rpc.BadRequestPacket):
        nest_rpc.parse_request(b"[1,2]")


def test_backoff_is_bounded():
    assert [retry_delay_s(n) for n in (1, 2, 3, 4, 5, 6, 10)] == [1, 2, 4, 8, 16, 30, 30]
