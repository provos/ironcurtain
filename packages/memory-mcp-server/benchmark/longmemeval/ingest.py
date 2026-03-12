"""
Ingest LongMemEval haystack sessions into the memory MCP server.

Each conversation turn becomes a separate memory_store call with session
metadata embedded in both content and tags. This gives the retrieval
pipeline both semantic and tag-based handles on temporal and session info.
"""

from __future__ import annotations

import sys

from mcp import ClientSession

from .config import BenchmarkConfig
from .dataset import Question
from .mcp_client import call_store

MAX_CONTENT_LENGTH = 10_000
_TRUNCATION_SUFFIX = "... [truncated]"
_TRUNCATION_BODY_LIMIT = MAX_CONTENT_LENGTH - len(_TRUNCATION_SUFFIX)


async def ingest_question(
    session: ClientSession,
    question: Question,
    config: BenchmarkConfig,
    *,
    verbose: bool = False,
) -> int:
    """Ingest all haystack sessions for a question. Returns the number of stored turns."""
    stored = 0

    for session_data, date, session_id in zip(
        question.haystack_sessions,
        question.haystack_dates,
        question.haystack_session_ids,
    ):
        for turn in session_data:
            role = turn["role"]

            if not config.store_assistant_turns and role == "assistant":
                continue

            content = _format_content(date, role, turn["content"])
            tags = _build_tags(session_id, date, role)

            await call_store(session, content, tags, config.importance_default)
            stored += 1

    if verbose:
        print(
            f"    Ingested {stored} turns from {len(question.haystack_sessions)} sessions",
            file=sys.stderr,
            flush=True,
        )

    return stored


def _format_content(date: str, role: str, content: str) -> str:
    """Format a turn as a prefixed memory string, truncating if too long."""
    text = f"[Session date: {date}] [{role}]: {content}"

    if len(text) > MAX_CONTENT_LENGTH:
        text = text[:_TRUNCATION_BODY_LIMIT] + _TRUNCATION_SUFFIX

    return text


def _build_tags(session_id: str, date: str, role: str) -> list[str]:
    """Build the tag list for a single turn."""
    # Strip any time component from the date for the tag
    date_only = date.split(" ")[0]
    return [
        f"session:{session_id}",
        f"date:{date_only}",
        f"role:{role}",
    ]
