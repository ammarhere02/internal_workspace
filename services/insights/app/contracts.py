"""Validates incoming events against the shared JSON Schemas in /contracts (same files as the NestJS side)."""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

SUPPORTED_SCHEMA_VERSIONS = {1}
Classification = Literal["malformed", "unsupported_schema", "unknown_event_type"]


@dataclass
class ContractResult:
    ok: bool
    classification: Classification | None = None
    errors: list[str] = field(default_factory=list)


class ContractValidator:
    def __init__(self, contracts_dir: Path):
        schemas = contracts_dir / "schemas"
        common = json.loads((schemas / "events" / "common.schema.json").read_text())
        registry = Registry().with_resource(common["$id"], Resource.from_contents(common))
        self._envelope = Draft202012Validator(
            json.loads((schemas / "envelope.schema.json").read_text()), registry=registry, format_checker=FormatChecker()
        )
        self._payloads: dict[str, Draft202012Validator] = {}
        for f in sorted((schemas / "events").glob("*.schema.json")):
            if f.name == "common.schema.json":
                continue
            self._payloads[f.name.removesuffix(".schema.json")] = Draft202012Validator(
                json.loads(f.read_text()), registry=registry, format_checker=FormatChecker()
            )

    def validate(self, event: Any) -> ContractResult:
        if not isinstance(event, dict):
            return ContractResult(False, "malformed", ["event is not an object"])
        version = event.get("schemaVersion")
        if not isinstance(version, int) or version not in SUPPORTED_SCHEMA_VERSIONS:
            return ContractResult(False, "unsupported_schema", [f"schemaVersion {version!r} not supported"])
        errs = [f"{'/'.join(map(str, e.path)) or '/'} {e.message}" for e in self._envelope.iter_errors(event)]
        if errs:
            return ContractResult(False, "malformed", errs)
        validator = self._payloads.get(str(event.get("eventType")))
        if validator is None:
            return ContractResult(False, "unknown_event_type", [f"no payload schema for {event.get('eventType')!r}"])
        errs = [f"{'/'.join(map(str, e.path)) or '/'} {e.message}" for e in validator.iter_errors(event["payload"])]
        if errs:
            return ContractResult(False, "malformed", errs)
        return ContractResult(True)
