"""
Benchmark configuration for LongMemEval evaluation.

All tunable constants live here. CLI argument parsing produces a
frozen BenchmarkConfig dataclass used throughout the harness.
"""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# ---------------------------------------------------------------------------
# Variant mapping: CLI name -> HuggingFace dataset JSON filename (without .json)
# ---------------------------------------------------------------------------

VARIANT_MAP: dict[str, str] = {
    "S": "longmemeval_s_cleaned",
    "M": "longmemeval_m_cleaned",
    "Oracle": "longmemeval_oracle",
}

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_MEMORY_LLM_MODEL = "hadad/LFM2.5-1.2B:Q8_0"
_DEFAULT_READER_MODEL = "gemma3:27b"
_DEFAULT_JUDGE_MODEL = "gemma3:27b"
_DEFAULT_OLLAMA_URL = "http://localhost:11434/v1"
_DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"


def _resolve_server_cwd() -> str:
    """Resolve absolute path to packages/memory-mcp-server from this file's location."""
    # This file lives at packages/memory-mcp-server/benchmark/longmemeval/config.py
    return str(Path(__file__).resolve().parent.parent.parent)


def _make_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


# ---------------------------------------------------------------------------
# Configuration dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BenchmarkConfig:
    # Dataset
    dataset_name: str = "xiaowu0162/longmemeval-cleaned"
    dataset_variant: str = "longmemeval_s_cleaned"

    # Memory MCP server
    server_command: str = "node"
    server_args: list[str] = field(default_factory=lambda: ["dist/index.js"])
    server_cwd: str = field(default_factory=_resolve_server_cwd)
    memory_llm_base_url: str = _DEFAULT_OLLAMA_URL
    memory_llm_model: str = _DEFAULT_MEMORY_LLM_MODEL
    memory_llm_api_key: str = "ollama"

    # Retrieval
    recall_token_budget: int = 2000
    recall_tool: str = "memory_recall"
    recall_format: str = "answer"

    # Reader LLM (only used when recall_format != "answer")
    reader_provider: str | None = None
    reader_base_url: str = _DEFAULT_OLLAMA_URL
    reader_model: str = _DEFAULT_READER_MODEL
    reader_api_key: str = "ollama"
    reader_max_tokens: int = 500

    # Judge LLM
    judge_provider: str = "ollama"  # "ollama" or "anthropic"
    judge_base_url: str = _DEFAULT_OLLAMA_URL
    judge_model: str = _DEFAULT_JUDGE_MODEL
    judge_api_key: str = "ollama"

    # Output
    output_dir: str = "./results"
    run_id: str = field(default_factory=_make_run_id)

    # Ingestion
    store_assistant_turns: bool = True
    importance_default: float = 0.5

    # Execution
    limit: int | None = None
    question_types: list[str] | None = None
    resume: bool = False
    keep_db: bool = False

    @property
    def run_dir(self) -> str:
        return os.path.join(self.output_dir, self.run_id)

    @property
    def checkpoint_path(self) -> str:
        return os.path.join(self.run_dir, "checkpoint.jsonl")

    @property
    def hypotheses_path(self) -> str:
        return os.path.join(self.run_dir, "hypotheses.jsonl")


# ---------------------------------------------------------------------------
# CLI argument parsing
# ---------------------------------------------------------------------------


def _resolve_provider(
    provider: str, model: str, default_ollama_model: str
) -> tuple[str, str, str]:
    """Resolve base_url, model, and api_key for a provider choice."""
    if provider == "anthropic":
        base_url = "https://api.anthropic.com/v1"
        resolved_model = model if model != default_ollama_model else _DEFAULT_ANTHROPIC_MODEL
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        return base_url, resolved_model, api_key
    return _DEFAULT_OLLAMA_URL, model, "ollama"


