"""
MCP client for the memory server.

Provides an async context manager that starts the memory MCP server as a
subprocess via stdio, connects using the Python MCP SDK, and exposes
typed wrappers for memory_store and memory_recall/memory_context.
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
    """Start the memory MCP server and yield a connected ClientSession.

    The server process is cleaned up when the context manager exits.
    """
    env = {
        **os.environ,
        "MEMORY_DB_PATH": db_path,
        "MEMORY_NAMESPACE": "longmemeval",
        "MEMORY_LLM_BASE_URL": config.memory_llm_base_url,
        "MEMORY_LLM_MODEL": config.memory_llm_model,
        "MEMORY_LLM_API_KEY": config.memory_llm_api_key,
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
    # memory_recall uses "query", memory_context uses "task"
    query_key = "task" if config.recall_tool == "memory_context" else "query"
    args: dict[str, object] = {
        query_key: query,
        "token_budget": config.recall_token_budget,
        "format": config.recall_format,
    }

    result = await session.call_tool(config.recall_tool, args)
    return extract_text(result)


def extract_text(result: object) -> str:
    """Extract concatenated text from an MCP tool result's content blocks."""
    return "\n".join(block.text for block in result.content if block.type == "text" and block.text)
