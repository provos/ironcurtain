"""
Main orchestrator for the LoCoMo benchmark harness.

Runs three modes:
  python -m locomo.run run [--conversation-limit N] [--question-limit N] [--resume]
  python -m locomo.run evaluate --hypotheses results/run-xxx/hypotheses.jsonl
  python -m locomo.run evaluate --hypotheses results/run-xxx/hypotheses.jsonl --retrieval-only
  python -m locomo.run run+evaluate [--conversation-limit N] [--resume]

All status/progress output goes to stderr. Data output goes to files only.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time

from openai import AsyncOpenAI

from .config import BenchmarkConfig, parse_args
from .dataset import Conversation, load_conversations
from .ingest import ingest_conversation
from .mcp_client import call_recall, memory_server
from .reader import build_reader_client, generate_answer
from .retrieval_metrics import (
    compute_retrieval_summary,
    print_retrieval_summary,
    score_retrieval,
    write_retrieval_summary,
)
from .scoring import ADVERSARIAL_CATEGORY, compute_metrics, score_question


# ---------------------------------------------------------------------------
# Per-conversation processing
# ---------------------------------------------------------------------------


async def run_conversation(
    conversation: Conversation,
    config: BenchmarkConfig,
    *,
    reader_client: AsyncOpenAI,
) -> dict:
    """Process a single conversation: ingest all sessions, then run all QA."""
    db_path = f"/tmp/locomo-{os.getpid()}-conv{conversation.conversation_id}.db"
    try:
        async with memory_server(config, db_path) as session:
            num_stored = await ingest_conversation(session, conversation, config)

            questions = conversation.qa
            if config.question_limit is not None:
                questions = questions[: config.question_limit]

            qa_results: list[dict] = []
            for qa in questions:
                t0 = time.time()
                context = await call_recall(session, qa.question, config)
                hypothesis = await generate_answer(
                    context, qa.question, config, client=reader_client
                )
                elapsed = time.time() - t0

                qa_results.append(
                    {
                        "question_id": qa.question_id,
                        "question": qa.question,
                        "answer": qa.answer,
                        "category": qa.category,
                        "evidence": qa.evidence,
                        "adversarial_answer": qa.adversarial_answer,
                        "hypothesis": hypothesis,
                        "retrieved_context": context,
                        "elapsed_seconds": round(elapsed, 2),
                    }
                )

            return {
                "conversation_id": conversation.conversation_id,
                "speaker_a": conversation.speaker_a,
                "speaker_b": conversation.speaker_b,
                "sessions_ingested": len(conversation.sessions),
                "turns_stored": num_stored,
                "questions": qa_results,
                "db_path": db_path,
            }
    finally:
        if not config.keep_db:
            _cleanup_db(db_path)


def _cleanup_db(db_path: str) -> None:
    """Remove the SQLite database and its WAL/SHM sidecar files."""
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(db_path + suffix)
        except FileNotFoundError:
            pass


def _preserve_db(db_path: str, run_dir: str, conversation_id: int) -> None:
    """Move the SQLite database into the run directory for inspection."""
    db_dir = os.path.join(run_dir, "dbs")
    os.makedirs(db_dir, exist_ok=True)
    dest = os.path.join(db_dir, f"conversation_{conversation_id}.db")
    try:
        shutil.move(db_path, dest)
    except FileNotFoundError:
        pass
    for suffix in ("-wal", "-shm"):
        try:
            os.unlink(db_path + suffix)
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------------------
# Checkpoint / resume helpers
# ---------------------------------------------------------------------------


def load_completed_ids(checkpoint_path: str) -> set[int]:
    """Load conversation_ids already processed from a checkpoint file."""
    completed: set[int] = set()
    if not os.path.exists(checkpoint_path):
        return completed
    with open(checkpoint_path) as f:
        for line in f:
            line = line.strip()
            if line:
                entry = json.loads(line)
                completed.add(entry["conversation_id"])
    return completed


def append_jsonl(path: str, record: dict) -> None:
    """Atomically append a single JSON record to a JSONL file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        json.dump(record, f, separators=(",", ":"))
        f.write("\n")
        f.flush()


