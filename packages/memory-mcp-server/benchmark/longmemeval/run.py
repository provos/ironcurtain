"""
Main orchestrator for the LongMemEval benchmark harness.

Runs three modes:
  python run.py run [--variant S|M|Oracle] [--resume] [--limit N]
  python run.py evaluate --hypotheses results/run-xxx/hypotheses.jsonl [--variant S|M|Oracle]
  python run.py run+evaluate [--variant S|M|Oracle] [--resume] [--limit N]

All status/progress output goes to stderr. Data output goes to files only.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time

from openai import AsyncOpenAI

from .config import BenchmarkConfig, parse_args
from .dataset import Question, load_questions
from .evaluate import evaluate_all
from .ingest import ingest_question
from .mcp_client import call_recall, memory_server
from .reader import build_reader_client, generate_answer


# ---------------------------------------------------------------------------
# Per-question processing
# ---------------------------------------------------------------------------


async def run_question(
    question: Question, config: BenchmarkConfig, *, reader_client: AsyncOpenAI
) -> dict:
    """Process a single question: ingest haystack, recall context, generate answer."""
    db_path = f"/tmp/longmemeval-{os.getpid()}-{question.question_id}.db"
    try:
        async with memory_server(config, db_path) as session:
            num_stored = await ingest_question(session, question, config)

            context = await call_recall(session, question.question, config)

            hypothesis = await generate_answer(
                context,
                question.question,
                question.question_date,
                config,
                client=reader_client,
            )

            return {
                "question_id": question.question_id,
                "question_type": question.question_type,
                "hypothesis": hypothesis,
                "retrieved_context": context,
                "memories_stored": num_stored,
            }
    finally:
        _cleanup_db(db_path)


def _cleanup_db(db_path: str) -> None:
    """Remove the SQLite database and its WAL/SHM sidecar files."""
    for suffix in ("", "-wal", "-shm"):
        try:
            os.unlink(db_path + suffix)
        except FileNotFoundError:
            pass


# ---------------------------------------------------------------------------
# Checkpoint / resume helpers
# ---------------------------------------------------------------------------


def load_completed_ids(checkpoint_path: str) -> set[str]:
    """Load question_ids already processed from a checkpoint file."""
    completed: set[str] = set()
    if not os.path.exists(checkpoint_path):
        return completed
    with open(checkpoint_path) as f:
        for line in f:
            line = line.strip()
            if line:
                entry = json.loads(line)
                completed.add(entry["question_id"])
    return completed


def append_jsonl(path: str, record: dict) -> None:
    """Atomically append a single JSON record to a JSONL file."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "a") as f:
        json.dump(record, f, separators=(",", ":"))
        f.write("\n")
        f.flush()


def save_config(config: BenchmarkConfig) -> None:
    """Write the frozen config to disk for reproducibility."""
    import dataclasses

    path = os.path.join(config.run_dir, "config.json")
    with open(path, "w") as f:
        json.dump(dataclasses.asdict(config), f, indent=2)


# ---------------------------------------------------------------------------
# Run mode
# ---------------------------------------------------------------------------


async def main_run(config: BenchmarkConfig, questions: list[Question] | None = None) -> str:
    """Execute the full benchmark run. Returns the path to hypotheses.jsonl."""
    if questions is None:
        questions = load_questions(config)

    completed = load_completed_ids(config.checkpoint_path)
    remaining = [q for q in questions if q.question_id not in completed]

    if config.limit is not None:
        remaining = remaining[: config.limit]

    print(f"Dataset: {config.dataset_variant}", file=sys.stderr)
    print(
        f"Questions: {len(remaining)} remaining ({len(completed)} done)",
        file=sys.stderr,
    )
    print(f"Output: {config.run_dir}/", file=sys.stderr)

    os.makedirs(config.run_dir, exist_ok=True)
    save_config(config)

    reader_client = build_reader_client(config)

    for i, question in enumerate(remaining):
        t0 = time.time()
        print(
            f"[{i + 1}/{len(remaining)}] {question.question_id} ({question.question_type})",
            file=sys.stderr,
            end="",
            flush=True,
        )

        result = await run_question(question, config, reader_client=reader_client)
        elapsed = time.time() - t0
        result["elapsed_seconds"] = round(elapsed, 2)

        append_jsonl(
            config.hypotheses_path,
            {
                "question_id": result["question_id"],
                "hypothesis": result["hypothesis"],
            },
        )
        append_jsonl(config.checkpoint_path, result)

        print(f" ({elapsed:.1f}s)", file=sys.stderr, flush=True)

    print(f"\nDone. Hypotheses: {config.hypotheses_path}", file=sys.stderr)
    return config.hypotheses_path


# ---------------------------------------------------------------------------
# Evaluate mode
# ---------------------------------------------------------------------------


async def main_evaluate(
    config: BenchmarkConfig,
    hypotheses_path: str,
    questions: list[Question] | None = None,
) -> None:
    """Run evaluation on a hypotheses file and print summary."""
    if questions is None:
        questions = load_questions(config)
    await evaluate_all(hypotheses_path, questions, config)

    # evaluate_all() already prints summary and writes summary.json + eval-results.jsonl
    print(f"\nEvaluation complete. Results in: {config.run_dir}/", file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------


def _parse_mode_and_hypotheses() -> tuple[str, str | None, list[str]]:
    """Extract mode and --hypotheses from sys.argv before handing off to config parser.

    The mode is a positional argument (run, evaluate, run+evaluate) and
    --hypotheses is only valid for evaluate mode. Both are consumed here
    so that config.parse_args sees only the flags it knows about.

    Returns (mode, hypotheses_path, remaining_argv).
    """
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(
            "usage: python -m longmemeval.run {run,evaluate,run+evaluate} [options]\n"
            "\n"
            "modes:\n"
            "  run           Ingest + recall + generate answers\n"
            "  evaluate      Score existing hypotheses with a judge LLM\n"
            "  run+evaluate  Run then evaluate in one pass\n"
            "\n"
            "evaluate mode requires: --hypotheses PATH\n"
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

    # Extract --hypotheses before passing remaining args to config parser
    remaining = sys.argv[2:]
    hypotheses_path: str | None = None
    if "--hypotheses" in remaining:
        idx = remaining.index("--hypotheses")
        if idx + 1 >= len(remaining):
            print("error: --hypotheses requires a path argument", file=sys.stderr)
            sys.exit(1)
        hypotheses_path = remaining[idx + 1]
        remaining = remaining[:idx] + remaining[idx + 2 :]

    if mode == "evaluate" and hypotheses_path is None:
        print("error: evaluate mode requires --hypotheses PATH", file=sys.stderr)
        sys.exit(1)

    return mode, hypotheses_path, remaining


def main() -> None:
    mode, hypotheses_path, config_argv = _parse_mode_and_hypotheses()
    config = parse_args(config_argv)

    try:
        questions = load_questions(config) if mode == "run+evaluate" else None

        if mode in ("run", "run+evaluate"):
            hypotheses_path = asyncio.run(main_run(config, questions))

        if mode in ("evaluate", "run+evaluate"):
            assert hypotheses_path is not None
            asyncio.run(main_evaluate(config, hypotheses_path, questions))
    except KeyboardInterrupt:
        print(
            f"\nInterrupted. Partial results in: {config.run_dir}/",
            file=sys.stderr,
        )
        sys.exit(130)


if __name__ == "__main__":
    main()
