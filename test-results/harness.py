"""
India AI Search test harness — deterministic runner + validator.
No LLM judgment anywhere in here; every check is plain code (V1-V12 per the
test-plan). Run one scenario at a time:

    agent/.venv/Scripts/python.exe test-results/harness.py <RUN_ID> <SCENARIO_ID> "<query>"

Writes test-results/<RUN_ID>/searches/<SCENARIO_ID>.json and appends a line
to test-results/ledger.jsonl. Prints a one-line summary to stdout.
"""
import json
import re
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "agent"))
from agent.fact_extraction import candidate_name_reject_reason  # noqa: E402

BACKEND_URL = "http://127.0.0.1:3001/api/ai-search"
HEALTH_URL = "http://127.0.0.1:8008/health?probe=true"
RERA_RE = re.compile(r"^P[A-Z]{0,2}\d{9,13}$")
ALLOWED_LIFECYCLE = {"UNDER_CONSTRUCTION", "NEAR_POSSESSION", "NEW_LAUNCH", "PRE_LAUNCH", "UNKNOWN"}
DISALLOWED_LIFECYCLE = {"RESALE", "RENTAL", "READY_TO_MOVE"}
PI_PANELS = [
    ("rera_compliance", lambda pi: bool(pi.get("rera") or pi.get("rera_confidence"))),
    ("inventory_config", lambda pi: bool(pi.get("configs") or pi.get("configuration_evidence"))),
    ("location_score", lambda pi: pi.get("location_score") not in (None, "", {})),
    ("ai_summary", lambda pi: bool(pi.get("summary"))),
    ("usp", lambda pi: bool(pi.get("usps"))),
    ("target_audience", lambda pi: bool(pi.get("target_audience"))),
    ("competitors", lambda pi: bool(pi.get("competitors"))),
    ("location_map", lambda pi: bool(pi.get("nearby_landmarks") or pi.get("connectivity"))),
]


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now(timezone.utc).microsecond // 1000:03d}Z"


def load_gazetteer():
    gz = json.load(open(REPO_ROOT / "shared" / "mmr-gazetteer.json", encoding="utf-8"))
    return gz.get("cities", {}), gz.get("aliases", {})


CITIES, ALIASES = load_gazetteer()


def locality_terms_for_query(query: str):
    """Every string that would count as a legitimate locality match for this
    query: the raw locality words in the query, plus (if any query word is a
    known alias) its canonical/parent/city, plus any city name mentioned."""
    q_lower = query.lower()
    terms = set()
    for city, suburbs in CITIES.items():
        if city.lower() in q_lower:
            terms.add(city.lower())
        for suburb in suburbs:
            if suburb.lower() in q_lower:
                terms.add(suburb.lower())
                terms.add(city.lower())
    for alias_key, info in ALIASES.items():
        if alias_key in q_lower:
            terms.add(alias_key)
            terms.add(info.get("canonical", "").lower())
            terms.add(info.get("parent", "").lower())
            terms.add(info.get("city", "").lower())
    terms.discard("")
    return terms


def check_v2_locality(query, prop):
    terms = locality_terms_for_query(query)
    if not terms:
        return None  # nothing to check against
    haystack = " ".join(str(prop.get(k, "")) for k in ("location", "city", "name", "placesAddress")).lower()
    return any(t in haystack for t in terms)


def check_v6_atomic(config_value):
    if not config_value:
        return True, None
    parts = re.split(r"[&,]", str(config_value))
    parts = [p.strip() for p in parts if p.strip()]
    seen = set()
    dups = []
    for p in parts:
        if p in seen:
            dups.append(p)
        seen.add(p)
    return (len(dups) == 0), dups


def check_v8_price(price_value):
    if price_value in (None, ""):
        return True, None
    s = str(price_value)
    if s.strip() in ("₹", "0", "NaN"):
        return False, s
    # range with min > max, e.g. "₹2 Cr - ₹1 Cr"
    nums = re.findall(r"[\d,.]+", s)
    if len(nums) >= 2:
        try:
            a = float(nums[0].replace(",", ""))
            b = float(nums[1].replace(",", ""))
            if "-" in s and a > b:
                return False, s
        except ValueError:
            pass
    return True, None