_REDACTED_FIELDS = {"reader_api_key", "memory_llm_api_key"}


def save_config(config: BenchmarkConfig) -> None:
    """Write the frozen config to disk for reproducibility (API keys redacted)."""
    import dataclasses

    data = dataclasses.asdict(config)
    for key in _REDACTED_FIELDS:
        if key in data:
            data[key] = "***"

    path = os.path.join(config.run_dir, "config.json")
    os.makedirs(config.run_dir, exist_ok=True)
    with open(path, "w") as f:
        json.dump(data, f, indent=2)


# ---------------------------------------------------------------------------
# Run mode
# ---------------------------------------------------------------------------


async def main_run(
    config: BenchmarkConfig, conversations: list[Conversation] | None = None
) -> str:
    """Execute the full benchmark run. Returns the path to hypotheses.jsonl."""
    if conversations is None:
        conversations = load_conversations(config)

    completed = load_completed_ids(config.checkpoint_path) if config.resume else set()
    remaining = [c for c in conversations if c.conversation_id not in completed]

    if config.conversation_limit is not None:
        remaining = remaining[: config.conversation_limit]

    total_qa = sum(len(c.qa) for c in remaining)
    print(f"Conversations: {len(remaining)} remaining ({len(completed)} done)", file=sys.stderr)
    print(f"Total questions: ~{total_qa}", file=sys.stderr)
    print(f"Output: {config.run_dir}/", file=sys.stderr)

    os.makedirs(config.run_dir, exist_ok=True)
    save_config(config)

    reader_client = build_reader_client(config)
    all_retrieval_results: list[dict] = []
    all_retrieval_categories: list[int] = []

    for i, conv in enumerate(remaining):
        t0 = time.time()
        print(
            f"\n[{i + 1}/{len(remaining)}] Conversation {conv.conversation_id} "
            f"({conv.speaker_a} & {conv.speaker_b}, "
            f"{len(conv.sessions)} sessions, {len(conv.qa)} questions)",
            file=sys.stderr,
            flush=True,
        )

        result = await run_conversation(conv, config, reader_client=reader_client)
        elapsed = time.time() - t0
        result["elapsed_seconds"] = round(elapsed, 2)

        # Score retrieval for non-adversarial questions
        for qa_result in result["questions"]:
            if qa_result["category"] != ADVERSARIAL_CATEGORY and qa_result["evidence"]:
                ret_score = score_retrieval(qa_result["retrieved_context"], qa_result["evidence"])
                qa_result["retrieval"] = ret_score
                all_retrieval_results.append(ret_score)
                all_retrieval_categories.append(qa_result["category"])

        if config.keep_db:
            _preserve_db(result.pop("db_path"), config.run_dir, conv.conversation_id)
        else:
            result.pop("db_path", None)

        # Write per-question hypotheses
        for qa_result in result["questions"]:
            append_jsonl(
                config.hypotheses_path,
                {
                    "question_id": qa_result["question_id"],
                    "hypothesis": qa_result["hypothesis"],
                },
            )

        # Checkpoint the full conversation result
        append_jsonl(config.checkpoint_path, result)

        n_questions = len(result["questions"])
        print(
            f"  Done: {result['turns_stored']} turns ingested, "
            f"{n_questions} questions answered ({elapsed:.1f}s)",
            file=sys.stderr,
            flush=True,
        )

    # Write retrieval summary
    if all_retrieval_results:
        ret_summary = compute_retrieval_summary(all_retrieval_results, all_retrieval_categories)
        write_retrieval_summary(config.run_dir, ret_summary)
        print_retrieval_summary(ret_summary)

    print(f"\nDone. Hypotheses: {config.hypotheses_path}", file=sys.stderr)
    return config.hypotheses_path


