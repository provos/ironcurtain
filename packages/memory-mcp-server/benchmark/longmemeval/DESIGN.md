# LongMemEval Benchmark Harness Design

## Overview

A Python harness that evaluates the memory MCP server against the LongMemEval benchmark (500 questions across 6 question types). For each question, the harness resets the memory database, ingests all haystack sessions via MCP `memory_store` calls, retrieves relevant context via `memory_recall`, feeds that context to a reader LLM for answer generation, and records the hypothesis. A separate evaluation pass uses a judge LLM to score correctness, producing per-type and overall accuracy metrics compatible with LongMemEval's evaluation format.

## Key Design Decisions

1. **Store one memory per conversation turn, not per session.** The memory server works best with atomic facts (its dedup, embedding, and compaction all operate at the individual memory level). Concatenating an entire multi-turn session into one blob would exceed `MAX_CONTENT_LENGTH` (10,000 chars) for longer sessions and defeat semantic search. Each turn is stored as a separate memory with session metadata embedded in content and tags for filtering.

2. **Embed session date and ID in both content prefix and tags.** The memory server has no first-class timestamp field exposed through the MCP API -- timestamps are internal (created_at). To enable temporal reasoning questions, each stored memory gets a content prefix like `[Session on 2023/05/21]` and tags like `session:answer_sess123`, `date:2023/05/21`. This gives the retrieval pipeline both semantic and tag-based handles on temporal information.

3. **Reader LLM called directly via OpenAI-compatible HTTP API, not through MCP.** The memory server has no "generate answer" tool. The reader LLM (Gemma3:27b via Ollama) is called directly using the OpenAI Python client pointed at Ollama's `/v1` endpoint. This mirrors how LongMemEval's own `run_generation.py` works.

4. **Per-question DB isolation via unique file paths, not server restarts for parallelism.** Each question gets a unique `MEMORY_DB_PATH` (e.g., `/tmp/longmemeval-{pid}-{qid}.db`). For sequential execution, we start/stop one server per question. For future parallelism, multiple servers can run simultaneously with different DB paths. The harness deletes the DB file after each question.

5. **Checkpoint/resume via a progress JSONL file.** Each completed question is appended to a progress file. On restart, already-completed question IDs are skipped. This handles the 500-question runtime gracefully.

6. **Reuse LongMemEval's evaluation prompt verbatim.** The judge uses the exact `get_anscheck_prompt()` logic from LongMemEval's `evaluate_qa.py`, including the per-question-type prompt variants (temporal reasoning gets off-by-one tolerance, knowledge-update gets supersession logic, etc.). This ensures our results are directly comparable to published numbers.

7. **Map LongMemEval question types to their canonical names.** The HuggingFace cleaned dataset uses these `question_type` values: `single-session-user`, `single-session-assistant`, `single-session-preference`, `multi-session`, `temporal-reasoning`, `knowledge-update`. Abstention questions are identified by `_abs` suffix in `question_id`.

## File Structure

```
packages/memory-mcp-server/benchmark/longmemeval/
  config.py          -- All tunable constants (models, URLs, paths, budgets)
  dataset.py         -- Load HuggingFace dataset, normalize fields, select variant
  ingest.py          -- Convert haystack sessions to memory_store calls
  mcp_client.py      -- Start/stop MCP server, call tools (thin wrapper)
  reader.py          -- Call reader LLM with retrieved context + question
  evaluate.py        -- Judge LLM scoring (port of LongMemEval evaluate_qa.py)
  run.py             -- Main orchestrator: per-question loop with checkpoint/resume
  requirements.txt   -- Python dependencies
  README.md          -- Usage instructions
```

## Data Flow

```
                    HuggingFace Dataset
                          |
                    dataset.py: load + normalize
                          |
                          v
              +---------------------------+
              | For each question (run.py)|
              +---------------------------+
                          |
            1. Delete old DB, start MCP server
                          |
            2. ingest.py: for each session in haystack_sessions
               for each turn in session:
                 memory_store(content, tags, importance)
                          |
            3. mcp_client.py: memory_recall(question, token_budget)
               or memory_context(question, token_budget)
                          |
            4. reader.py: reader_llm(retrieved_context, question, question_date)
               -> hypothesis text
                          |
            5. Append {question_id, hypothesis} to output JSONL
               Append full record to checkpoint JSONL
                          |
            6. Stop MCP server, delete DB
              +---------------------------+
                          |
                          v
              evaluate.py: for each {question_id, hypothesis}
                judge_llm(question_type, question, answer, hypothesis)
                -> {question_id, hypothesis, autoeval_label}
                          |
                          v
              Print per-type accuracy + overall accuracy
```

