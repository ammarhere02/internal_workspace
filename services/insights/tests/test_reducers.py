"""Pure reducer tests: the reassignment trace, duplicates, out-of-order, unassign, archive, rebuild equivalence."""

import pytest

from app.reducers import Delta, apply_deltas, empty_workload, is_stale, item_deltas, item_snapshot, rebuild_workload, workload_view
from tests.events import Journey, item_state


def test_create_then_reassign_moves_exactly_one_unit():
    w = empty_workload()
    v1 = item_state(assignee="usr_a", column="todo", priority="HIGH")
    apply_deltas(w, item_deltas(None, v1))
    assert w == {"totalActive": 1, "byColumn": {"todo": 1}, "byPriority": {"HIGH": 1}, "byAssignee": {"usr_a": {"total": 1, "byColumn": {"todo": 1}}}}
    v2 = {**v1, "assigneeId": "usr_b"}
    deltas = item_deltas(v1, v2)
    assert deltas == [Delta(-1, "todo", "HIGH", "usr_a"), Delta(+1, "todo", "HIGH", "usr_b")]
    apply_deltas(w, deltas)
    assert w["byAssignee"] == {"usr_b": {"total": 1, "byColumn": {"todo": 1}}}, "old assignee gone, new assignee has the unit"
    assert w["totalActive"] == 1 and w["byColumn"] == {"todo": 1}


def test_duplicate_or_stale_version_changes_nothing():
    assert is_stale(3, 3) and is_stale(3, 2) and not is_stale(3, 4) and not is_stale(None, 1)
    v1 = item_state(assignee="usr_a")
    assert item_deltas(v1, v1) == [], "the same snapshot twice produces no counter movement"


def test_unassign_and_move():
    w = empty_workload()
    v1 = item_state(assignee="usr_a", column="todo")
    apply_deltas(w, item_deltas(None, v1))
    v2 = {**v1, "assigneeId": None}
    apply_deltas(w, item_deltas(v1, v2))
    assert w["byAssignee"] == {"unassigned": {"total": 1, "byColumn": {"todo": 1}}}
    v3 = {**v2, "columnId": "done"}
    apply_deltas(w, item_deltas(v2, v3))
    assert w["byColumn"] == {"done": 1} and w["byAssignee"]["unassigned"]["byColumn"] == {"done": 1}


def test_archive_removes_from_active_workload():
    w = empty_workload()
    v1 = item_state(assignee="usr_a", priority="LOW")
    apply_deltas(w, item_deltas(None, v1))
    apply_deltas(w, item_deltas(v1, {**v1, "archived": True}))
    assert w == {"totalActive": 0, "byColumn": {}, "byPriority": {}, "byAssignee": {}}
    # un-archive is not a command today, but the reducer handles it symmetrically
    apply_deltas(w, item_deltas({**v1, "archived": True}, v1))
    assert w["totalActive"] == 1


def test_out_of_order_with_latest_version_wins():
    """v3 arrives before v2: the projection takes v3; v2 is stale and ignored; result equals in-order processing."""
    j = Journey()
    v1 = item_state(assignee="usr_a", column="todo")
    v2 = {**v1, "assigneeId": "usr_b"}
    v3 = {**v2, "columnId": "review"}
    stored, w = None, empty_workload()
    for version, state in ((1, v1), (3, v3), (2, v2)):
        snap = item_snapshot(j.item("workitem.updated", version, state))
        if stored is not None and is_stale(stored["version"], snap["version"]):
            continue
        apply_deltas(w, item_deltas(stored, snap))
        stored = snap
    assert stored["version"] == 3 and stored["columnId"] == "review" and stored["assigneeId"] == "usr_b"
    assert workload_view(w) == workload_view(rebuild_workload([stored]))
    assert w["byAssignee"] == {"usr_b": {"total": 1, "byColumn": {"review": 1}}}


def test_counters_never_go_negative():
    with pytest.raises(ValueError):
        apply_deltas(empty_workload(), [Delta(-1, "todo", "LOW", None)])


def test_workload_view_matches_contract_shape():
    w = empty_workload()
    for i, a in enumerate(["usr_a", None, "usr_a"]):
        apply_deltas(w, item_deltas(None, item_state(item_id=f"wi_{i}", assignee=a)))
    view = workload_view(w)
    assert view["totalActive"] == 3
    assert view["byAssignee"] == [{"assigneeId": "usr_a", "total": 2, "byColumn": {"backlog": 2}}, {"assigneeId": None, "total": 1, "byColumn": {"backlog": 1}}]
