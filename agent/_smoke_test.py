"""Runs one query through the full compiled LangGraph pipeline end to end
and prints every stage's output — the fastest way to see the whole agent
work on a real query without going through Node or the browser.

Usage: .venv/Scripts/python _smoke_test.py "2 BHK in Borivali East under 1.5 Cr"
"""
import asyncio
import json
import os
import sys
import time

from dotenv import load_dotenv

sys.path.insert(0, ".")
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8")
from agent.graph import get_graph  # noqa: E402


async def main():
    g = get_graph()
    query = sys.argv[1] if len(sys.argv) > 1 else "2 BHK with deck on Liberty Garden Malad West"
    start = time.monotonic()
    result = await g.ainvoke(
        {"original_query": query, "market": "india", "research_iterations": 0},
        config={
            "recursion_limit": 50,
            "tags": ["ai-search", "smoke-test"],
            "metadata": {"search_query": query, "market": "india"},
        },
    )
    dur = int((time.monotonic() - start) * 1000)
    print(f"\n=== query: {query!r} ({dur}ms) ===")
    print("parsed_requirements:", result.get("parsed_requirements"))
    print("micro_locations:", result.get("micro_locations"))
    print("search_plan:", result.get("search_plan"))
    print("research_plan:", result.get("research_plan"))
    print("tool_calls:")
    for tc in result.get("tool_calls", []):
        cache_tag = " [cache]" if tc.get("cache_hit") else ""
        print("  -", tc["tool"], tc["status"], f"count={tc['count']}", f"{tc['duration_ms']}ms{cache_tag}", tc.get("error") or "")
    print("raw_evidence count:", len(result.get("raw_evidence", [])))
    print("normalized_properties count:", len(result.get("normalized_properties", [])))
    print("deduplicated_properties count:", len(result.get("deduplicated_properties", [])))
    print("fetched_pages count:", len(result.get("fetched_pages", [])))
    for pg in result.get("fetched_pages", []):
        print(f"  - [{pg.get('status')}] {pg.get('candidate')!r} <- {pg.get('url')} (via {pg.get('retrieved_via')})")
    print("extracted_facts count:", len(result.get("extracted_facts", [])))
    print("research_gaps:", result.get("research_gaps"))
    print("verification_results:", result.get("verification_results"))
    print("warnings:", result.get("warnings"))
    print("research_iterations:", result.get("research_iterations"))
    print("\nranked_properties (top 8):")
    for p in result.get("ranked_properties", [])[:8]:
        print(f"  {p['match_score']:>3} {p['match_tier']:<9} {p['name'][:40]:<40} loc={p.get('location')!r} reasons={p['match_reasons']}")
    print("\nfinal_response:")
    print(json.dumps(result.get("final_response"), indent=2, default=str)[:6000])


asyncio.run(main())