def parse_args(argv: list[str] | None = None) -> BenchmarkConfig:
    """Parse CLI arguments and return a frozen BenchmarkConfig."""
    parser = argparse.ArgumentParser(
        description="LongMemEval benchmark harness for the memory MCP server"
    )

    parser.add_argument(
        "--variant",
        choices=list(VARIANT_MAP.keys()),
        default="S",
        help="Dataset variant: S (~40 sessions/q), M (~500), Oracle (evidence only)",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=None,
        help="Only run the first N questions (after type filtering)",
    )
    parser.add_argument(
        "--question-type",
        action="append",
        dest="question_types",
        metavar="TYPE",
        help="Filter to specific question types (can be repeated). "
        "Types: single-session-user, single-session-assistant, "
        "single-session-preference, multi-session, temporal-reasoning, "
        "knowledge-update",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from checkpoint (requires matching run_id via --output-dir)",
    )
    parser.add_argument(
        "--keep-db",
        action="store_true",
        help="Preserve SQLite databases in the run directory for inspection",
    )
    parser.add_argument(
        "--output-dir",
        default="./results",
        help="Output directory for results (default: ./results)",
    )

    # Retrieval options
    parser.add_argument(
        "--recall-tool",
        choices=["memory_recall", "memory_context"],
        default="memory_recall",
        help="Which MCP tool to use for retrieval",
    )
    parser.add_argument(
        "--recall-format",
        choices=["summary", "list", "raw", "answer"],
        default="answer",
        help="Format parameter for the recall tool (default: answer, which uses the memory server's LLM to answer directly)",
    )
    parser.add_argument(
        "--recall-budget",
        type=int,
        default=2000,
        help="Token budget for recall (default: 2000)",
    )

    # Model options
    parser.add_argument(
        "--memory-llm-provider",
        choices=["ollama", "anthropic"],
        default="ollama",
        help="Provider for the memory server's internal LLM (used for summarization and format=answer)",
    )
    parser.add_argument(
        "--memory-llm-model",
        default=_DEFAULT_MEMORY_LLM_MODEL,
        help="Model for the memory server's internal LLM",
    )
    parser.add_argument(
        "--reader-model",
        default=_DEFAULT_READER_MODEL,
        help="Reader LLM model name",
    )
    parser.add_argument(
        "--reader-provider",
        choices=["ollama", "anthropic"],
        default=None,
        help="Reader LLM provider. Only needed when --recall-format is not 'answer'. If set, uses a separate reader LLM instead of the memory server's built-in answer format.",
    )
    parser.add_argument(
        "--judge-model",
        default=_DEFAULT_JUDGE_MODEL,
        help="Judge LLM model name",
    )
    parser.add_argument(
        "--judge-provider",
        choices=["ollama", "anthropic"],
        default="ollama",
        help="Judge LLM provider",
    )

    args = parser.parse_args(argv)

    memory_llm_base_url, memory_llm_model, memory_llm_api_key = _resolve_provider(
        args.memory_llm_provider, args.memory_llm_model, _DEFAULT_MEMORY_LLM_MODEL
    )
    judge_base_url, judge_model, judge_api_key = _resolve_provider(
        args.judge_provider, args.judge_model, _DEFAULT_JUDGE_MODEL
    )

    # Resolve reader config only when a reader provider is explicitly set
    reader_provider = args.reader_provider
    if reader_provider is not None:
        reader_base_url, reader_model, reader_api_key = _resolve_provider(
            reader_provider, args.reader_model, _DEFAULT_READER_MODEL
        )
    else:
        reader_base_url = _DEFAULT_OLLAMA_URL
        reader_model = args.reader_model
        reader_api_key = "ollama"

    # When a reader provider is set but recall_format is "answer", switch to
    # "list" so the separate reader LLM receives raw context to work with.
    recall_format = args.recall_format
    if reader_provider is not None and recall_format == "answer":
        recall_format = "list"

    return BenchmarkConfig(
        dataset_variant=VARIANT_MAP[args.variant],
        limit=args.limit,
        question_types=args.question_types,
        resume=args.resume,
        keep_db=args.keep_db,
        output_dir=args.output_dir,
        recall_tool=args.recall_tool,
        recall_format=recall_format,
        recall_token_budget=args.recall_budget,
        memory_llm_base_url=memory_llm_base_url,
        memory_llm_model=memory_llm_model,
        memory_llm_api_key=memory_llm_api_key,
        reader_provider=reader_provider,
        reader_base_url=reader_base_url,
        reader_model=reader_model,
        reader_api_key=reader_api_key,
        judge_provider=args.judge_provider,
        judge_base_url=judge_base_url,
        judge_model=judge_model,
        judge_api_key=judge_api_key,
    )
