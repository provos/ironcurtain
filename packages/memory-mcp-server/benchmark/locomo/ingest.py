"""
Ingest LoCoMo conversation sessions into the memory MCP server.

Each conversation turn becomes a separate memory_store call with dia_id
and session metadata embedded in both content and tags. The dia_id tag is
critical for retrieval evaluation against ground-truth evidence.
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

    for sess in conversation.sessions:
        for turn in sess.turns:
            content = _format_content(sess.session_number, sess.date_time, turn.speaker, turn.text)
            tags = _build_tags(turn.dia_id, sess.session_number, sess.date_time, turn.speaker)

            await call_store(session, content, tags, config.importance_default)
            stored += 1

    if verbose:
        print(
            f"    Ingested {stored} turns from {len(conversation.sessions)} sessions",
            file=sys.stderr,
            flush=True,
        )

    return stored


def _format_content(session_number: int, date_time: str, speaker: str, text: str) -> str:
    """Format a turn as a prefixed memory string, truncating if too long."""
    result = f"[Session: {session_number}, Date: {date_time}] [{speaker}]: {text}"

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
