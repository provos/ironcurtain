# LoCoMo Benchmark Harness Design

## Overview

A benchmark harness that evaluates the memory MCP server against the LoCoMo dataset
(Long-Context Conversations for Memory-based Open-domain Dialogue). LoCoMo tests a
memory system's ability to store long multi-session conversations and answer questions
that require different reasoning skills: single-hop retrieval, multi-hop synthesis,
temporal reasoning, open-domain knowledge integration, and adversarial detection.

The harness follows the same patterns as the existing LongMemEval harness (frozen
dataclass config, CLI with argparse, checkpoint/resume, JSONL output) and reuses its
MCP client, reader LLM, and checkpoint infrastructure.

## LoCoMo Dataset Summary

**Source**: `snap-research/locomo` GitHub repo, `data/locomo10.json`

| Property | Value |
|---|---|
| Conversations | 10 (in locomo10.json) |
| Avg sessions per conversation | ~19 |
| Total QA questions | ~750 across 10 conversations (paper reports 7,512 across 50) |
| Question categories | 5 (single-hop, multi-hop, temporal, open-domain, adversarial) |
| Evaluation metric | Token-level F1 score (normalized) |
| Retrieval ground truth | `evidence` field: list of `dia_id` strings (e.g., "D1:3") |
| Dialog turn identifier | `dia_id` format: "D{session}:{turn}" |
| Adversarial handling | Expected answer is that the question is unanswerable |

**Question category distribution** (from paper, 50 conversations):

| Category | ID | Count | % |
|---|---|---|---|
| Single-hop | 1 | 2,705 | 36.0% |
| Multi-hop | 2 | 1,104 | 14.6% |
| Temporal | 3 | 1,547 | 20.6% |
| Open-domain | 4 | 285 | 3.9% |
| Adversarial | 5 | 1,871 | 24.9% |

**Data format** (locomo10.json is a JSON array of conversation objects):

```
[
  {
    "conversation": {
      "speaker_a": "Roy",
      "speaker_b": "Carol",
      "session_1_date_time": "October 16, 2023 Wednesday 07:41 PM",
      "session_1": [
        { "speaker": "Roy", "dia_id": "D1:0", "text": "Hey Carol!..." },
        { "speaker": "Carol", "dia_id": "D1:1", "text": "Hey Roy!..." },
        ...
      ],
      "session_2_date_time": "October 17, 2023 Thursday 08:15 AM",
      "session_2": [ ... ],
      ...
    },
    "qa": [
      {
        "question": "What breed are Carol's dogs?",
        "answer": "Golden Retrievers",
        "evidence": ["D1:1", "D1:2"],
        "category": 1,
        "adversarial_answer": null
      },
      {
        "question": "How many sessions did Roy mention hiking?",
        "answer": "3",
        "evidence": ["D1:0", "D4:2", "D7:1"],
        "category": 3
      },
      ...
    ]
  },
  ...
]
```

**Key differences from HuggingFace `Aman279/Locomo`**: The HuggingFace dataset has
35 raw dialogues (speaker_role/utterance arrays) **without QA annotations**. The
GitHub `locomo10.json` has 10 conversations **with** full QA annotations (question,
answer, evidence, category). We use the GitHub source.

## Key Design Decisions

1. **Data source is GitHub, not HuggingFace.** The HuggingFace `Aman279/Locomo`
   dataset lacks QA annotations. We download `locomo10.json` from the GitHub repo at
   first run and cache it locally. This removes the `datasets` library dependency for
   LoCoMo (it remains a LongMemEval dependency only).

2. **One DB per conversation, not per question.** LoCoMo conversations have ~19
   sessions each. All questions for a given conversation share the same ingested
   context. LongMemEval creates one DB per question because each question has its own
   haystack. LoCoMo should ingest once per conversation, then run all that
   conversation's QA against the same DB. This is both more realistic and faster
   (~10 ingestions instead of ~750).

3. **F1 scoring instead of LLM judge for primary metric.** The LoCoMo paper uses
   token-level F1 (after normalization) as the primary QA metric. This is
   deterministic and does not require a judge LLM. We implement the same
   `normalize_answer()` and `f1_score()` from the LoCoMo evaluation code. An
   optional LLM judge can be added later for qualitative analysis but is not in
   scope for v1.

