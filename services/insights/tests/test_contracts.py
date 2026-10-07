import json
from pathlib import Path

import pytest

from app.contracts import ContractValidator

CONTRACTS = (Path(__file__).resolve().parents[3] / "contracts")
validator = ContractValidator(CONTRACTS)
load = lambda sub, name: json.loads((CONTRACTS / "examples" / sub / name).read_text())


@pytest.mark.parametrize("name", [p.name for p in (CONTRACTS / "examples" / "valid").glob("*.json")])
def test_valid_examples_pass(name):
    assert validator.validate(load("valid", name)).ok


def test_unsupported_schema_version_is_non_retryable():
    r = validator.validate(load("invalid", "unsupported-schema-version.json"))
    assert not r.ok and r.classification == "unsupported_schema"


def test_missing_payload_field_is_malformed():
    r = validator.validate(load("invalid", "missing-payload-field.json"))
    assert not r.ok and r.classification == "malformed"
    assert any("name" in e for e in r.errors)


def test_garbage_is_rejected():
    assert validator.validate({"hello": "world"}).classification == "unsupported_schema"
    assert validator.validate("not even a dict").classification == "malformed"
