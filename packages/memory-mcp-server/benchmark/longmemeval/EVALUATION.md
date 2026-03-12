# Evaluating Retrieval Quality

The benchmark produces an overall accuracy score, but that score conflates retrieval quality (did the memory server find the right information?) with reader quality (did the LLM interpret the context correctly?). To assess the memory server specifically, analyze the retrieval pipeline separately.

## Quick Check

Run this from the `benchmark/` directory against a completed run:

```bash
uv run python3 -c "
import json
from datasets import load_dataset

ds = load_dataset('xiaowu0162/longmemeval-cleaned', data_files='longmemeval_s_cleaned.json', split='train')
ref = {row['question_id']: row for row in ds}

with open('results/<RUN_ID>/checkpoint.jsonl') as f:
    for line in f:
        r = json.loads(line)
        q = ref[r['question_id']]
        answer_sids = set(q['answer_session_ids'])
        ctx = r['retrieved_context']

        # Match answer sessions by date (dates are unique per session)
        answer_dates = [d for sid, d in zip(q['haystack_session_ids'], q['haystack_dates']) if sid in answer_sids]
        dates_found = [d for d in answer_dates if d in ctx]
        answer_in_ctx = q['answer'].lower() in ctx.lower()

        status = '✓' if answer_in_ctx else ('~' if dates_found else '✗')
        print(f\"{status}  {r['question_id']}  answer=\\\"{q['answer']}\\\"  session_retrieved={len(dates_found)}/{len(answer_dates)}  answer_in_ctx={answer_in_ctx}\")
"
```

Replace `<RUN_ID>` with the timestamp directory name.

## What the Symbols Mean

- **✓** — Answer text found in retrieved context. Retrieval succeeded.
- **~** — The correct session was retrieved but the answer text is missing. Usually caused by token budget truncation: the relevant turn exists in the session but was cut off. Try increasing `--recall-budget`.
- **✗** — The correct session was not retrieved. This indicates a genuine retrieval failure in the embedding/scoring pipeline.

## Diagnosing Failures

### Token budget truncation (~)

The memory server returns context up to the configured token budget (default: 2000). When a session has many turns, the answer turn may fall outside this window.

**Fix:** Re-run with a higher budget: `--recall-budget 4000`

### Retrieval miss (✗)

The embedding model failed to rank the answer session highly enough. Possible causes:

- The question phrasing has low semantic similarity to the stored memory content
- Too many similar-looking memories pushed the answer session out of the top results
- The stored memory was truncated during ingestion (content over 10,000 characters is clipped)

**Inspect:** Use `--keep-db` to preserve the SQLite database, then query it directly:

```bash
sqlite3 results/<RUN_ID>/dbs/<QUESTION_ID>.db "SELECT id, substr(content, 1, 120) FROM memories ORDER BY created_at LIMIT 20"
```

### Reader failure (✓ but eval says incorrect)

The correct information was retrieved but the reader LLM produced a wrong answer. Common patterns:

- **Cross-turn inference** — the answer spans user and assistant turns (e.g., the user mentions attending a play, the assistant discusses "The Glass Menagerie" in response). The reader fails to connect the two.
- **Implicit information** — the answer is implied but never stated explicitly by the user (e.g., the user redeemed a coupon, and the assistant asks about shopping at Target, but the user never said "at Target").

These are reader/LLM limitations, not memory server failures. A stronger reader model or a prompt that encourages cross-turn reasoning may help.

## Metrics to Track

| Metric | What it measures | Target |
|--------|-----------------|--------|
| Session retrieval rate | % of questions where the answer session appears in context | >90% |
| Answer text recall | % of questions where the ground-truth answer text appears in context | >80% |
| Overall accuracy | End-to-end correctness (retrieval + reader + judge) | Depends on reader model |
| Gap between answer recall and accuracy | Reader failure rate | Lower is better |

A high session retrieval rate with low overall accuracy points to reader weakness. A low session retrieval rate points to retrieval/embedding issues.