## Module Specifications

### config.py

```python
# Immutable configuration dataclass
@dataclass(frozen=True)
class BenchmarkConfig:
    # Dataset
    dataset_name: str = "xiaowu0162/longmemeval-cleaned"
    dataset_variant: str = "longmemeval_s_cleaned"  # or _m_cleaned, _oracle

    # Memory MCP server
    server_command: str = "node"
    server_args: list[str]  # ["dist/index.js"]
    server_cwd: str  # absolute path to packages/memory-mcp-server
    memory_llm_base_url: str = "http://localhost:11434/v1"
    memory_llm_model: str = "hadad/LFM2.5-1.2B:Q8_0"
    memory_llm_api_key: str = "ollama"

    # Retrieval
    recall_token_budget: int = 2000
    recall_tool: str = "memory_recall"  # or "memory_context"
    recall_format: str = "list"  # "summary" | "list" | "raw"

    # Reader LLM
    reader_base_url: str = "http://localhost:11434/v1"
    reader_model: str = "gemma3:27b"
    reader_api_key: str = "ollama"
    reader_max_tokens: int = 500

    # Judge LLM
    judge_base_url: str | None = None  # None = use Anthropic
    judge_model: str = "gemma3:27b"  # or "claude-haiku-4-5-20251001"
    judge_api_key: str = "ollama"  # or ANTHROPIC_API_KEY

    # Output
    output_dir: str = "./results"
    run_id: str  # auto-generated timestamp

    # Ingestion
    store_assistant_turns: bool = True  # False = user turns only
    importance_default: float = 0.5
```

Variant mapping:
- `S` -> `longmemeval_s_cleaned` (~40 sessions/question, ~500 questions)
- `M` -> `longmemeval_m_cleaned` (~500 sessions/question, ~500 questions)
- `Oracle` -> `longmemeval_oracle` (evidence sessions only)

### dataset.py

Responsibilities:
- Load dataset from HuggingFace via `datasets.load_dataset()`
- Normalize the `answer` field to `str` (the dataset has mixed int/str types)
- Return a list of `Question` dataclass instances

```python
@dataclass
class Question:
    question_id: str
    question_type: str  # one of the 6 canonical types
    question: str
    answer: str
    question_date: str
    haystack_sessions: list[list[dict]]   # list of sessions, each a list of {role, content}
    haystack_dates: list[str]             # one date per session
    haystack_session_ids: list[str]
    answer_session_ids: list[str]
```

Key detail: the `answer` field in the HuggingFace dataset sometimes contains integers (e.g., for temporal reasoning questions where the answer is a number of days). The loader must coerce to `str(answer)`.

### ingest.py

Responsibilities:
- Convert a `Question`'s haystack into a sequence of `memory_store` calls
- Handle the content-length limit (10,000 chars) by truncating if necessary

**Storage strategy** (one memory per conversational turn):

```python
async def ingest_question(client: ClientSession, question: Question, config: BenchmarkConfig):
    for session_idx, (session, date, session_id) in enumerate(
        zip(question.haystack_sessions, question.haystack_dates, question.haystack_session_ids)
    ):
        for turn_idx, turn in enumerate(session):
            if not config.store_assistant_turns and turn["role"] == "assistant":
                continue

            content = f"[Session date: {date}] [{turn['role']}]: {turn['content']}"
            # Truncate to MAX_CONTENT_LENGTH if needed
            if len(content) > 10000:
                content = content[:9950] + "... [truncated]"

            tags = [
                f"session:{session_id}",
                f"date:{date.split(' ')[0]}",  # date without time
                f"role:{turn['role']}",
            ]

            await client.call_tool("memory_store", {
                "content": content,
                "tags": tags,
                "importance": config.importance_default,
            })
```

**Why per-turn, not per-session:**
- Sessions can have 10+ turns. At ~500-1000 chars/turn, a session could be 5000-10000+ chars.
- Per-turn storage means each embedding captures one semantic unit.
- The memory server's dedup and compaction can merge related turns naturally.
- Semantic search works better on focused content than long concatenations.

