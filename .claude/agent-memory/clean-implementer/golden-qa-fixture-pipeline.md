# Golden-QA de-saturation fixture (branch dogfood/memory-fusion)

Design: `docs/designs/memory-fusion-golden-qa-eval.md` (successor to evolve-memory-fusion-dogfood). Goal: a HARDER, non-self-supervised gold standard so `evolve` has real ranking headroom. Pipeline lives in `packages/memory-mcp-server/benchmark/golden/` (worktree-only, gitignored-adjacent; NOT in main checkout). Run from worktree `/Users/provos/src/ironcurtain-dogfood`.

## Invocation (worktree has NO .env)
`cd /Users/provos/src/ironcurtain-dogfood && DOTENV_CONFIG_PATH=/Users/provos/src/ironcurtain/.env npx tsx --import dotenv/config packages/memory-mcp-server/benchmark/golden/<script>.ts <flags>`
- ALL `donotcommit/` artifacts live in the MAIN checkout (`/Users/provos/src/ironcurtain/donotcommit/...`) — the script DEFAULTS hardcode those abs paths. The worktree has no `donotcommit/`. Pass abs paths to the `.mjs` measure script (it has no defaults).
- The `.mjs` ranker/scorer/tuner (`fusion-evolve/{parametric_fusion,scoring-lib,initial_program,tune-constants}.mjs`) ARE in the worktree (untracked). `measure-desaturation.mjs` imports them via `../fusion-evolve/`.

## Pipeline stages
- `cluster-conversations.ts` → `golden-clusters.json` (conversation-CENTROID greedy clustering + cluster-level 70/30 split). `source_to_cluster` map + per-cluster `split`. Reuse the existing file if threshold/split unchanged.
- `generate-golden-qa.ts` → `golden-qa.jsonl` (Sonnet `claude-sonnet-4-6`, Tier A per-conv + Tier B over multi-source clusters; emits `{question, answer_quality, evidence:[{conversation_uuid,quote}]}`).
- `generate-synthetic-union.ts` (NEW, this session) → `golden-qa-synthetic.jsonl` (Haiku bridging question over a fact-embedding-clustered union; emits `synthetic_gold` fact-ids directly).
- `build-golden-fixture.ts` → content-free `*-pool.jsonl` + report. Maps evidence→gold (quote→segment resolve, τ_seg=0.6, 2–8 cap), OR bypasses for `synthetic_gold`. Reuses `buildCandidatePool` (diagnose-lib). Tags `tier`/`split`/`granularity`/`divergence`.
- `measure-desaturation.mjs <pool> [--budget 300] [--split train|test|all]` → the GATE table (baseline recall, seg-level ceiling M9, in-pool ranking_recall M2b, divergence M4, conv-fallback mass M3, headroom gaps).

## CLI GOTCHA — generate-golden-qa.ts --tier-mix is clobbered by default --n
`parseArgs` does `if (tierA+tierB !== n) { tierA=round(n*0.37); tierB=n-tierA }`. `--n` DEFAULTS to 60. So `--tier-mix 80,55` ALONE silently resets to 22/38 (because 135≠60). MUST pass BOTH `--n 135 --tier-mix 80,55`. Confirm via the log line `Tier A: ... target <N>` before letting it run to completion.

## Clustering phase transition (the Tier-B constraint, MEASURED)
Conversation-centroid clustering (`clusterSources`) over 323 sources does NOT robustly scale multi-source cluster COUNT by going coarser. Threshold sweep: 0.74→5 multi-source, 0.70→13, 0.68→16 (largest 24), 0.66→18 but a 130-source blob forms, 0.64→6 (211-blob), ≤0.60→single mega-cluster. Sweet spot for COUNT is ~0.68-0.70 (≤18 multi-source). Natural Tier B caps at ~16-18 clusters → pushing ~150 natural Tier-B questions forces repetition/vocab-echo over the same clusters. Resolution: **synthetic-union (design M6) is the Tier-B SCALER**, not natural re-clustering.

## Synthetic-union (M6) — the real Tier-B scaler
`clusterFacts` (k-means over the 3920 FACT embeddings, not conv centroids) → theme clusters that cut ACROSS conversations. At clusters-k=80: 80 theme clusters, 77 usable (≥3 distinct sources), top clusters span 40-54 sources / 100-219 facts each. `sampleSyntheticUnion(cluster,k,minSources,rng)` greedily picks k facts spanning ≥minSources sources (pass1 one-per-new-source, pass2 backfill on-theme). Gold dispersion across `source` is guaranteed BY CONSTRUCTION → low query↔gold divergence + dispersed gold without rejected-Sonnet cost. Haiku writes the bridging question over fact texts only (never full conversations → can't echo one conv's vocab). Both pure helpers added to `golden-lib.ts`; `build-golden-fixture.ts` honors `synthetic_gold` (tags 'segment', applies 2–8 cap).

## Pilot baseline (n=60, GO) — reproduced this session
baseline recall 0.407 vs seg-ceiling 0.682; Tier-B ranking gap 0.176 (Tier-A gap 0.009 — near-saturated on ranking); divergence 0.643; conv-fallback mass 0.093 (<20% ✓). De-saturation comes almost ENTIRELY from Tier B.
