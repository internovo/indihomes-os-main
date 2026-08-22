"""Build validation.json from the per-scenario JSON files already written by
harness.py. Re-runs the same deterministic V1-V12 checks — no network calls,
no re-search. Usage: python build_validation.py <RUN_ID>"""
import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "test-results"))
import harness  # noqa: E402

SCENARIOS_ORDER = ["T1-01", "T1-02", "T1-03", "T1-04", "T1-05", "T1-06", "T1-07", "T1-08", "T1-09", "T1-10", "T2-06"]


def build(run_id):
    run_dir = REPO_ROOT / "test-results" / run_id
    searches_dir = run_dir / "searches"

    scenarios = []
    totals_checks = {f"V{i}": {"pass": 0, "fail": 0} for i in range(1, 13)}
    valid_count = 0
    invalid_count = 0
    provider_counts = {}

    for sid in SCENARIOS_ORDER:
        path = searches_dir / f"{sid}.json"
        if not path.exists():
            continue
        d = json.load(open(path, encoding="utf-8"))
        response_json = {"properties": d.get("properties", []), "pipeline": d.get("pipeline")}
        validation = harness.validate_scenario(d["query"], response_json, d["http_status"])

        if validation["valid"]:
            valid_count += 1
        else:
            invalid_count += 1

        prov = (d.get("provider_inference") or {}).get("inferred", "unknown")
        provider_counts[prov] = provider_counts.get(prov, 0) + 1

        for k, v in validation["checks"].items():
            if isinstance(v, dict):
                totals_checks[k]["pass"] += v.get("pass", 0) or 0
                totals_checks[k]["fail"] += v.get("fail", 0) or 0

        scenarios.append({
            "scenario_id": sid,
            "query": d["query"],
            "pipeline": d.get("pipeline"),
            "valid": validation["valid"],
            "duration_ms": d.get("duration_ms"),
            "result_count": d.get("result_count"),
            "checks": validation["checks"],
            "pi_coverage": validation["pi_coverage"],
            "ledger_totals": validation["ledger_totals"],
            "provider_inferred": prov,
            "provider_reason": (d.get("provider_inference") or {}).get("reason"),
        })

    out = {
        "run_id": run_id,
        "scenarios": scenarios,
        "totals": {
            "valid_searches": valid_count,
            "invalid_searches": invalid_count,
            "checks": totals_checks,
            "provider_breakdown": provider_counts,
        },
    }
    out_path = run_dir / "validation.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"wrote {out_path}")
    print(json.dumps(out["totals"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    build(sys.argv[1])