# ---------------------------------------------------------------------------
# Evaluate mode
# ---------------------------------------------------------------------------


def _resolve_checkpoint(hypotheses_path: str, label: str) -> tuple[str, str]:
    """Derive checkpoint path from hypotheses path. Exits on missing file."""
    run_dir = os.path.dirname(hypotheses_path)
    checkpoint_path = os.path.join(run_dir, "checkpoint.jsonl")
    if not os.path.exists(checkpoint_path):
        print(
            f"error: checkpoint file not found at {checkpoint_path}\n"
            f"  {label} requires a checkpoint.jsonl",
            file=sys.stderr,
        )
        sys.exit(1)
    return run_dir, checkpoint_path


def _iter_checkpoint_qa(checkpoint_path: str):
    """Yield individual QA dicts from a conversation-level checkpoint file."""
    with open(checkpoint_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            yield from entry.get("questions", [])


async def main_evaluate(
    config: BenchmarkConfig,
    hypotheses_path: str,
    conversations: list[Conversation] | None = None,
) -> None:
    """Run F1 evaluation on checkpoint.jsonl and print summary."""
    run_dir, checkpoint_path = _resolve_checkpoint(hypotheses_path, "evaluate mode")

    qa_scores: list[dict] = []
    retrieval_results: list[dict] = []
    retrieval_categories: list[int] = []

    for qa in _iter_checkpoint_qa(checkpoint_path):
        score = score_question(
            qa["hypothesis"],
            qa["answer"],
            qa["category"],
            qa.get("adversarial_answer"),
        )
        score["question_id"] = qa["question_id"]
        qa_scores.append(score)

        if qa["category"] != ADVERSARIAL_CATEGORY and qa.get("evidence"):
            ret_score = score_retrieval(qa.get("retrieved_context", ""), qa["evidence"])
            retrieval_results.append(ret_score)
            retrieval_categories.append(qa["category"])

    # Compute and write QA metrics
    summary = compute_metrics(qa_scores)
    _print_qa_summary(summary)

    summary_path = os.path.join(run_dir, "summary.json")
    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")

    # Write per-question eval results
    eval_path = os.path.join(run_dir, "eval-results.jsonl")
    with open(eval_path, "w") as f:
        for score in qa_scores:
            json.dump(score, f, separators=(",", ":"))
            f.write("\n")

    # Compute and write retrieval metrics
    if retrieval_results:
        ret_summary = compute_retrieval_summary(retrieval_results, retrieval_categories)
        write_retrieval_summary(run_dir, ret_summary)
        print_retrieval_summary(ret_summary)

    print(f"\nEvaluation complete. Results in: {run_dir}/", file=sys.stderr)


def main_retrieval_only(
    config: BenchmarkConfig,
    hypotheses_path: str,
) -> None:
    """Compute retrieval metrics from checkpoint.jsonl without scoring QA."""
    run_dir, checkpoint_path = _resolve_checkpoint(hypotheses_path, "--retrieval-only")

    retrieval_results: list[dict] = []
    retrieval_categories: list[int] = []

    for qa in _iter_checkpoint_qa(checkpoint_path):
        if qa["category"] != ADVERSARIAL_CATEGORY and qa.get("evidence"):
            ret_score = score_retrieval(qa.get("retrieved_context", ""), qa["evidence"])
            retrieval_results.append(ret_score)
            retrieval_categories.append(qa["category"])

    if not retrieval_results:
        print("No non-adversarial questions with evidence found.", file=sys.stderr)
        return

    summary = compute_retrieval_summary(retrieval_results, retrieval_categories)
    write_retrieval_summary(run_dir, summary)
    print_retrieval_summary(summary)


def _print_qa_summary(summary: dict) -> None:
    """Print QA metrics to stderr."""
    print("\n=== QA Summary ===", file=sys.stderr)
    print(f"Overall F1:             {summary['overall_f1']:.1%}", file=sys.stderr)
    print(f"Overall accuracy:       {summary['overall_accuracy']:.1%}", file=sys.stderr)
    print(
        f"Adversarial accuracy:   {summary['adversarial_accuracy']:.1%}",
        file=sys.stderr,
    )
    print(f"Questions evaluated:    {summary['question_count']}", file=sys.stderr)

    if summary.get("per_category"):
        print("\nPer-category breakdown:", file=sys.stderr)
        for cat_id in sorted(summary["per_category"]):
            cat = summary["per_category"][cat_id]
            f1_str = f"F1={cat['mean_f1']:.1%}" if cat_id != ADVERSARIAL_CATEGORY else "F1=n/a"
            print(
                f"  {cat['category_name']:15s}  "
                f"{f1_str:12s}  "
                f"acc={cat['accuracy']:.1%}  "
                f"n={cat['count']}",
                file=sys.stderr,
            )

    print(file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _parse_mode_and_hypotheses() -> tuple[str, str | None, bool, list[str]]:
    """Extract mode, --hypotheses, and --retrieval-only from sys.argv."""
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(
            "usage: locomo {run,evaluate,run+evaluate} [options]\n"
            "\n"
            "modes:\n"
            "  run           Ingest conversations + recall + generate answers\n"
            "  evaluate      Score existing results (F1 + retrieval metrics)\n"
            "  run+evaluate  Run then evaluate in one pass\n"
            "\n"
            "evaluate mode requires: --hypotheses PATH\n"
            "evaluate mode accepts:  --retrieval-only (skip QA scoring, only retrieval metrics)\n"
            "\n"
            "Run with <mode> --help for full option list.",
            file=sys.stderr,
        )
        sys.exit(0 if "--help" in sys.argv or "-h" in sys.argv else 1)

    mode = sys.argv[1]
    valid_modes = ("run", "evaluate", "run+evaluate")
    if mode not in valid_modes:
        print(
            f"error: unknown mode '{mode}'. Choose from: {', '.join(valid_modes)}",
            file=sys.stderr,
        )
        sys.exit(1)

    remaining = sys.argv[2:]
    hypotheses_path: str | None = None
    retrieval_only = False

    if "--hypotheses" in remaining:
        idx = remaining.index("--hypotheses")
        if idx + 1 >= len(remaining):
            print("error: --hypotheses requires a path argument", file=sys.stderr)
            sys.exit(1)
        hypotheses_path = remaining[idx + 1]
        remaining = remaining[:idx] + remaining[idx + 2 :]

    if "--retrieval-only" in remaining:
        idx = remaining.index("--retrieval-only")
        retrieval_only = True
        remaining = remaining[:idx] + remaining[idx + 1 :]

    if mode == "evaluate" and hypotheses_path is None:
        print("error: evaluate mode requires --hypotheses PATH", file=sys.stderr)
        sys.exit(1)

    if retrieval_only and mode != "evaluate":
        print(
            "error: --retrieval-only is only valid with evaluate mode",
            file=sys.stderr,
        )
        sys.exit(1)

    return mode, hypotheses_path, retrieval_only, remaining


def main() -> None:
    mode, hypotheses_path, retrieval_only, config_argv = _parse_mode_and_hypotheses()
    config = parse_args(config_argv)

    try:
        conversations = load_conversations(config) if mode == "run+evaluate" else None

        if mode in ("run", "run+evaluate"):
            hypotheses_path = asyncio.run(main_run(config, conversations))

        if mode in ("evaluate", "run+evaluate"):
            assert hypotheses_path is not None
            if retrieval_only:
                main_retrieval_only(config, hypotheses_path)
            else:
                asyncio.run(main_evaluate(config, hypotheses_path, conversations))
    except KeyboardInterrupt:
        print(
            f"\nInterrupted. Partial results in: {config.run_dir}/",
            file=sys.stderr,
        )
        sys.exit(130)


if __name__ == "__main__":
    main()