**Why include assistant turns:**
- Many answer-bearing facts appear in assistant responses (e.g., "Based on what you told me, your flight is on Tuesday").
- LongMemEval's `single-session-assistant` type specifically tests recall from assistant turns.
- Configurable via `store_assistant_turns` for ablation.

### mcp_client.py

Responsibilities:
- Start/stop the MCP server subprocess
- Connect via stdio using the Python MCP SDK
- Provide typed wrappers for `memory_store`, `memory_recall`, `memory_context`

```python
@asynccontextmanager
async def memory_server(config: BenchmarkConfig, db_path: str):
    """Context manager: starts server, yields ClientSession, cleans up."""
    env = {
        **os.environ,
        "MEMORY_DB_PATH": db_path,
        "MEMORY_NAMESPACE": "longmemeval",
        "MEMORY_LLM_BASE_URL": config.memory_llm_base_url,
        "MEMORY_LLM_MODEL": config.memory_llm_model,
        "MEMORY_LLM_API_KEY": config.memory_llm_api_key,
    }
    server_params = StdioServerParameters(
        command=config.server_command,
        args=config.server_args,
        cwd=config.server_cwd,
        env=env,
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            try:
                yield session
            finally:
                pass  # cleanup handled by context managers

async def call_recall(session: ClientSession, query: str, config: BenchmarkConfig) -> str:
    """Call memory_recall and return the text content."""
    result = await session.call_tool(config.recall_tool, {
        "query": query,
        "token_budget": config.recall_token_budget,
        "format": config.recall_format,
    })
    return extract_text(result)

async def call_store(session: ClientSession, content: str, tags: list[str], importance: float) -> str:
    result = await session.call_tool("memory_store", {
        "content": content,
        "tags": tags,
        "importance": importance,
    })
    return extract_text(result)

def extract_text(result) -> str:
    """Extract concatenated text from MCP tool result content blocks."""
    return "\n".join(
        block.text for block in result.content
        if block.type == "text" and block.text
    )
```

### reader.py

Responsibilities:
- Construct the reader prompt from retrieved context + question
- Call the reader LLM via OpenAI-compatible API
- Return the hypothesis text

The prompt template mirrors LongMemEval's `run_generation.py` format:

```python
READER_PROMPT = (
    "I will give you relevant information retrieved from previous chat sessions "
    "with a user. Please answer the question based on this information.\n\n"
    "Retrieved Information:\n{context}\n\n"
    "Current Date: {question_date}\n"
    "Question: {question}\n"
    "Answer:"
)

async def generate_answer(
    context: str,
    question: str,
    question_date: str,
    config: BenchmarkConfig,
) -> str:
    client = AsyncOpenAI(
        base_url=config.reader_base_url,
        api_key=config.reader_api_key,
    )
    prompt = READER_PROMPT.format(
        context=context,
        question_date=question_date,
        question=question,
    )
    response = await client.chat.completions.create(
        model=config.reader_model,
        messages=[{"role": "user", "content": prompt}],
        temperature=0,
        max_tokens=config.reader_max_tokens,
    )
    return response.choices[0].message.content.strip()
```

### evaluate.py

Responsibilities:
- Implement LongMemEval's judge prompts exactly (ported from `evaluate_qa.py`)
- Support both Ollama and Anthropic API as judge backends
- Read hypothesis JSONL + reference data, produce scored output

The 5 prompt variants are ported verbatim from `get_anscheck_prompt()`:
- `single-session-user`, `single-session-assistant`, `multi-session`: standard correctness check
- `temporal-reasoning`: allows off-by-one errors
- `knowledge-update`: accepts updated answers even with old context
- `single-session-preference`: rubric-based check against personalized response
- Abstention (detected via `_abs` in `question_id`): checks if model correctly identifies unanswerable

```python
async def evaluate_all(
    hypotheses_path: str,
    references: list[Question],
    config: BenchmarkConfig,
) -> dict:
    """
    Returns:
        {
            "overall_accuracy": float,
            "task_averaged_accuracy": float,
            "per_type": {question_type: {"accuracy": float, "count": int}},
            "abstention_accuracy": float,
            "results": [{"question_id", "hypothesis", "autoeval_label": {"model", "label"}}]
        }
    """
```

