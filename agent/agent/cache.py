"""Lightweight file-based TTL cache — deliberately no new infra dependency
(no Redis/Postgres) for a service this small. Three tiers, per the brief's
"Persistence / Caching" section:

- QUERY_TTL_S (default 600s / 10 min): the full curated response for a
  normalized query — short, since "what's available" genuinely changes and
  a user refining a search shouldn't see a stale property list for long.
- SOURCE_TTL_S (default 21600s / 6h): raw evidence per (tool, query) pair —
  a portal/web-search result is reasonably stable within a working day;
  this is what stops every request from re-scraping 99acres/MagicBricks.
- INTEL_TTL_S (default 86400s / 24h): a single property's assembled
  project_intelligence payload — longest-lived, since it's the most
  expensive to assemble (multiple tool calls + LLM synthesis) and changes
  the least often.

Cache files live in ai-search-agent/.cache/<namespace>/<sha256(key)>.json.
"""
from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Optional

CACHE_DIR = Path(__file__).resolve().parent.parent / ".cache"

QUERY_TTL_S = int(os.getenv("AI_SEARCH_CACHE_TTL_MS", str(10 * 60 * 1000))) / 1000
SOURCE_TTL_S = int(os.getenv("AI_SEARCH_SOURCE_CACHE_TTL_MS", str(6 * 60 * 60 * 1000))) / 1000
INTEL_TTL_S = int(os.getenv("AI_SEARCH_INTEL_CACHE_TTL_MS", str(24 * 60 * 60 * 1000))) / 1000


def _key_path(namespace: str, key: str) -> Path:
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
    d = CACHE_DIR / namespace
    d.mkdir(parents=True, exist_ok=True)
    return d / f"{digest}.json"


def get(namespace: str, key: str, ttl_s: float) -> Optional[dict]:
    path = _key_path(namespace, key)
    if not path.exists():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
    if time.time() - payload.get("cached_at", 0) > ttl_s:
        return None
    return payload.get("data")


def set(namespace: str, key: str, data: dict) -> None:
    path = _key_path(namespace, key)
    try:
        path.write_text(json.dumps({"cached_at": time.time(), "data": data}), encoding="utf-8")
    except OSError:
        pass  # cache is a pure optimization — never let a write failure break a request
