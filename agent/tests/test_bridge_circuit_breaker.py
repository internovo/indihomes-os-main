"""Plain-assert tests for agent/agent/tools.py's bridge circuit breaker —
same "runnable script, not a framework" convention as
test_lifecycle_and_eligibility.py. Run directly:

    .venv\\Scripts\\python.exe tests\\test_bridge_circuit_breaker.py

Real (mocked) network-call verification, not just a config/env-var check —
each test asserts an actual call COUNTER, proving a short-circuited call
genuinely attempts zero network I/O rather than just returning fast for
some other reason. Written after a live, confirmed regression: a single
apify_search ReadTimeout (Apify's own real ~50-60s latency exceeding the
much shorter shared bridge timeout) was marking the ENTIRE bridge
unavailable, which then short-circuited ~10 unrelated, healthy fetch_page/
web_search/tavily_search calls in a single targeted-research pass — see
agent/README.md's "Bridge reliability" section and structure.md for the
full writeup.
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from agent import tools as tools_mod

failures = []


def check(label, condition):
    if not condition:
        failures.append(label)
        print(f"FAIL: {label}")
    else:
        print(f"ok:   {label}")


def _reset_circuit():
    tools_mod._bridge_state["unavailable_until"] = 0.0
    tools_mod._bridge_state["last_error"] = None


class _FakeClient:
    """Minimal httpx.AsyncClient stand-in — raises whatever exception the
    test configures on every .post(), and increments a shared counter so
    a short-circuited call (zero network attempts) is provably different
    from one that actually tried and failed.
    """
    def __init__(self, exc_factory, counter):
        self._exc_factory = exc_factory
        self._counter = counter

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, *args, **kwargs):
        self._counter["n"] += 1
        raise self._exc_factory()


async def _run():
    # ── 1) A genuine CONNECTION failure (bridge process unreachable) DOES
    # trip the shared circuit, and a SECOND call afterward short-circuits
    # with ZERO additional network attempts — the user's explicit ask:
    # prove this with a real call counter, not just "the TTL config exists".
    _reset_circuit()
    counter = {"n": 0}
    fake_client = _FakeClient(lambda: httpx.ConnectError("simulated connection refused"), counter)
    with patch.object(tools_mod.httpx, "AsyncClient", fake_client):
        data1, dur1, err1, hit1 = await tools_mod._call_bridge(
            "/internal/agent-tools/test-route", {}, timeout_s=0.05, max_retries=0,
        )
        calls_after_first = counter["n"]
        check("first call against a genuinely unreachable bridge attempts a real network call", calls_after_first >= 1)
        check("first call's failure is reported as bridge_unavailable", err1 is not None and "bridge_unavailable" in err1)
        check("first call trips the shared circuit (ConnectError = genuine bridge-down signal)", tools_mod.bridge_marked_unavailable() is not None)

        data2, dur2, err2, hit2 = await tools_mod._call_bridge(
            "/internal/agent-tools/test-route", {}, timeout_s=0.05, max_retries=0,
        )
        check("second call short-circuits with ZERO additional network attempts (the actual circuit-breaker guarantee)", counter["n"] == calls_after_first)
        check("second call still reports bridge_unavailable (instantly, from the remembered state)", err2 is not None and "bridge_unavailable" in err2)
        check("second call's own duration is ~0ms (no real wait, proves it never entered the network path)", dur2 < 50)
    _reset_circuit()

    # ── 2) THE ACTUAL BUG: a ReadTimeout (bridge reachable, this ONE call
    # was just too slow — e.g. apify_search waiting on a legitimately slow
    # Apify actor run) must NOT trip the shared circuit that every other,
    # unrelated, healthy tool call checks. This is the live-confirmed root
    # cause of ~10 unrelated bridge calls failing "instantly" with
    # bridge_unavailable in a single targeted-research pass.
    _reset_circuit()
    counter2 = {"n": 0}
    slow_client = _FakeClient(lambda: httpx.ReadTimeout("simulated slow apify response"), counter2)
    with patch.object(tools_mod.httpx, "AsyncClient", slow_client):
        data3, dur3, err3, hit3 = await tools_mod._call_bridge(
            "/internal/agent-tools/apify-search", {}, timeout_s=0.05, max_retries=0,
        )
        check("a ReadTimeout fails THIS call", err3 is not None and "ReadTimeout" in err3)
        check("...but does NOT report it as bridge_unavailable (the bridge itself is fine)", "bridge_unavailable" not in (err3 or ""))
        check("...and does NOT trip the shared circuit other tools check", tools_mod.bridge_marked_unavailable() is None)

    # ── 3) Direct proof of the fix: an UNRELATED tool call, made right
    # after the ReadTimeout above, is completely unaffected — it gets a
    # real network attempt, not an instant short-circuit.
    counter3 = {"n": 0}
    ok_response_client = _FakeOkClient(counter3)
    with patch.object(tools_mod.httpx, "AsyncClient", ok_response_client):
        data4, dur4, err4, hit4 = await tools_mod._call_bridge(
            "/internal/agent-tools/tavily-search", {}, timeout_s=1, max_retries=0,
        )
        check("an unrelated tool call after a ReadTimeout elsewhere still attempts a real network call (not poisoned)", counter3["n"] == 1)
        check("...and succeeds normally", err4 is None)
    _reset_circuit()

    # ── 4) apify_search itself now uses a dedicated, generous timeout —
    # not the short shared default that guaranteed failure against Apify's
    # real ~60s latency.
    check("apify_search's dedicated timeout is longer than the shared default bridge timeout", tools_mod.APIFY_TIMEOUT_S > tools_mod.TIMEOUT_S)
    check("apify_search's dedicated timeout comfortably covers Node's own 60s default Apify timeout", tools_mod.APIFY_TIMEOUT_S >= 65)


class _FakeOkClient:
    def __init__(self, counter):
        self._counter = counter

    def __call__(self, *args, **kwargs):
        return self

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        return False

    async def post(self, *args, **kwargs):
        self._counter["n"] += 1
        return _FakeResponse()


class _FakeResponse:
    status_code = 200
    headers = {}

    def json(self):
        return {"evidence": []}


if __name__ == "__main__":
    asyncio.run(_run())
    print()
    if failures:
        print(f"{len(failures)} FAILURE(S): {failures}")
        sys.exit(1)
    print("All checks passed.")
