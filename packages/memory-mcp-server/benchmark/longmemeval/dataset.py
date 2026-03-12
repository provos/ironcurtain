"""
Load the LongMemEval HuggingFace dataset and normalize into typed dataclass instances.

The cleaned dataset (xiaowu0162/longmemeval-cleaned) has these question types:
  - single-session-user
  - single-session-assistant
  - single-session-preference
  - multi-session
  - temporal-reasoning
  - knowledge-update

Abstention questions are identified by '_abs' suffix in question_id.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass

from datasets import load_dataset

from .config import BenchmarkConfig


@dataclass
class Question:
    question_id: str
    question_type: str
    question: str
    answer: str
    question_date: str
    haystack_sessions: list[list[dict[str, str]]]
    haystack_dates: list[str]
    haystack_session_ids: list[str]
    answer_session_ids: list[str]


def load_questions(config: BenchmarkConfig) -> list[Question]:
    """Load and normalize the LongMemEval dataset into Question instances."""
    print(
        f"Loading dataset {config.dataset_name} ({config.dataset_variant})...",
        file=sys.stderr,
        flush=True,
    )

    ds = load_dataset(config.dataset_name, config.dataset_variant)
    split = ds["test"] if "test" in ds else ds[list(ds.keys())[0]]

    questions: list[Question] = []
    for row in split:
        questions.append(_normalize_row(row))

    print(
        f"Loaded {len(questions)} questions",
        file=sys.stderr,
        flush=True,
    )
    return questions


def _normalize_row(row: dict) -> Question:
    """Convert a single HuggingFace dataset row into a Question.

    The answer field may contain integers (e.g. for temporal reasoning
    questions where the answer is a number of days) -- coerce to str.
    """
    return Question(
        question_id=str(row["question_id"]),
        question_type=str(row["question_type"]),
        question=str(row["question"]),
        answer=str(row["answer"]),
        question_date=str(row["question_date"]),
        haystack_sessions=row["haystack_sessions"],
        haystack_dates=[str(d) for d in row["haystack_dates"]],
        haystack_session_ids=[str(sid) for sid in row["haystack_session_ids"]],
        answer_session_ids=[str(sid) for sid in row["answer_session_ids"]],
    )
