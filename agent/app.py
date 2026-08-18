"""FastAPI entrypoint for the AI Search research agent — the "small HTTP
service" Part 1 asks for when a Node-only integration isn't practical. Node
(server.cjs) calls POST /agent/ai-search when LANGGRAPH_ENABLED=true; the
existing external-search.cjs path is untouched and used whenever this
service is disabled or unreachable (Part 28: production safety).
"""
from __future__ import annotations

import logging
import os
import time

from dotenv import load_dotenv
from fastapi import FastAPI
from pydantic import BaseModel

# Load the SAME .env the Node backend uses (repo root), so both services
# agree on which connectors/providers are configured — one source of truth
# for credentials, not a second .env to keep in sync.
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

logging.basicConfig(level=os.getenv("AGENT_LOG_LEVEL", "INFO"))
logger = logging.getLogger("ai-search-agent")

from agent.graph import get_graph  # noqa: E402  (import after dotenv load so env-dependent modules see it)
from agent.llm_providers import LLMRouter  # noqa: E402

app = FastAPI(title="IndiHomes AI Search Agent", version="1.0.0")


class AISearchRequest(BaseModel):
    query: str
    market: str = "india"


@app.get("/health")
async def health():
    reasoning = LLMRouter("reasoning")
    extraction = LLMRouter("extraction")
    return {
        "ok": True,
        "llm": {
            "reasoning_configured": reasoning.is_configured(),
            "reasoning_providers": reasoning.provider_labels(),
            "extraction_configured": extraction.is_configured(),
            "extraction_providers": extraction.provider_labels(),
        },
        # Presence-only — never echoes the actual key value. LANGSMITH_TRACING
        # must be the literal string "true" for LangGraph/LangChain's
        # tracing callback to actually attach; a key with tracing left off
        # is a common "why aren't traces showing up" cause (Part 43/46).
        "langsmith": {
            "tracing_enabled": os.getenv("LANGSMITH_TRACING", "").lower() == "true",
            "api_key_configured": bool(os.getenv("LANGSMITH_API_KEY")),
            "project": os.getenv("LANGSMITH_PROJECT") or None,
            "endpoint": os.getenv("LANGSMITH_ENDPOINT") or "https://api.smith.langchain.com (default)",
        },
    }


AGENT_VERSION = os.getenv("AGENT_VERSION", "2.0.0")  # bumped for the deep-research pipeline this pass adds


@app.post("/agent/ai-search")
async def ai_search(req: AISearchRequest):
    start = time.monotonic()
    graph = get_graph()
    # Tags/metadata on the top-level invocation (Part 26) — LangSmith
    # attaches these to the run tree ROOT, so every node/tool span nested
    # under this one call inherits them; a trace can be filtered/grouped by
    # market or agent_version in the LangSmith UI without opening each run.
    result = await graph.ainvoke(
        {"original_query": req.query, "market": req.market, "research_iterations": 0},
        config={
            "recursion_limit": 50,
            "tags": ["ai-search", req.market],
            "metadata": {"search_query": req.query, "market": req.market, "agent_version": AGENT_VERSION},
        },
    )
    duration_ms = int((time.monotonic() - start) * 1000)
    response = result.get("final_response") or {}
    response.setdefault("research_metadata", {})
    response["research_metadata"]["duration_ms"] = duration_ms
    response["research_metadata"]["agent_version"] = AGENT_VERSION
    return response


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app:app", host="127.0.0.1", port=int(os.getenv("AGENT_PORT", "8008")), reload=False)
