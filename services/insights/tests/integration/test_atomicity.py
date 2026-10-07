"""
Phase 7, PDF §14 MongoDB: the projection + inbox write is ONE transaction on the real Atlas insights_db.
  1. a failure inside the projection step rolls back the inbox row too (nothing half-written), and the
     same event applies cleanly afterwards (so a retry after a transient failure works);
  2. the inbox unique index (eventId, consumer) exists and is what makes the second apply a 'duplicate';
  3. the activity collection key is the eventId, so even a bypassed inbox could not create two feed rows.
Cleans up only rows of its own consumer / fictional workspace.
"""

import os

import pytest
from pymongo.errors import DuplicateKeyError

from app import mongo
from app.projections import DeliveryMeta, MongoStore
from app.settings import Settings
from tests.events import envelope

pytestmark = pytest.mark.integration
CONSUMER = "atomicity-test-consumer"
WS = "ws_atomtest"


@pytest.fixture
async def store():
    if not os.environ.get("MONGODB_URI") and not os.path.exists(".env"):
        pytest.skip("needs services/insights/.env (MONGODB_URI)")
    settings = Settings()
    client = mongo.make_client(settings)
    s = MongoStore(client, mongo.owned_db(client, settings))
    await s.ensure_indexes()

    async def clean():
        for c in (s.inbox, s.failures):
            await c.delete_many({"consumer": CONSUMER})
        for c in (s.activity, s.projects, s.items, s.teams):
            await c.delete_many({"workspaceId": WS})
    await clean()
    yield s
    await clean()
    await client.close()


def team_event(n=1):
    e = envelope("team.created", "Team", f"team_atom_{n}", 1, {"teamId": f"team_atom_{n}", "name": "Atom", "code": "ATM"})
    e["workspaceId"] = WS
    return e


async def test_projection_failure_rolls_back_the_inbox_row(store, monkeypatch):
    event = team_event()
    meta = DeliveryMeta(consumer=CONSUMER, subject="tmatom.v1.team.created", stream_seq=1, num_delivered=1, correlation_id="req_atom")

    async def boom(*a, **k):
        raise RuntimeError("simulated projection failure after the inbox insert")
    monkeypatch.setattr(store, "_project", boom)
    with pytest.raises(RuntimeError):
        await store.apply(event, meta)
    assert await store.inbox.find_one({"eventId": event["eventId"], "consumer": CONSUMER}) is None, "inbox insert rolled back"
    assert await store.activity.find_one({"_id": event["eventId"]}) is None, "no activity row"
    monkeypatch.undo()
    assert await store.apply(event, meta) == "applied", "a retry after the transient failure applies cleanly"
    assert await store.apply(event, DeliveryMeta(consumer=CONSUMER, subject="tmatom.v1.team.created", stream_seq=1, num_delivered=2, correlation_id="req_atom")) == "duplicate"
    assert await store.activity.count_documents({"workspaceId": WS}) == 1


async def test_inbox_and_activity_uniqueness_are_index_backed(store):
    idx = await store.inbox.index_information()
    unique = [name for name, spec in idx.items() if spec.get("unique") and [k for k, _ in spec["key"]] == ["eventId", "consumer"]]
    assert unique, f"unique (eventId, consumer) index missing: {list(idx)}"
    event = team_event(2)
    await store.inbox.insert_one({"eventId": event["eventId"], "consumer": CONSUMER, "receivedAt": None, "processedAt": None, "result": "applied", "streamSeq": 1})
    with pytest.raises(DuplicateKeyError):
        await store.inbox.insert_one({"eventId": event["eventId"], "consumer": CONSUMER, "receivedAt": None, "processedAt": None, "result": "applied", "streamSeq": 2})
    await store.activity.insert_one({"_id": event["eventId"], "workspaceId": WS, "eventType": "team.created"})
    with pytest.raises(DuplicateKeyError):
        await store.activity.insert_one({"_id": event["eventId"], "workspaceId": WS, "eventType": "team.created"})
