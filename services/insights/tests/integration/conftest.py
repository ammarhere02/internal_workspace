import os
from pathlib import Path

import pytest

NATS_URL = os.environ.get("NATS_URL", "nats://localhost:4222")
MGMT_DIR = Path(__file__).resolve().parents[3] / "management"


async def node(script: str, *args: str) -> dict:
    """Run a management-service interop script WITHOUT blocking the event loop (the Python responder under test runs on it)."""
    import asyncio
    import json
    proc = await asyncio.create_subprocess_exec("node", str(MGMT_DIR / "scripts" / script), NATS_URL, *args,
                                                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(), timeout=60)
    assert proc.returncode == 0, err.decode()
    lines = [l for l in out.decode().splitlines() if l.startswith("{")]
    assert lines, f"no JSON output from {script}: {out.decode()[-500:]}"
    return json.loads(lines[-1])


@pytest.fixture
def nats_url():
    return NATS_URL


@pytest.fixture
def node_runner():
    if not (MGMT_DIR / "dist" / "messaging" / "publish.js").exists():
        pytest.skip("management service not built: run `npm run build` in services/management")
    return node
