"""
Load and parse the LoCoMo dataset from a local JSON cache.

Downloads locomo10.json from the snap-research/locomo GitHub repo on first
use and caches it locally. Normalizes the raw JSON into typed dataclasses.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field

import httpx

from .config import BenchmarkConfig

# ---------------------------------------------------------------------------
# Category name mapping
# ---------------------------------------------------------------------------

CATEGORY_NAMES: dict[int, str] = {
    1: "single-hop",
    2: "multi-hop",
    3: "temporal",
    4: "open-domain",
    5: "adversarial",
}

# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------


@dataclass
class Turn:
    speaker: str
    dia_id: str
    text: str


@dataclass
class Session:
    session_number: int
    date_time: str
    turns: list[Turn]


@dataclass
class QAItem:
    question_id: str
    question: str
    answer: str
    evidence: list[str]
    category: int
    adversarial_answer: str | None = None


@dataclass
class Conversation:
    conversation_id: int
    speaker_a: str
    speaker_b: str
    sessions: list[Session]
    qa: list[QAItem] = field(default_factory=list)


# ---------------------------------------------------------------------------
# Download + cache
# ---------------------------------------------------------------------------


def _download_dataset(config: BenchmarkConfig) -> str:
    """Download locomo10.json if not cached. Returns path to the cached file."""
    cache_path = config.data_cache_path
    if os.path.exists(cache_path):
        return cache_path

    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    print(f"Downloading LoCoMo dataset from {config.data_url}...", file=sys.stderr, flush=True)

    response = httpx.get(config.data_url, follow_redirects=True, timeout=60)
    response.raise_for_status()

    with open(cache_path, "wb") as f:
        f.write(response.content)

    print(f"Cached at {cache_path} ({len(response.content) / 1024:.0f} KB)", file=sys.stderr)
    return cache_path


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _parse_sessions(conv_data: dict) -> list[Session]:
    """Extract session_N and session_N_date_time from a conversation dict."""
    sessions: list[Session] = []
    n = 1
    while f"session_{n}" in conv_data:
        date_key = f"session_{n}_date_time"
        date_time = conv_data.get(date_key, "")
        raw_turns = conv_data[f"session_{n}"]

        turns = []
        for t in raw_turns:
            # Image turns have both img_url and text — keep the text content
            # since it provides context needed for QA evidence
            turns.append(Turn(speaker=t["speaker"], dia_id=t["dia_id"], text=t["text"]))

        sessions.append(Session(session_number=n, date_time=date_time, turns=turns))
        n += 1

    return sessions


def _parse_qa(qa_list: list[dict], conversation_id: int) -> list[QAItem]:
    """Parse QA items, generating stable question IDs."""
    items: list[QAItem] = []
    category_counts: dict[int, int] = {}

    for qa in qa_list:
        cat = qa["category"]
        idx = category_counts.get(cat, 0)
        category_counts[cat] = idx + 1

        question_id = f"conv{conversation_id}_cat{cat}_q{idx}"

        items.append(
            QAItem(
                question_id=question_id,
                question=qa["question"],
                answer=qa.get("answer", ""),
                evidence=qa.get("evidence", []),
                category=cat,
                adversarial_answer=qa.get("adversarial_answer"),
            )
        )

    return items


def load_conversations(config: BenchmarkConfig) -> list[Conversation]:
    """Load and parse all conversations from locomo10.json."""
    cache_path = _download_dataset(config)

    with open(cache_path) as f:
        raw = json.load(f)

    conversations: list[Conversation] = []
    for i, entry in enumerate(raw):
        conv_data = entry["conversation"]
        sessions = _parse_sessions(conv_data)
        qa = _parse_qa(entry.get("qa", []), i)

        conversations.append(
            Conversation(
                conversation_id=i,
                speaker_a=conv_data.get("speaker_a", "Speaker A"),
                speaker_b=conv_data.get("speaker_b", "Speaker B"),
                sessions=sessions,
                qa=qa,
            )
        )

    return conversations