def normalize_name_locality(prop):
    name = re.sub(r"[^a-z0-9]", "", str(prop.get("name", "")).lower())
    loc = re.sub(r"[^a-z0-9]", "", str(prop.get("location", "")).lower())
    return name, loc


def check_v12_duplicates(properties):
    seen_rera = {}
    seen_namekey = {}
    dup_pairs = []
    for p in properties:
        rera = p.get("rera")
        if rera:
            if rera in seen_rera:
                dup_pairs.append((seen_rera[rera], p.get("name"), f"rera={rera}"))
            else:
                seen_rera[rera] = p.get("name")
        name, loc = normalize_name_locality(p)
        key = (name, loc)
        if key in seen_namekey:
            dup_pairs.append((seen_namekey[key], p.get("name"), "name+locality"))
        else:
            seen_namekey[key] = p.get("name")
    return dup_pairs


def validate_scenario(query, response_json, http_status):
    pipeline = response_json.get("pipeline") if isinstance(response_json, dict) else None
    valid = (pipeline == "agent") and (http_status == 200)
    properties = response_json.get("properties", []) if isinstance(response_json, dict) else []

    checks = {f"V{i}": {"pass": 0, "fail": 0, "failures": []} for i in range(1, 13)}

    checks["V1"]["pass" if valid else "fail"] += 1
    if not valid:
        checks["V1"]["failures"].append({"pipeline": pipeline, "http_status": http_status})

    for idx, p in enumerate(properties):
        tag = {"index": idx, "name": p.get("name")}

        v2 = check_v2_locality(query, p)
        if v2 is None:
            pass
        elif v2:
            checks["V2"]["pass"] += 1
        else:
            checks["V2"]["fail"] += 1
            checks["V2"]["failures"].append({**tag, "location": p.get("location"), "city": p.get("city")})

        lifecycle = p.get("lifecycleStatus")
        if lifecycle in DISALLOWED_LIFECYCLE:
            checks["V3"]["fail"] += 1
            checks["V3"]["failures"].append({**tag, "lifecycleStatus": lifecycle})
        else:
            checks["V3"]["pass"] += 1

        reject_reason = candidate_name_reject_reason(p.get("name") or "")
        if reject_reason:
            checks["V4"]["fail"] += 1
            checks["V4"]["failures"].append({**tag, "reason": reject_reason})
        else:
            checks["V4"]["pass"] += 1

        rera = p.get("rera")
        if rera:
            if RERA_RE.match(rera):
                checks["V5"]["pass"] += 1
            else:
                checks["V5"]["fail"] += 1
                checks["V5"]["failures"].append({**tag, "rera": rera})

        atomic_ok, dups = check_v6_atomic(p.get("config"))
        if atomic_ok:
            checks["V6"]["pass"] += 1
        else:
            checks["V6"]["fail"] += 1
            checks["V6"]["failures"].append({**tag, "config": p.get("config"), "dups": dups})

        ptype = p.get("propertyType")
        if ptype:
            q_lower = query.lower()
            wants_bhk = bool(re.search(r"\d\s*bhk|studio", q_lower))
            contradicts = wants_bhk and ptype.lower() in ("villa", "plot", "land", "bungalow")
            if contradicts:
                checks["V7"]["fail"] += 1
                checks["V7"]["failures"].append({**tag, "propertyType": ptype, "query": query})
            else:
                checks["V7"]["pass"] += 1

        price_ok, bad_val = check_v8_price(p.get("price"))
        if price_ok:
            checks["V8"]["pass"] += 1
        else:
            checks["V8"]["fail"] += 1
            checks["V8"]["failures"].append({**tag, "price": bad_val})

        has_location_claim = bool(p.get("nearbyLandmarks") or p.get("connectivity") or
                                   (p.get("project_intelligence") or {}).get("location_score"))
        if has_location_claim:
            lat, lon = p.get("placesLat"), p.get("placesLon")
            if lat in (None, 0) and lon in (None, 0):
                checks["V9"]["fail"] += 1
                checks["V9"]["failures"].append({**tag, "placesLat": lat, "placesLon": lon})
            else:
                checks["V9"]["pass"] += 1

    dup_pairs = check_v12_duplicates(properties)
    checks["V12"]["pass"] = len(properties) - len(dup_pairs) if properties else 0
    checks["V12"]["fail"] = len(dup_pairs)
    checks["V12"]["failures"] = [{"a": a, "b": b, "matched_on": m} for a, b, m in dup_pairs]

    # V10 — PI coverage for top-ranked property only
    pi_coverage = None
    if properties:
        top = properties[0]
        pi = top.get("project_intelligence") or {}
        filled = [name for name, fn in PI_PANELS if fn(pi)]
        pi_coverage = f"{len(filled)}/{len(PI_PANELS)}"
        checks["V10"] = {"pass": len(filled), "fail": len(PI_PANELS) - len(filled),
                          "filled_panels": filled,
                          "empty_panels": [n for n, _ in PI_PANELS if n not in filled]}

    # V11 — field ledger totals for top-ranked property
    ledger_totals = {"filled": 0, "searched_not_found": 0, "never_researched": 0}
    field_ledger = None
    if properties:
        pi = properties[0].get("project_intelligence") or {}
        field_ledger = pi.get("field_ledger")
        fields = field_ledger.get("fields") if isinstance(field_ledger, dict) else None
        if isinstance(fields, dict):
            for _field, status in fields.items():
                st = status.get("status") if isinstance(status, dict) else status
                if st in ledger_totals:
                    ledger_totals[st] += 1
        checks["V11"] = {"ledger_totals": ledger_totals, "raw_present": field_ledger is not None}

    return {
        "valid": valid,
        "pipeline": pipeline,
        "checks": checks,
        "pi_coverage": pi_coverage,
        "field_ledger": field_ledger,
        "ledger_totals": ledger_totals,
    }


