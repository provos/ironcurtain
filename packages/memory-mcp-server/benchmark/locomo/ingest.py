"""
Ingest LoCoMo conversation sessions into the memory MCP server.

Each conversation turn becomes a separate memory_store call. Session metadata
(dia_id, session number, date, speaker) is stored in tags only — not in
content — so that embeddings reflect pure semantic meaning.
"""

from __future__ import annotations

import sys

from mcp import ClientSession

from .config import BenchmarkConfig
from .dataset import Conversation
from .mcp_client import call_store

MAX_CONTENT_LENGTH = 10_000
_TRUNCATION_SUFFIX = "... [truncated]"
_TRUNCATION_BODY_LIMIT = MAX_CONTENT_LENGTH - len(_TRUNCATION_SUFFIX)


async def ingest_conversation(
    session: ClientSession,
    conversation: Conversation,
    config: BenchmarkConfig,
    *,
    verbose: bool = False,
) -> int:
    """Ingest all sessions for a conversation. Returns the number of stored turns."""
    stored = 0
    merged = 0

    for sess in conversation.sessions:
        for turn in sess.turns:
            content = _format_content(turn.speaker, turn.text)
            tags = _build_tags(turn.dia_id, sess.session_number, sess.date_time, turn.speaker)

            result = await call_store(session, content, tags, config.importance_default)
            stored += 1
            if "duplicate" in result.lower() or "merged" in result.lower():
                merged += 1

    if merged > 0:
        print(
            f"    Warning: {merged}/{stored} turns were dedup-merged during ingestion",
            file=sys.stderr,
            flush=True,
        )

    if verbose:
        print(
            f"    Ingested {stored} turns from {len(conversation.sessions)} sessions",
            file=sys.stderr,
            flush=True,
        )

    return stored


def _format_content(speaker: str, text: str) -> str:
    """Format a turn as a memory string, truncating if too long.

    Session and date metadata are stored in tags — keeping them out of the
    content avoids polluting the embedding vector with structural noise.
    """
    result = f"[{speaker}]: {text}"

    if len(result) > MAX_CONTENT_LENGTH:
        result = result[:_TRUNCATION_BODY_LIMIT] + _TRUNCATION_SUFFIX

    return result


def _build_tags(dia_id: str, session_number: int, date_time: str, speaker: str) -> list[str]:
    """Build the tag list for a single turn."""
    return [
        f"dia_id:{dia_id}",
        f"session:{session_number}",
        f"date:{date_time}",
        f"speaker:{speaker}",
    ]