Output format: JSONL where each line is `{"question_id": ..., "hypothesis": ..., "autoeval_label": {"model": ..., "label": true/false}}` -- directly compatible with LongMemEval's `print_qa_metrics.py`.

### run.py

Main orchestrator. Responsibilities:
- Parse CLI arguments (variant, config overrides)
- Load dataset
- Per-question loop with checkpoint/resume
- Progress reporting (stderr)
- Two modes: `run` (ingest + recall + generate) and `evaluate` (judge only)

```
Usage:
  python run.py run [--variant S|M|Oracle] [--resume] [--limit N]
  python run.py evaluate --hypotheses results/run-xxx/hypotheses.jsonl
  python run.py run+evaluate [--variant S|M|Oracle]
```

**Checkpoint/resume mechanism:**

```python
CHECKPOINT_FILE = "{output_dir}/{run_id}/checkpoint.jsonl"
HYPOTHESES_FILE = "{output_dir}/{run_id}/hypotheses.jsonl"

def load_completed_ids(checkpoint_path: str) -> set[str]:
    """Load question_ids that have been fully processed."""
    completed = set()
    if os.path.exists(checkpoint_path):
        with open(checkpoint_path) as f:
            for line in f:
                entry = json.loads(line)
                completed.add(entry["question_id"])
    return completed

async def run_question(question: Question, config: BenchmarkConfig) -> dict:
    db_path = f"/tmp/longmemeval-{os.getpid()}-{question.question_id}.db"
    try:
        async with memory_server(config, db_path) as session:
            # 1. Ingest
            await ingest_question(session, question, config)
            # 2. Recall
            context = await call_recall(session, question.question, config)
            # 3. Generate
            hypothesis = await generate_answer(
                context, question.question, question.question_date, config
            )
            return {
                "question_id": question.question_id,
                "hypothesis": hypothesis,
                "retrieved_context": context,  # for debugging
                "question_type": question.question_type,
            }
    finally:
        cleanup_db(db_path)

async def main_loop(questions: list[Question], config: BenchmarkConfig):
    completed = load_completed_ids(checkpoint_path)
    remaining = [q for q in questions if q.question_id not in completed]

    print(f"Resuming: {len(completed)} done, {len(remaining)} remaining", file=sys.stderr)

    for i, question in enumerate(remaining):
        print(f"[{i+1}/{len(remaining)}] {question.question_id} ({question.question_type})",
              file=sys.stderr, flush=True)

        result = await run_question(question, config)

        # Append to both files atomically
        with open(hypotheses_path, "a") as f:
            json.dump({"question_id": result["question_id"],
                        "hypothesis": result["hypothesis"]}, f)
            f.write("\n")
        with open(checkpoint_path, "a") as f:
            json.dump(result, f)
            f.write("\n")
```

### requirements.txt

```
mcp>=1.9.0
datasets>=3.0.0
openai>=1.50.0
tqdm>=4.66.0
```

## Design Answers

### 1. How to store sessions

**One memory per conversation turn.** Each turn (user or assistant message) becomes a separate `memory_store` call with the session date and ID embedded in both the content prefix and tags. Rationale:

- The memory server's `MAX_CONTENT_LENGTH` is 10,000 chars. Multi-turn sessions can exceed this.
- Embeddings are more precise on focused content. A single turn typically conveys one topic; a whole session mixes many.
- The server's dedup engine can identify near-duplicate turns across sessions.
- Tags (`session:X`, `date:Y`) preserve the session structure for filtering without polluting semantic content.

For the Oracle variant (~2-5 sessions per question), this means ~10-30 store calls. For S (~40 sessions), ~200-400 calls. For M (~500 sessions), ~2500-5000 calls. The MCP stdio transport handles this sequentially; at ~50ms/store (embedding + insert), S takes ~10-20s/question and M takes ~2-4 min/question.

### 2. What metadata to include

Each stored memory gets:
- **Content prefix**: `[Session date: 2023/05/21 (Sun) 14:30] [user]:` -- this becomes part of the embedding, so temporal and role info is semantically searchable.
- **Tags**: `session:{session_id}`, `date:{YYYY/MM/DD}`, `role:{user|assistant}` -- enables tag-filtered recall and post-hoc analysis of which sessions were retrieved.
- **Importance**: Default 0.5 for all turns. Could be tuned (e.g., higher for user turns) as an ablation.

