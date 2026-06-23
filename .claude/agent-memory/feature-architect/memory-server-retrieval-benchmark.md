# Memory MCP Server — retrieval + benchmark map (for evolve-fusion dogfood)

Package: `packages/memory-mcp-server/`. Design doc: `docs/designs/evolve-memory-fusion-dogfood.md`.

## STATUS UPDATE (2026-06-21): dogfood harness is BUILT + the LoCoMo metadata-flatness failure
- Dump tap SHIPPED in production `pipeline.ts:98-101` (env-gated `MEMORY_FIXTURE_DUMP_DIR`, lazy-loads `benchmark/fixture/dump.mjs` by abs path via `MEMORY_FIXTURE_DUMP_MODULE` — never a static src/ edge). Fixture builder `benchmark/fixture/build-locomo-fixture.ts` (uses production `MemoryEngine` directly, no Python, no MCP subprocess). Evaluator+lib `benchmark/fusion-evolve/{evaluator,scoring-lib,tune-constants}.mjs` + perturbed candidates. 39MB `locomo-pool.jsonl` exists (gitignored).
- **THE FAILURE**: evolve winner dropped recency/importance/access composite terms (`scoring.ts:145` `0.15/0.1/0.1` weights) — won ONLY because those signals are DEAD in LoCoMo. EMPIRICALLY VERIFIED on shipped fixture: `importance` ≡ single value `{0.5}` (ingest hardcodes `importance:0.5` at `ingest.py:40`/`build-locomo-fixture.ts:114`); `created_at` one ingest batch w/ frozen `now` (`:224`) → recency flat vs 30-day half-life; `access_count` {0..9} from dump-time re-retrieval noise only. LIVE in prod: importance settable `server.ts:43-48`, access updates `queries.ts:120-134`+`pipeline.ts:172`, decay reads all 3 `maintenance.ts:74-91`.
- **`scoring-lib.mjs:11`**: TOKEN_BUDGET tightened 2000→300 ON PURPOSE — at 2000 recall saturates (0.81 of 0.91 ceiling), ranking irrelevant; 300 (~15 cands) makes ranking the lever (baseline ~0.62). TOP_K=50 is safety cap (packToBudget is the real limiter).
- **No server-side extraction**: `MemoryEngine.store(content,{tags,importance})` (`engine.ts:19-31`) takes pre-formed content; caller decides what a memory is. compaction/consolidation operate on existing rows. Both benchmarks ingest raw chat turns 1:1.
- **LongMemEval has the SAME flatness bug**: `longmemeval/ingest.py:48` + `config.py:94` `importance_default=0.5`, one batch. So it's a held-out guard, NOT a representativeness fix. Downloads from HF `xiaowu0162/longmemeval-cleaned` (`dataset.py:20,47`), needs Ollama (`locomo/config.py:67`).
- **Representative-eval proposal**: `docs/designs/memory-eval-representative-set.md` (synthesize from Claude Code session logs). Session logs `~/.claude/projects/<proj>/<uuid>.jsonl`: 26 projects/308MB; per-entry ISO timestamps EXIST (36,755 entries span 2026-04-14→06-22, ~2.3mo → real recency); per-entry cwd/gitBranch/tool_use/file_path. Recommendation: curated-synthetic walking skeleton first (prove harness punishes metadata-dropping candidate), session-logs gold-standard after, behavioral re-use labeling (non-circular). PII: content-free fixture (`dump.ts:31` stores content_length only) + gitignore precedent (`benchmark/fixture/.gitignore`).

## Evolved surface (4 fns + constants, all `src/retrieval/scoring.ts`)
- `hybridScoreFusion` (:47) — `alpha=0.5` (:51); `minMaxNormalized` (:24) small-set `damping=0.3` (:30, count<=5); single-source path `:94-95`.
- `computeCompositeScore` (:129) — reads EXACTLY 5 candidate fields: `created_at`,`last_accessed_at`,`access_count`,`importance`,`fusionScore`. Weights `0.65/0.15/0.1/0.1` (:143-145); decays `-0.001`(:134)/`-0.002`(:137); `access_count/10` cap.
- `filterByRelevance` (:165) — `MIN_FUSION_FRACTION=0.05` (:163).
- `packToBudget` (:200) — reads only `content` length via `estimateTokens` ~4 chars/tok (:151).
- FROZEN (out of first-cut scope): `filterByRerankerScore` (:184, `RERANKER_SCORE_GAP=5` :182 — NOT 12, doc was stale), `reranker.ts`. Freezing = zero model calls in eval.

