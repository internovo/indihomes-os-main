"""Plain-assert test for agent/agent/tools.py's serper_search — same
"runnable script, not a framework" convention as
test_lifecycle_and_eligibility.py / test_bridge_circuit_breaker.py. Run
directly:

    .venv\\Scripts\\python.exe tests\\test_serper_search.py

Mocks the bridge HTTP call (no real network) and asserts serper_search's
own contract: hits the right bridge route, and returns
(List[EvidenceItem], ToolCallRecord) with the same success/error shape as
web_search/tavily_search.
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import tools as tools_mod

failures = []


def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"ok:   {label}")


class _FakeClient:
    def __init__(self, response_json, status_code=200):
        self._response_json = response_json
        self._status_code = status_code
        self.last_url = None

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, url, *args, **kwargs):
        self.last_url = url
        return _FakeResponse(self._response_json, self._status_code)


class _FakeResponse:
    def __init__(self, body, status_code):
        self._body = body
        self.status_code = status_code
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._body


async def _run():
    tools_mod._bridge_state["unavailable_until"] = 0.0
    tools_mod._bridge_state["last_error"] = None
    # A unique query per run — serper_search's cache is disk-persistent
    # (agent/.cache), so a fixed literal would read back a PRIOR run's
    # cached response instead of exercising the fake client at all.
    nonce = str(time.time())

    # ── Success path: real evidence returned, hits the correct bridge route.
    fake = _FakeClient({"evidence": [{"title": "2 BHK Flat in Andheri West"}], "tried": ["serper"]})
    with patch.object(tools_mod.httpx, "AsyncClient", fake):
        evidence, record = await tools_mod.serper_search(f"2bhk in Andheri west {nonce}", "india")
        check("hits the serper-search bridge route", fake.last_url.endswith("/internal/agent-tools/serper-search"))
        check("returns the real evidence list untouched", evidence == [{"title": "2 BHK Flat in Andheri West"}])
        check("ToolCallRecord.tool == 'serper_search'", record["tool"] == "serper_search")
        check("status is 'ok' on a real result", record["status"] == "ok")
        check("count matches evidence length", record["count"] == 1)
        check("no error recorded on success", record["error"] is None)

    # ── Error path: a bridge-reported error with no evidence must surface as
    # status='error' — same "real failures reported honestly" contract as
    # every other tool in this file. A different query text than the success
    # case above, so this doesn't just read back the first call's cache hit.
    tools_mod._bridge_state["unavailable_until"] = 0.0
    tools_mod._bridge_state["last_error"] = None
    fake_err = _FakeClient({"evidence": [], "error": "SERPER_API_KEY not set"}, status_code=502)
    with patch.object(tools_mod.httpx, "AsyncClient", fake_err):
        evidence, record = await tools_mod.serper_search(f"3bhk in Bandra west {nonce}", "india")
        check("error path returns empty evidence", evidence == [])
        check("error path status is 'error'", record["status"] == "error")
        check("error path carries the real error text, not swallowed", record["error"] == "SERPER_API_KEY not set")
    tools_mod._bridge_state["unavailable_until"] = 0.0
    tools_mod._bridge_state["last_error"] = None


if __name__ == "__main__":
    asyncio.run(_run())
    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        sys.exit(1)
    print("All checks passed.")
