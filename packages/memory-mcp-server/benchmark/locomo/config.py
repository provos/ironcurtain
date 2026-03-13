"""
Benchmark configuration for LoCoMo evaluation.

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
# Defaults
# ---------------------------------------------------------------------------

_DEFAULT_MEMORY_LLM_MODEL = "hadad/LFM2.5-1.2B:Q8_0"
_DEFAULT_READER_MODEL = "gemma3:27b"
_DEFAULT_OLLAMA_URL = "http://localhost:11434/v1"
_DEFAULT_ANTHROPIC_MODEL = "claude-haiku-4-5-20251001"

_DATA_URL = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"


def _resolve_server_cwd() -> str:
    """Resolve absolute path to packages/memory-mcp-server from this file's location."""
    # This file lives at packages/memory-mcp-server/benchmark/locomo/config.py
    return str(Path(__file__).resolve().parent.parent.parent)


def _make_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")


# ---------------------------------------------------------------------------
# Configuration dataclass
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class BenchmarkConfig:
    # Dataset
    data_url: str = _DATA_URL
    data_cache_path: str = "./data/locomo10.json"

    # Memory MCP server
    server_command: str = "node"
    server_args: list[str] = field(default_factory=lambda: ["dist/index.js"])
    server_cwd: str = field(default_factory=_resolve_server_cwd)
    memory_llm_base_url: str = _DEFAULT_OLLAMA_URL
    memory_llm_model: str = _DEFAULT_MEMORY_LLM_MODEL
    memory_llm_api_key: str = "ollama"

    # Retrieval
    recall_token_budget: int = 1000
    recall_tool: str = "memory_recall"
    recall_format: str = "list"

    # Reader LLM
    reader_provider: str = "ollama"
    reader_base_url: str = _DEFAULT_OLLAMA_URL
    reader_model: str = _DEFAULT_READER_MODEL
    reader_api_key: str = "ollama"
    reader_max_tokens: int = 500

    # Output
    output_dir: str = "./results"
    run_id: str = field(default_factory=_make_run_id)

    # Ingestion
    importance_default: float = 0.5

    # Execution
    conversation_limit: int | None = None
    question_limit: int | None = None
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
        description="LoCoMo benchmark harness for the memory MCP server"
    )

    parser.add_argument(
        "--conversation-limit",
        type=int,
        default=None,
        help="Only process the first N conversations",
    )
    parser.add_argument(
        "--question-limit",
        type=int,
        default=None,
        help="Only evaluate the first N questions per conversation",
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
        choices=["summary", "list", "raw"],
        default="list",
        help="Format parameter for the recall tool",
    )
    parser.add_argument(
        "--recall-budget",
        type=int,
        default=1000,
        help="Token budget for recall (default: 1000)",
    )

    # Model options
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
        default="ollama",
        help="Reader LLM provider",
    )

    args = parser.parse_args(argv)

    reader_base_url, reader_model, reader_api_key = _resolve_provider(
        args.reader_provider, args.reader_model, _DEFAULT_READER_MODEL
    )

    return BenchmarkConfig(
        conversation_limit=args.conversation_limit,
        question_limit=args.question_limit,
        resume=args.resume,
        keep_db=args.keep_db,
        output_dir=args.output_dir,
        recall_tool=args.recall_tool,
        recall_format=args.recall_format,
        recall_token_budget=args.recall_budget,
        memory_llm_model=args.memory_llm_model,
        reader_provider=args.reader_provider,
        reader_base_url=reader_base_url,
        reader_model=reader_model,
        reader_api_key=reader_api_key,
    )
