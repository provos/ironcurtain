# LoCoMo Benchmark

Evaluates the memory MCP server against the [LoCoMo](https://github.com/snap-research/locomo) benchmark (10 conversations, ~750 QA questions, 5 question categories).

## Prerequisites

- Memory MCP server built: `cd ../.. && npm run build`
- Ollama running with models pulled:
  - `ollama pull hadad/LFM2.5-1.2B:Q8_0` (memory server LLM)
  - `ollama pull gemma3:27b` (reader LLM, only needed when using Ollama as provider)
- Python 3.11+ with [uv](https://docs.astral.sh/uv/) installed
- `ANTHROPIC_API_KEY` in `.env` (only needed when using `--reader-provider anthropic`)

## Setup

```bash
cd packages/memory-mcp-server/benchmark
uv sync
```

## Usage

```bash
cd packages/memory-mcp-server/benchmark

# Run benchmark (all 10 conversations)
uv run locomo run

# Run with limits (for testing)
uv run locomo run --conversation-limit 1 --question-limit 5

# Resume an interrupted run
uv run locomo run --resume --output-dir ./results/<run_id>

# Evaluate existing results (F1 scoring + retrieval metrics)
uv run locomo evaluate --hypotheses results/<run_id>/hypotheses.jsonl

# Retrieval metrics only (no QA scoring)
uv run locomo evaluate --hypotheses results/<run_id>/hypotheses.jsonl --retrieval-only

# Run and evaluate in one pass
uv run locomo run+evaluate

# Use Haiku for the reader
uv run locomo run+evaluate --reader-provider anthropic

# Preserve SQLite databases for inspection
uv run locomo run+evaluate --keep-db
```

## Question Categories

| Category | ID | Description |
|---|---|---|
| Single-hop | 1 | Answer in one session; tests basic retrieval |
| Multi-hop | 2 | Answer spans multiple sessions; tests synthesis |
| Temporal | 3 | Requires reasoning about dates/ordering |
| Open-domain | 4 | May need world knowledge beyond conversation |
| Adversarial | 5 | Question is unanswerable; correct = abstention |

## Evaluation

The primary metric is **token-level F1** (after normalization with Porter stemming), matching the LoCoMo paper. Adversarial questions are scored on abstention detection (binary correct/incorrect).

Retrieval quality is evaluated separately using `dia_id` tags embedded in stored memories. Each question's `evidence` field lists the ground-truth dialog turn IDs needed to answer correctly.

## Output

Results are saved in `results/<run_id>/`:
- `config.json` -- frozen configuration
- `hypotheses.jsonl` -- `{question_id, hypothesis}` per line
- `checkpoint.jsonl` -- per-conversation records with all QA results and retrieved context
- `eval-results.jsonl` -- per-question scores (F1, category, correctness)
- `retrieval-summary.json` -- aggregate retrieval metrics (per-category breakdown)
- `summary.json` -- aggregate QA metrics (overall + per-category F1 and accuracy)
- `dbs/` -- preserved SQLite databases (only with `--keep-db`)

## Configuration

All settings are configurable via CLI flags. Run `uv run locomo run --help` for the full list.