4. **Category-aware evaluation with per-category and overall F1.** The five question
   categories have meaningfully different characteristics. Adversarial questions
   expect the system to say "I don't know" -- for these, we check whether the
   answer indicates unanswerable (similar to LongMemEval's abstention). Results are
   broken down by category.

5. **Retrieval evaluation via `dia_id` tagging.** Each ingested turn is tagged with
   its `dia_id` (e.g., `dia_id:D1:3`). Retrieved context is parsed for these tags
   to compute recall and precision against the `evidence` field. This parallels
   LongMemEval's session-date-based retrieval scoring but uses explicit IDs.

6. **Reuse MCP client, reader, and checkpoint infrastructure from LongMemEval.**
   The `mcp_client.py` module is generic enough to reuse directly. The reader and
   checkpoint/resume patterns are replicated. The judge is replaced by F1 scoring.

7. **Conversation-level checkpointing.** Since all questions for a conversation
   share one ingestion, checkpointing is per-conversation (not per-question).
   A checkpoint records `conversation_id` and all QA results for that conversation
   in a single JSONL entry. Resume skips already-completed conversations.

## File Layout

```
benchmark/
  locomo/
    __init__.py              # Package docstring
    config.py                # BenchmarkConfig dataclass + CLI arg parsing
    dataset.py               # Download/load locomo10.json, normalize to typed dataclasses
    ingest.py                # Ingest one conversation's sessions into memory MCP server
    mcp_client.py            # Thin re-export or symlink to shared MCP client
    reader.py                # Reader LLM (reuses longmemeval.reader pattern)
    scoring.py               # Token-level F1, normalize_answer, per-category metrics
    retrieval_metrics.py     # dia_id-based retrieval recall/precision
    run.py                   # Main orchestrator (run, evaluate, run+evaluate)
    DESIGN.md                # This file
```

### Shared vs LoCoMo-specific modules

| Module | Shared from longmemeval? | Notes |
|---|---|---|
| `config.py` | No -- new | Different CLI args (no --variant, adds --conversation-limit), different defaults |
| `dataset.py` | No -- new | Completely different data format (JSON from GitHub vs HF dataset) |
| `ingest.py` | No -- new | Different ingestion strategy (sessions with dia_id tags) |
| `mcp_client.py` | **Yes -- import from longmemeval** | `memory_server()`, `call_store()`, `call_recall()` are generic |
| `reader.py` | **Yes -- import from longmemeval** | Same reader LLM pattern; prompt may need slight adaptation |
| `scoring.py` | No -- new | F1 scoring replaces LLM judge; LoCoMo-specific normalization |
| `retrieval_metrics.py` | No -- new | dia_id-based instead of session-date-based |
| `run.py` | No -- new | Different orchestration (per-conversation, not per-question) |

**To enable imports across benchmark packages**, we refactor `mcp_client.py` and
`reader.py` into a shared `benchmark/common/` package in a future PR. For v1, we
copy the ~50 lines of MCP client code rather than creating cross-package imports
that complicate the Python path setup. The reader module is similarly small and
self-contained.

## Data Model Mapping

### Conversation -> Memory Ingestion

Each conversation's sessions map to `memory_store` calls:

```
For each session_N in conversation:
  For each turn in session_N:
    memory_store(
      content = "[Session: {N}, Date: {session_N_date_time}] [{speaker}]: {text}",
      tags = [
        "dia_id:{turn.dia_id}",        # e.g., "dia_id:D3:5"
        "session:{N}",                  # e.g., "session:3"
        "date:{session_N_date_time}",   # e.g., "date:October 16, 2023..."
        "speaker:{turn.speaker}",       # e.g., "speaker:Roy"
      ],
      importance = 0.5
    )
```

The `dia_id` tag is critical for retrieval evaluation. The session and date tags
mirror the LongMemEval pattern and give the retrieval pipeline temporal handles.

Image-related fields (`img_url`, `blip_caption`, `query`) are **ignored** -- our
memory server is text-only.

### QA -> Evaluation

```
For each qa in conversation.qa:
  1. Recall: call memory_recall(query=qa.question)
  2. Read: call reader LLM with retrieved context + question
  3. Score:
     - If category == 5 (adversarial):
         Check if response indicates "unanswerable" / "I don't know"
         Binary correct/incorrect
     - Else:
         Compute token-level F1 between normalized(hypothesis) and normalized(qa.answer)
  4. Retrieval metrics:
         Parse dia_id tags from retrieved context
         Compute recall/precision against qa.evidence
```

### dia_id -> Retrieval Ground Truth

The `evidence` field contains dia_ids like `["D1:1", "D1:2", "D4:7"]`. After
retrieval, we parse the retrieved context for `dia_id:D{X}:{Y}` patterns in the
embedded tags. Metrics:

- **Evidence recall**: |retrieved_dia_ids intersection evidence| / |evidence|
- **Evidence precision**: |retrieved_dia_ids intersection evidence| / |retrieved_dia_ids|
- **Perfect retrieval**: 1.0 if all evidence dia_ids are in retrieved context

### Question Categories -> Evaluation Behavior

| Category | ID | F1 Metric | Notes |
|---|---|---|---|
| Single-hop | 1 | Standard token F1 | Answer in one session; tests basic retrieval |
| Multi-hop | 2 | Standard token F1 | Answer spans multiple sessions; tests synthesis |
| Temporal | 3 | Standard token F1 | Requires reasoning about dates/ordering |
| Open-domain | 4 | Standard token F1 | May need world knowledge beyond conversation |
| Adversarial | 5 | Binary (abstention detection) | Correct = system says it cannot answer |

For adversarial questions, the `adversarial_answer` field contains the wrong answer
the system might be tricked into giving. We log it for analysis but score based on
whether the system correctly abstains.

## Config Dataclass

```python
@dataclass(frozen=True)
class BenchmarkConfig:
    # Dataset
    data_url: str = "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json"
    data_cache_path: str = "./data/locomo10.json"

    # Memory MCP server (same as LongMemEval)
    server_command: str = "node"
    server_args: list[str]          # ["dist/index.js"]
    server_cwd: str                 # resolved from file location
    memory_llm_base_url: str
    memory_llm_model: str
    memory_llm_api_key: str

    # Retrieval
    recall_token_budget: int = 2000
    recall_tool: str = "memory_recall"
    recall_format: str = "list"

    # Reader LLM
    reader_provider: str = "ollama"
    reader_base_url: str
    reader_model: str
    reader_api_key: str
    reader_max_tokens: int = 500

    # Output
    output_dir: str = "./results"
    run_id: str                     # auto-generated timestamp

    # Ingestion
    importance_default: float = 0.5

    # Execution
    conversation_limit: int | None = None   # only process first N conversations
    question_limit: int | None = None       # only evaluate first N questions per conversation
    resume: bool = False
    keep_db: bool = False
```

### CLI Arguments

```
python -m locomo.run {run,evaluate,run+evaluate} [options]

Modes:
  run            Ingest conversations + recall + generate answers
  evaluate       Score existing hypotheses (F1 + retrieval metrics)
  run+evaluate   Run then evaluate in one pass

Options:
  --conversation-limit N     Only process first N conversations
  --question-limit N         Only evaluate first N questions per conversation
  --resume                   Resume from checkpoint
  --keep-db                  Preserve SQLite databases for inspection
  --output-dir PATH          Output directory (default: ./results)
  --recall-tool {memory_recall,memory_context}
  --recall-format {summary,list,raw}
  --recall-budget N          Token budget for recall (default: 2000)
  --memory-llm-model MODEL
  --reader-model MODEL
  --reader-provider {ollama,anthropic}
```

## Scoring Module (scoring.py)

Ported from LoCoMo's `task_eval/evaluation.py`:

```python
def normalize_answer(text: str) -> str:
    """Lowercase, remove articles/punctuation/extra-whitespace, NFD normalize."""

def f1_score(prediction: str, ground_truth: str) -> float:
    """Token-level F1 between normalized prediction and ground truth.
    Uses Porter stemming. Returns 0.0-1.0."""

def is_abstention(response: str) -> bool:
    """Detect whether the response indicates inability to answer.
    Checks for phrases like 'I don't know', 'not available',
    'cannot answer', 'no information', 'unanswerable'."""

def score_question(
    hypothesis: str,
    answer: str,
    category: int,
    adversarial_answer: str | None = None,
) -> dict:
    """Score a single QA pair. Returns:
    {
        "f1": float,           # 0.0 for adversarial
        "correct": bool,       # F1 >= 0.5 for non-adversarial; abstention for adversarial
        "category": int,
        "is_adversarial": bool,
        "abstained": bool,     # only for adversarial
    }
    """

def compute_metrics(results: list[dict]) -> dict:
    """Aggregate per-question scores into:
    - overall_f1: mean F1 across all non-adversarial questions
    - overall_accuracy: fraction correct (F1>=0.5 or correct abstention)
    - per_category: {category_id: {mean_f1, accuracy, count}}
    - adversarial_accuracy: fraction of adversarial questions correctly abstained
    """
```

## Retrieval Metrics Module (retrieval_metrics.py)

```python
_DIA_ID_RE = re.compile(r"dia_id:(D\d+:\d+)")

def extract_retrieved_dia_ids(context: str) -> set[str]:
    """Parse dia_id tags from retrieved context."""

def score_retrieval(
    retrieved_context: str,
    evidence: list[str],
) -> dict:
    """Score retrieval for a single question.
    Returns {
        evidence_recall, evidence_precision, perfect_retrieval,
        retrieved_count, evidence_count, found_count,
    }
    """

def compute_retrieval_summary(results: list[dict]) -> dict:
    """Aggregate: mean_evidence_recall, mean_evidence_precision,
    perfect_retrieval_rate, per_category breakdown."""
```

## Orchestration (run.py)

### Run Mode Flow

```
1. Download/cache locomo10.json
2. Load and parse conversations
3. For each conversation (with checkpoint/resume):
   a. Start fresh memory MCP server with per-conversation DB
   b. Ingest all sessions (all turns with dia_id tags)
   c. For each QA in conversation:
      i.   Call memory_recall with question
      ii.  Call reader LLM with context + question
      iii. Record hypothesis + retrieved context
   d. Checkpoint: write conversation_id + all QA results to JSONL
   e. Shut down server, clean up DB (unless --keep-db)
4. Write hypotheses.jsonl (all question_id + hypothesis pairs)
```

### Evaluate Mode Flow

```
1. Load checkpoint.jsonl
2. For each QA result:
   a. Compute F1 score (or adversarial abstention check)
   b. Compute retrieval metrics from saved context
3. Write eval-results.jsonl, retrieval-summary.json, summary.json
4. Print per-category and overall metrics
```

### Checkpoint Format

Each JSONL line represents one completed conversation:

```json
{
  "conversation_id": 0,
  "speaker_a": "Roy",
  "speaker_b": "Carol",
  "sessions_ingested": 9,
  "turns_stored": 187,
  "elapsed_seconds": 42.3,
  "questions": [
    {
      "question": "What breed are Carol's dogs?",
      "answer": "Golden Retrievers",
      "category": 1,
      "evidence": ["D1:1", "D1:2"],
      "hypothesis": "Carol has Golden Retrievers.",
      "retrieved_context": "[dia_id:D1:1] [Session: 1, Date: ...] ...",
      "elapsed_seconds": 2.1
    },
    ...
  ]
}
```

### Output Files

```
results/{run_id}/
  config.json              # Frozen config for reproducibility
  checkpoint.jsonl         # Per-conversation checkpoint (ingestion + QA results)
  hypotheses.jsonl         # Flat list of {question_id, hypothesis} for all questions
  eval-results.jsonl       # Per-question scores (F1, retrieval metrics)
  retrieval-summary.json   # Aggregate retrieval metrics
  summary.json             # Aggregate QA metrics (overall + per-category)
  dbs/                     # Preserved SQLite DBs (if --keep-db)
    conversation_0.db
    ...
```

## Question ID Scheme

LoCoMo does not have explicit question IDs. We synthesize them:

```
question_id = f"conv{conversation_id}_cat{category}_q{question_index}"
```

Example: `conv0_cat1_q3` = conversation 0, category 1 (single-hop), 4th question
of that category in that conversation.

This gives stable, human-readable IDs for checkpoint matching and result analysis.

## Tradeoffs and Alternatives Considered

### 1. Per-question DB vs per-conversation DB

**Chosen: per-conversation.** Per-question (like LongMemEval) would mean ingesting
the same conversation ~75 times (once per question). This is wasteful and takes
orders of magnitude longer. The tradeoff is that questions are no longer independent
-- if ingestion fails, all questions for that conversation fail. This is acceptable
because conversations are the natural unit of work.

### 2. F1 scoring vs LLM judge

**Chosen: F1 for v1.** The LoCoMo paper uses F1 as the primary metric. LLM judges
add variance, cost, and a dependency on judge model quality. F1 is deterministic
and allows direct comparison with published results. An LLM judge can be added
as an optional mode later (the infrastructure exists in longmemeval.evaluate).

### 3. Download from GitHub vs bundle data

**Chosen: download + cache.** The locomo10.json file is ~2MB. Bundling it would
bloat the repo and create license concerns (CC-BY-NC-4.0). Downloading at first
run with a local cache is clean and standard for benchmark harnesses.

### 4. Shared common/ package vs copy

**Chosen: copy for v1.** Creating a shared `benchmark/common/` package requires
restructuring pyproject.toml, changing the package layout, and updating imports.
The shared code is small (~90 lines for mcp_client.py, ~100 lines for reader.py).
Copying keeps the two harnesses independent and avoids Python path complexity.
A future PR can extract the common code once patterns stabilize.

### 5. HuggingFace dataset vs GitHub JSON

**Chosen: GitHub JSON.** The `Aman279/Locomo` HuggingFace dataset has 35 dialogues
but **no QA annotations** -- it is just raw conversation data. The GitHub
`locomo10.json` has 10 conversations with complete QA annotations (question, answer,
evidence, category). This is the same file used by the LoCoMo paper's evaluation
code.

## pyproject.toml Changes

The existing `pyproject.toml` needs to be updated to add the LoCoMo harness as a
second entry point. Two options:

**Option A: Separate pyproject.toml** (recommended for v1)
Add `benchmark/locomo/pyproject.toml` with its own dependencies. The LoCoMo harness
does NOT need the `datasets` library (it loads JSON directly). Dependencies:

```toml
[project]
name = "locomo-benchmark"
version = "0.1.0"
dependencies = [
    "mcp>=1.9.0",
    "openai>=1.50.0",
    "tqdm>=4.66.0",
    "python-dotenv>=1.0.0",
    "nltk>=3.9.0",         # for Porter stemmer (F1 scoring)
    "httpx>=0.27.0",       # for downloading dataset
]

[project.scripts]
locomo = "locomo.run:main"
```

**Option B: Shared pyproject.toml with extras**
Use `pip install .[locomo]` with optional dependencies. More complex, less
independent. Not recommended for v1.

## Testing Strategy

1. **Unit tests for scoring.py**: Test normalize_answer, f1_score, is_abstention,
   score_question with known inputs/outputs from the LoCoMo paper.

2. **Unit tests for retrieval_metrics.py**: Test dia_id extraction and
   recall/precision computation.

3. **Unit tests for dataset.py**: Test JSON parsing, session enumeration, question
   ID generation.

4. **Integration test**: Run with `--conversation-limit 1 --question-limit 5` against
   a real memory MCP server to verify the full pipeline.

## Future Extensions

- **LLM judge mode**: Optional `--judge-model` flag that uses an LLM to evaluate
  answer quality (for cases where F1 is insufficient, e.g., paraphrased answers).
- **Shared common/ package**: Extract MCP client and reader into
  `benchmark/common/` once both harnesses are stable.
- **Full dataset support**: If a complete 50-conversation dataset with QA becomes
  available on HuggingFace, add a `--variant` flag similar to LongMemEval.
- **Multi-hop analysis**: Deeper analysis of multi-hop questions, tracking how many
  evidence dia_ids span different sessions.
- **Memory distance analysis**: Port LoCoMo's memory-distance stratification
  (accuracy vs. how far back in the conversation the evidence is).
