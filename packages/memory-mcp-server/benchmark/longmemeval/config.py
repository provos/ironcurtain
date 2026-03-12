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

# ---------------------------------------------------------------------------
# Variant mapping: CLI name -> HuggingFace dataset config name
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
_DEFAULT_ANTHROPIC_JUDGE_MODEL = "claude-haiku-4-5-20251001"


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
    recall_format: str = "list"

    # Reader LLM
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
    resume: bool = False

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
        help="Only run the first N questions (for testing)",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from checkpoint (requires matching run_id via --output-dir)",
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
        default=2000,
        help="Token budget for recall (default: 2000)",
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

    # Resolve judge configuration based on provider
    if args.judge_provider == "anthropic":
        judge_base_url = "https://api.anthropic.com/v1"
        judge_model = (
            args.judge_model
            if args.judge_model != _DEFAULT_JUDGE_MODEL
            else _DEFAULT_ANTHROPIC_JUDGE_MODEL
        )
        judge_api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    else:
        judge_base_url = _DEFAULT_OLLAMA_URL
        judge_model = args.judge_model
        judge_api_key = "ollama"

    return BenchmarkConfig(
        dataset_variant=VARIANT_MAP[args.variant],
        limit=args.limit,
        resume=args.resume,
        output_dir=args.output_dir,
        recall_tool=args.recall_tool,
        recall_format=args.recall_format,
        recall_token_budget=args.recall_budget,
        memory_llm_model=args.memory_llm_model,
        reader_model=args.reader_model,
        judge_provider=args.judge_provider,
        judge_base_url=judge_base_url,
        judge_model=judge_model,
        judge_api_key=judge_api_key,
    )
