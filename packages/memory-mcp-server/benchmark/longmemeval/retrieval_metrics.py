"""
Retrieval-only evaluation metrics for the LongMemEval benchmark.

Scores whether the memory MCP server retrieved the correct haystack sessions,
independent of whether the reader LLM answered correctly. Uses session dates
embedded in the retrieved context to map back to session IDs.
"""

from __future__ import annotations

import json
import os
import re
import sys

from .dataset import Question

# Matches the date format used in ingest.py: [Session date: 2023/05/30 (Tue) 17:27]
_SESSION_DATE_RE = re.compile(r"\[Session date:\s*([^\]]+)\]")


def _extract_retrieved_dates(context: str) -> set[str]:
    """Extract all session date strings from retrieved context."""
    return set(_SESSION_DATE_RE.findall(context))


def _build_date_to_session_map(question: Question) -> dict[str, str]:
    """Build a mapping from haystack date string to session ID.

    Each question has parallel lists: haystack_dates[i] corresponds to
    haystack_session_ids[i].
    """
    return dict(zip(question.haystack_dates, question.haystack_session_ids))


def score_retrieval(retrieved_context: str, question: Question) -> dict:
    """Score retrieval quality for a single question.

    Returns dict with:
    - session_recall: fraction of answer sessions found in retrieved context
    - answer_in_context: whether ground-truth answer text appears in context
    - retrieved_session_count: total number of distinct sessions in retrieved context
    - answer_session_count: number of answer sessions found
    - total_answer_sessions: number of answer sessions expected
    - precision: fraction of retrieved sessions that are answer sessions
    """
    date_to_session = _build_date_to_session_map(question)
    retrieved_dates = _extract_retrieved_dates(retrieved_context)

    # Map retrieved dates back to session IDs
    retrieved_sessions = {date_to_session[d] for d in retrieved_dates if d in date_to_session}

    answer_sessions = set(question.answer_session_ids)
    found_answer_sessions = retrieved_sessions & answer_sessions

    total_answer = len(answer_sessions)
    found_count = len(found_answer_sessions)
    retrieved_count = len(retrieved_sessions)

    session_recall = found_count / total_answer if total_answer > 0 else 1.0
    precision = found_count / retrieved_count if retrieved_count > 0 else 0.0

    # Check if ground-truth answer text appears verbatim in context
    answer_in_context = question.answer.lower() in retrieved_context.lower()

    return {
        "question_id": question.question_id,
        "question_type": question.question_type,
        "session_recall": session_recall,
        "answer_in_context": answer_in_context,
        "retrieved_session_count": retrieved_count,
        "answer_session_count": found_count,
        "total_answer_sessions": total_answer,
        "precision": precision,
    }


def compute_retrieval_summary(results: list[dict]) -> dict:
    """Aggregate per-question retrieval scores into summary metrics.

    Returns:
    - mean_session_recall: average session recall across questions
    - answer_text_recall: fraction of questions where answer text was in context
    - mean_precision: average precision across questions
    - perfect_retrieval: fraction of questions with session_recall == 1.0
    """
    if not results:
        return {
            "mean_session_recall": 0.0,
            "answer_text_recall": 0.0,
            "mean_precision": 0.0,
            "perfect_retrieval": 0.0,
            "question_count": 0,
        }

    n = len(results)
    mean_session_recall = sum(r["session_recall"] for r in results) / n
    answer_text_recall = sum(1 for r in results if r["answer_in_context"]) / n
    mean_precision = sum(r["precision"] for r in results) / n
    perfect_retrieval = sum(1 for r in results if r["session_recall"] == 1.0) / n

    return {
        "mean_session_recall": mean_session_recall,
        "answer_text_recall": answer_text_recall,
        "mean_precision": mean_precision,
        "perfect_retrieval": perfect_retrieval,
        "question_count": n,
    }


def print_retrieval_summary(summary: dict) -> None:
    """Print retrieval summary metrics to stderr."""
    print("\n=== Retrieval Summary ===", file=sys.stderr)
    print(
        f"Mean session recall:   {summary['mean_session_recall']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Answer text recall:    {summary['answer_text_recall']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Mean precision:        {summary['mean_precision']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Perfect retrieval:     {summary['perfect_retrieval']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Questions evaluated:   {summary['question_count']}",
        file=sys.stderr,
        flush=True,
    )


def write_retrieval_summary(run_dir: str, summary: dict) -> str:
    """Write retrieval summary to a JSON file. Returns the output path."""
    path = os.path.join(run_dir, "retrieval-summary.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")
    print(f"Retrieval summary written to {path}", file=sys.stderr, flush=True)
    return path


def evaluate_retrieval_from_checkpoint(
    checkpoint_path: str, questions: list[Question]
) -> tuple[list[dict], dict]:
    """Compute retrieval metrics from checkpoint.jsonl without running the judge.

    Returns (per_question_results, summary).
    """
    ref_by_id = {q.question_id: q for q in questions}

    results: list[dict] = []
    with open(checkpoint_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            qid = entry["question_id"]

            # Skip abstention questions -- they have no answer sessions
            if "_abs" in qid:
                continue

            question = ref_by_id.get(qid)
            if question is None:
                print(
                    f"  Warning: checkpoint entry {qid} has no matching question, skipping",
                    file=sys.stderr,
                    flush=True,
                )
                continue

            context = entry.get("retrieved_context", "")
            results.append(score_retrieval(context, question))

    summary = compute_retrieval_summary(results)
    return results, summary