### 3. How to handle the reader LLM

Direct OpenAI-compatible HTTP call via the `openai` Python package pointed at Ollama (`http://localhost:11434/v1`). The reader LLM is purely a question-answering step that takes context + question and produces an answer. It has no interaction with the memory server. This matches LongMemEval's own methodology.

### 4. Parallelism

**Sequential for v1.** Each question gets its own DB path, so parallelism is architecturally possible (just spawn N server processes with different `MEMORY_DB_PATH` values). However:
- The embedding model is CPU-bound and shared; parallel ingestion would contend.
- Ollama serves one request at a time by default.
- 500 questions at ~30s each (Oracle/S) = ~4 hours, acceptable for a benchmark.

Parallelism can be added later by partitioning questions and running multiple Python processes with disjoint DB paths.

### 5. Progress tracking

JSONL append-log pattern:
- `checkpoint.jsonl`: full result records (question_id, hypothesis, retrieved_context, timing)
- `hypotheses.jsonl`: minimal records for evaluation (question_id, hypothesis)

On resume, `checkpoint.jsonl` is scanned for completed question_ids. Incomplete questions (server crashed mid-ingestion) are simply re-run from scratch since the DB is per-question and cleaned up.

### 6. File structure

See "File Structure" section above. Six focused modules plus config and requirements. No classes beyond dataclasses -- the harness is a straightforward pipeline, not a framework.

## Output Files

A completed run produces:

```
results/{run_id}/
  config.json                  -- frozen config for reproducibility
  hypotheses.jsonl             -- {question_id, hypothesis} per line (LongMemEval compatible)
  checkpoint.jsonl             -- full records with context, timing, metadata
  eval-results.jsonl           -- {question_id, hypothesis, autoeval_label} per line
  summary.json                 -- aggregate metrics (per-type accuracy, overall, task-averaged)
```

## Timing Estimates

| Variant | Sessions/Q | Turns/Q (est.) | Ingest time/Q | Recall time/Q | Reader time/Q | Total/Q | Total 500Q |
|---------|-----------|----------------|---------------|---------------|---------------|---------|------------|
| Oracle  | 2-5       | 10-30          | 1-3s          | 1-2s          | 3-5s          | ~10s    | ~1.5h      |
| S       | ~40       | 200-400        | 10-20s        | 1-2s          | 3-5s          | ~25s    | ~3.5h      |
| M       | ~500      | 2500-5000      | 2-4min        | 1-2s          | 3-5s          | ~3min   | ~25h       |

Evaluation (judge pass) is an additional ~1s/question = ~10 minutes total.

## Extension Points

1. **Alternative ingestion strategies**: `ingest.py` can be swapped to test per-session storage (concatenate turns) or fact-extraction (LLM-preprocess each turn into atomic facts before storing). The `ingest_question` function is the only place to change.

2. **Recall tool selection**: Config toggle between `memory_recall` and `memory_context` to benchmark both retrieval tools.

3. **Tag-filtered recall**: For temporal reasoning questions, the harness could pass `tags=["date:2023/05/21"]` to test tag-based filtering. This is a config-level change.

4. **Retrieval-only evaluation**: LongMemEval also has retrieval metrics (which sessions were retrieved). The checkpoint records `retrieved_context`; a separate analysis script could compare retrieved session IDs against `answer_session_ids`.

5. **Reader LLM ablation**: Swap the reader model or use chain-of-thought prompting (add "Answer step by step:" suffix) via config. The reader prompt template is a single string in `reader.py`.

## Differences from LongMemEval's Native Pipeline

| Aspect | LongMemEval | This Harness |
|--------|-------------|-------------|
| Storage | Full session history in LLM context | Per-turn semantic memory with embeddings |
| Retrieval | BM25/dense retriever over sessions | Memory server's hybrid vector+FTS pipeline |
| Context format | Raw session JSON/NL | Memory server's summarized/formatted output |
| Index expansion | Optional session summaries, keyphrases, user facts | Memory server's compaction + dedup |
| Reader input | Retrieved sessions verbatim | Formatted recall output (summary/list/raw) |
| Evaluation | Identical prompts | Identical prompts (ported verbatim) |

This comparison is the point: we are measuring whether the memory server's semantic storage and retrieval can match or exceed traditional RAG pipelines on the same benchmark questions.