## Pipeline + raw pool (`src/retrieval/pipeline.ts`)
- Pool assembled `:47-50`: `vectorResults` ({id,distance,...MemoryRow} from `vectorSearch` queries.ts:138), `ftsResults` ({id,bm25_score,...MemoryRow} from `ftsSearch` queries.ts:160). Both extend `MemoryRow` (database.ts:6-28) → all 5 composite fields already on every pool row.
- `DEFAULT_CANDIDATE_LIMIT=50`, `MAX_VECTOR_DISTANCE=0.9` filter (:49). FTS bigram-OR sanitize `queries.ts:249`.
- Fusion at :70; composite+sort :86-90; relevance :93; reranker :99-107; dedup :114; pack :117.
- `--retrieval-only` flag does NOT expose the raw pool — it re-grades a frozen POST-fusion checkpoint (`retrieved_context`/`retrieved_tags`, benchmark/locomo/run.py:77-78,352). Dump tap is must-build, goes after pipeline.ts:50.

## TWO benchmark harnesses (Python + TS) — easy to confuse
- **Python** (`benchmark/locomo/`, `benchmark/longmemeval/`): the labeled-retrieval metric the dogfood uses. `retrieval_metrics.py:33 score_retrieval` = pure set-membership.
- **TS** (`benchmark/harness.ts`,`scorer.ts`,`run.ts`,`runner.ts`,`types.ts`): a SEPARATE quality benchmark (mustInclude/mustExclude substring+semantic). NOT the dogfood metric. `harness.ts:spawnServer` IS reusable to drive the fixture dump.

## Citation-drift gotchas (verified 2026-06-21)
- `updateAccessStats` on the RECALL path is `pipeline.ts:172` (retrieval pipeline); there is ALSO an `engine-impl.ts:172` call but that's the `buildContext`/`memory_context` path, NOT recall. Docs that cite "queries.ts:120-134 + pipeline.ts:172" conflate the def (queries.ts:120) with the call (pipeline.ts:172) — both real, easy to mis-attribute.
- Dump tap fires at `pipeline.ts:98-101` (BEFORE fusion, captures raw vector+FTS pool); `updateAccessStats` fires at `pipeline.ts:172` AFTER selection. So dumped `access_count` reflects only PRIOR recalls.
- "One-field rename gold_dia_ids→gold_memory_ids" is UNDER-stated: candidate rankPool ends `return packed.map((c) => c.dia_id)` in ALL 6 candidate .mjs files (initial_program:203, perturbed_*, parametric_fusion:114) + scoring-lib reads `q.gold_dia_ids` (2x) + isScorable (:46). Renaming the per-candidate `dia_id` field breaks every evolve candidate. Keep `dia_id` as the OPAQUE gold-key column (populate from mem_id) to avoid touching candidates.
- No metadata-dropping "LoCoMo winner" candidate file exists in repo (only initial_program + 5 perturbed: alpha09, no_relevance_filter, return_empty, vector_only_order, parametric). §9 skeleton must AUTHOR it.
- Real-prompt yield (measured all 40 sessions): only 1171 string/text-block user prompts total; 856 (73%) from 2 IronCurtain projects. Cross-session file re-reference (the §4a label signal) in largest project = only 19 file_paths touched in >=2 sessions. R6's "1500-2000 scorable queries" is infeasible from this corpus.

## Label schemes (set-membership both, DIFFERENT gold key)
- **LoCoMo**: gold = `qa[].evidence` list of `dia_id` strings (`D1:3` format). In-repo: `benchmark/data/locomo10.json` (10 convs, ~150-200 QA each; categories 1-5; **cat 5 = adversarial, empty evidence → exclude from fitness**). Ingest tags each turn `dia_id:<id>` (ingest.py:79). Recall = |topK∩evidence|/|evidence|.
- **LongMemEval**: gold = `answer_session_ids`; recall over SESSIONS not turns (retrieval_metrics.py:36-60 maps dates→session_id). Ingest tags `session:<session_id>` (ingest.py:71-79). **NOT in-repo — downloads from HuggingFace `xiaowu0162/longmemeval-cleaned`** (dataset.py:47). Held-out fixture = same shape, gold field `session_id`; HF-download is the biggest build risk.

## Storage (`src/storage/database.ts`)
- SQLite + sqlite-vec (768-dim cosine) + FTS5 (porter). `MemoryRow` cols: id,namespace,content,tags,importance,created_at,updated_at,last_accessed_at,access_count,is_compacted,consolidated,source,metadata.

## Evolve container TS-execution answer
- Node 22 IS in evolve base image (x86 `devcontainers/universal` ships node; arm64 `FROM node:22-trixie`; Dockerfile.claude-code:3). npm/npx present; **tsx NOT pre-installed**.
- RESOLUTION: candidate + evaluator as plain `.mjs` (ESM JS), Node runs natively via dynamic import(), zero compile/tsx. Evolve candidate file is extensionless `code` → copy to `*.mjs` before import (mirrors Python evaluator.py:107 exec of extensionless code).
- Evolve `EVAL_CMD` is arbitrary (preflight agent infers it, workflow.yaml:160-163,202-207) — need NOT be Python. Candidate contract: one exported `rankPool(pool, tokenBudget) -> dia_id[]`.
