# LongMemEval Benchmark

Evaluates the memory MCP server against the [LongMemEval](https://github.com/xiaowu0162/LongMemEval) benchmark (500 questions, 6 question types).

## Prerequisites

- Memory MCP server built: `cd ../.. && npm run build`
- Ollama running with models pulled:
  - `ollama pull hadad/LFM2.5-1.2B:Q8_0` (memory server LLM)
  - `ollama pull gemma3:27b` (reader + judge LLM)
- Python 3.11+ with [uv](https://docs.astral.sh/uv/) installed

## Setup

```bash
cd packages/memory-mcp-server/benchmark
uv sync
```

## Usage

```bash
cd packages/memory-mcp-server/benchmark

# Run benchmark (S variant, default settings)
uv run longmemeval run --variant S

# Run with a limit (for testing)
uv run longmemeval run --variant S --limit 10

# Resume an interrupted run
uv run longmemeval run --variant S --resume

# Evaluate existing hypotheses
uv run longmemeval evaluate --hypotheses results/run-xxx/hypotheses.jsonl --variant S

# Run and evaluate in one pass
uv run longmemeval run+evaluate --variant S

# Use Haiku as judge instead of Gemma
uv run longmemeval run+evaluate --variant S --judge-provider anthropic --judge-model claude-haiku-4-5-20251001
```

## Output

Results are saved in `results/{run_id}/`:
- `config.json` -- frozen configuration
- `hypotheses.jsonl` -- `{question_id, hypothesis}` per line
- `checkpoint.jsonl` -- full records with retrieved context and timing
- `eval-results.jsonl` -- `{question_id, hypothesis, autoeval_label}` per line
- `summary.json` -- per-type and overall accuracy

## Configuration

All settings are configurable via CLI flags. Run `uv run longmemeval run --help` for the full list.

Results are written to `benchmark/results/` by default.