def probe_health():
    """Best-effort snapshot of /health?probe=true. Returns None on failure —
    never fabricated. This is the only observable signal for which LLM
    provider is likely serving a search: the response body carries no
    per-search provider field, and no live agent log file exists for the
    already-running agent process (checked at suite start)."""
    try:
        with urllib.request.urlopen(HEALTH_URL, timeout=10) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:  # noqa: BLE001 — a failed probe is itself a fact worth None, not a crash
        return None


def infer_provider(health_before, health_after=None):
    """Inferred, not observed — the response body carries no per-search
    provider field and no live agent log file exists (checked at suite
    start), so a before/after /health?probe=true circuit-breaker snapshot
    is the only signal available. Four observable states:
      - open before AND after      -> fallback throughout
      - closed before, open after  -> tripped mid-run: mixed groq+fallback
      - closed before AND after    -> groq likely throughout (not proven —
                                       a trip-then-recovery inside the run
                                       cannot be ruled out from two samples)
      - open before, closed after  -> recovered mid-run: mixed fallback+groq
    """
    if not health_before:
        return {"inferred": "unknown", "reason": "health probe failed before this search"}
    before_open = "groq" in health_before.get("circuit_breaker", {})
    after_open = None
    if health_after:
        after_open = "groq" in health_after.get("circuit_breaker", {})

    if after_open is None:
        if before_open:
            return {"inferred": "local_openrouter_fallback", "reason": f"groq circuit breaker open at search start: {health_before['circuit_breaker']['groq']}"}
        return {"inferred": "groq_likely_uncertain_mid_run", "reason": "groq circuit breaker closed at search start (no after-probe available)"}

    if before_open and after_open:
        return {"inferred": "local_openrouter_fallback_throughout", "reason": "groq breaker open both before and after this search"}
    if not before_open and after_open:
        return {"inferred": "mixed_groq_then_fallback", "reason": "groq breaker closed at start, open at end — TPM exhausted during this search"}
    if not before_open and not after_open:
        return {"inferred": "groq_likely_throughout", "reason": "groq breaker closed both before and after (two-sample check — a trip-then-recovery inside the run cannot be fully ruled out)"}
    return {"inferred": "mixed_fallback_then_groq", "reason": "groq breaker open at start, closed by end — recovered mid-run"}


