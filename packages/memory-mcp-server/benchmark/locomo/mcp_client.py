"""
MCP client for the memory server.

Provides an async context manager that starts the memory MCP server as a
subprocess via stdio, connects using the Python MCP SDK, and exposes
typed wrappers for memory_store and memory_recall/memory_context.

Copied from longmemeval.mcp_client (v1 -- will be extracted to shared
benchmark/common/ once patterns stabilize).
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncIterator

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from .config import BenchmarkConfig


@asynccontextmanager
async def memory_server(config: BenchmarkConfig, db_path: str) -> AsyncIterator[ClientSession]:
    """Start the memory MCP server and yield a connected ClientSession."""
    env = {
        **os.environ,
        "MEMORY_DB_PATH": db_path,
        "MEMORY_NAMESPACE": "locomo",
        "MEMORY_LLM_BASE_URL": config.memory_llm_base_url,
        "MEMORY_LLM_MODEL": config.memory_llm_model,
        "MEMORY_LLM_API_KEY": config.memory_llm_api_key,
        # Disable LLM-based maintenance during benchmarking — consolidation
        # would modify stored memories and skew retrieval evaluation.
        "MEMORY_MAINTENANCE_INTERVAL": "999999",
    }

    server_params = StdioServerParameters(
        command=config.server_command,
        args=config.server_args,
        cwd=config.server_cwd,
        env=env,
    )

    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            yield session


async def call_store(
    session: ClientSession,
    content: str,
    tags: list[str],
    importance: float,
) -> str:
    """Store a memory via the memory_store tool."""
    result = await session.call_tool(
        "memory_store",
        {
            "content": content,
            "tags": tags,
            "importance": importance,
        },
    )
    return extract_text(result)


async def call_recall(
    session: ClientSession,
    query: str,
    config: BenchmarkConfig,
) -> str:
    """Retrieve memories using the configured recall tool and parameters."""
    query_key = "task" if config.recall_tool == "memory_context" else "query"
    args: dict[str, object] = {
        query_key: query,
        "token_budget": config.recall_token_budget,
        "format": config.recall_format,
    }

    result = await session.call_tool(config.recall_tool, args)
    return extract_text(result)


async def call_recall_raw(
    session: ClientSession,
    query: str,
    config: BenchmarkConfig,
) -> tuple[str, list[list[str]]]:
    """Retrieve memories in raw format, returning (readable_context, per_memory_tags).

    Uses raw format to get structured output with tags, then reconstructs
    readable context for the reader LLM. This avoids embedding retrieval
    metadata in memory content which would degrade embedding quality.
    """
    import json

    query_key = "task" if config.recall_tool == "memory_context" else "query"
    args: dict[str, object] = {
        query_key: query,
        "token_budget": config.recall_token_budget,
        "format": "raw",
    }

    result = await session.call_tool(config.recall_tool, args)
    raw_text = extract_text(result)

    try:
        memories = json.loads(raw_text)
    except (json.JSONDecodeError, TypeError):
        return raw_text, []

    # Reconstruct readable context for the reader LLM
    # Pull session date from tags (where it's stored) rather than created_at
    # (which is just the ingestion timestamp).
    lines: list[str] = []
    all_tags: list[list[str]] = []
    for m in memories:
        tags = m.get("tags", [])
        date = _extract_tag_value(tags, "date:") or "unknown"
        session = _extract_tag_value(tags, "session:") or "?"
        lines.append(f"- [Session {session}, {date}] {m['content']}")
        all_tags.append(tags)

    readable = "\n".join(lines) if lines else "No relevant memories found."
    return readable, all_tags


def _extract_tag_value(tags: list[str], prefix: str) -> str | None:
    """Return the value after *prefix* from the first matching tag, or None."""
    for t in tags:
        if t.startswith(prefix):
            return t[len(prefix):]
    return None


def extract_text(result: object) -> str:
    """Extract concatenated text from an MCP tool result's content blocks."""
    return "\n".join(block.text for block in result.content if block.type == "text" and block.text)