def run_search(run_id, scenario_id, query):
    payload = json.dumps({"query": query, "market": "india", "filters": {}}).encode("utf-8")
    req = urllib.request.Request(BACKEND_URL, data=payload, headers={"Content-Type": "application/json"}, method="POST")

    health_before = probe_health()

    started_at = now_iso()
    t0 = time.monotonic()
    http_status = None
    body = None
    error_text = None
    try:
        with urllib.request.urlopen(req, timeout=190) as resp:
            http_status = resp.status
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        http_status = e.code
        body = e.read().decode("utf-8", errors="replace")
    except Exception as e:  # noqa: BLE001 — record real error text, never fabricate
        error_text = f"{type(e).__name__}: {e}"
    finished_at = now_iso()
    duration_ms = int((time.monotonic() - t0) * 1000)
    health_after = probe_health()
    provider_inference = infer_provider(health_before, health_after)

    response_json = None
    if body is not None:
        try:
            response_json = json.loads(body)
        except json.JSONDecodeError:
            error_text = (error_text or "") + f" | non-JSON response body (first 500 chars): {body[:500]}"

    return assemble_and_write(run_id, scenario_id, query, started_at, finished_at, duration_ms,
                               http_status, response_json, error_text,
                               provider_inference=provider_inference,
                               health_before=health_before, health_after=health_after)


def assemble_and_write(run_id, scenario_id, query, started_at, finished_at, duration_ms,
                        http_status, response_json, error_text=None,
                        provider_inference=None, health_before=None, health_after=None):
    run_dir = REPO_ROOT / "test-results" / run_id
    searches_dir = run_dir / "searches"
    searches_dir.mkdir(parents=True, exist_ok=True)

    result = {
        "scenario_id": scenario_id,
        "query": query,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "http_status": http_status,
        "error": error_text,
        "pipeline": (response_json or {}).get("pipeline") if isinstance(response_json, dict) else None,
        "llm_degraded": (response_json or {}).get("llm_degraded") if isinstance(response_json, dict) else None,
        "warnings": (response_json or {}).get("warning") if isinstance(response_json, dict) else None,
        "result_count": len(response_json.get("properties", [])) if isinstance(response_json, dict) else 0,
        "properties": response_json.get("properties", []) if isinstance(response_json, dict) else [],
        "field_ledger": None,
        "rejected": response_json.get("rejected") if isinstance(response_json, dict) else None,
        "agent_log_excerpt": None,  # NOT OBSERVABLE — see harness report "What I could not test"
        "raw_response_top_level_keys": list(response_json.keys()) if isinstance(response_json, dict) else None,
        "retrieval_metrics": (response_json or {}).get("retrieval_metrics") if isinstance(response_json, dict) else None,
        "research_metadata": (response_json or {}).get("research_metadata") if isinstance(response_json, dict) else None,
        "summary": (response_json or {}).get("summary") if isinstance(response_json, dict) else None,
        "raw_response_full": response_json,
        "provider_inference": provider_inference,
        "groq_circuit_before": (health_before or {}).get("circuit_breaker"),
        "groq_circuit_after": (health_after or {}).get("circuit_breaker"),
    }

    validation = None
    if response_json is not None:
        validation = validate_scenario(query, response_json, http_status)
        result["field_ledger"] = validation["field_ledger"]

    out_path = searches_dir / f"{scenario_id}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)

    ledger_line = {
        "run_id": run_id, "scenario_id": scenario_id, "query": query,
        "started_at": started_at, "finished_at": finished_at, "duration_ms": duration_ms,
        "http_status": http_status, "pipeline": result["pipeline"], "result_count": result["result_count"],
        "valid": validation["valid"] if validation else False,
        "error": error_text,
        "provider_inferred": (provider_inference or {}).get("inferred"),
    }
    ledger_path = REPO_ROOT / "test-results" / "ledger.jsonl"
    with open(ledger_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(ledger_line, ensure_ascii=False) + "\n")

    summary = {"scenario_id": scenario_id, "pipeline": result["pipeline"], "valid": validation["valid"] if validation else False,
               "result_count": result["result_count"], "duration_ms": duration_ms, "http_status": http_status,
               "pi_coverage": validation["pi_coverage"] if validation else None,
               "provider_inferred": (provider_inference or {}).get("inferred")}
    print(json.dumps(summary, ensure_ascii=False))
    return result, validation


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: harness.py <RUN_ID> <SCENARIO_ID> <query>", file=sys.stderr)
        sys.exit(2)
    run_search(sys.argv[1], sys.argv[2], sys.argv[3])
