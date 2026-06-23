# Evolve memory-fusion dogfood (branch dogfood/memory-fusion)

Spec: `docs/designs/evolve-memory-fusion-dogfood.md`. Goal: run IronCurtain `evolve` on the memory MCP server's hybrid-fusion retrieval scoring. Evaluator is pure Node over a cached candidate-pool fixture; the ONLY model work is the one-time fixture dump.

## Container network escape hatch (KEY)
- `IRONCURTAIN_MITM_ALLOW_ALL_HOSTS=1` (or `'true'`) — in `src/docker/mitm-proxy.ts` (~:615). Widens the CONNECT/HTTP catch-all so ANY host not a configured provider/registry is tunneled as raw passthrough. Defeats egress filtering for unknown hosts. This is what lets the HuggingFace BGE download succeed in-container.
- The container needs THREE things to fetch HF through the proxy: `HTTPS_PROXY`/`HTTP_PROXY` → the proxy, `NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/ironcurtain-ca.crt` (the baked CA; Node doesn't read the system store), and the allow-all env. HF downloads from `https://huggingface.co/` (+ LFS CDN redirects).
- The IronCurtain CA is baked into the base image at build time AND lives at `~/.ironcurtain/ca/ca-cert.pem` — verified identical fingerprint, so proxy MITM certs are trusted in-container.
- Phase-1a PROVEN: `ironcurtain-base:latest` + allow-all proxy → `npm install` (native arm64-linux better-sqlite3/sqlite-vec/transformers) + `tsc` + BGE download + real candidate pool all succeed. Harness: `benchmark/fixture/container-proxy-smoke.ts` (run via tsx from repo ROOT — imports `src/docker/`). `/workspace` is writable by the non-root `codespace` user; `/` and `/build` are NOT.

## Dump tap layering (src/ rootDir boundary)
- The tap in `src/retrieval/pipeline.ts` (after the raw pool is assembled, ~:99) is gated on `process.env.MEMORY_FIXTURE_DUMP_DIR`. It must NOT statically import `benchmark/` — `src/` has `rootDir: src`, so even a dynamic `import('../../benchmark/...')` with a STRING LITERAL triggers TS6059 (the type checker follows literal import specifiers). Fix: build the specifier at runtime (non-literal) so tsc can't resolve it.
- src/ vs dist/ relative-path trap: compiled `dist/retrieval/pipeline.js` resolves `../../benchmark/...` to `dist/benchmark` (wrong). The driver passes the dump module's ABSOLUTE path via `MEMORY_FIXTURE_DUMP_MODULE` (→ `pathToFileURL`). Runtime impl is `benchmark/fixture/dump.mjs` (plain JS, loads identically from tsx-src and compiled-dist); `dump.ts` is a typed re-export wrapper (explicit signatures restore types across the .mjs interop boundary, else `no-unsafe-argument`).

## Fixture builder
- `benchmark/fixture/build-locomo-fixture.ts` (tsx) drives the dump via the production `MemoryEngine` DIRECTLY (no MCP subprocess, no Python) — single Node process, container-runnable. Ingest mirrors `benchmark/locomo/ingest.py` byte-for-byte: content `[speaker]: text`, tag `dia_id:<id>`, importance 0.5.
- Disable LLM by ensuring BOTH `MEMORY_LLM_BASE_URL` and `MEMORY_LLM_API_KEY` are null (`client.ts:12` gates on both-null). Empty strings `''` are NON-null → the OpenAI client builds and calls api.openai.com at startup (`createMemoryEngineFromConfig` fires `runMaintenance`/consolidation). `delete process.env.MEMORY_LLM_*` before `loadConfig`.
- Set `MEMORY_RERANKER_ENABLED=false` so no cross-encoder downloads. Capture `now` AFTER ingest (recall always follows store) so candidate ages are non-negative.
- Gold join: tap appends one pool record per recall in call order; driver zips with the ordered QA list by index AND asserts `pool.query === qa.question`.

## LoCoMo dataset gotcha (CONTRADICTS spec §1.3)
- In `benchmark/data/locomo10.json` (10 convs, 1986 QA, 5882 turns): `evidence` is a real JSON array `["D1:3"]`; `category` is a STRING `"2"` (cast with Number()).
- Adversarial **category-5 questions ALL HAVE evidence** (446 with, 0 empty). Only 4 cat-3 questions are empty-evidence. So the spec's assumption "exclude empty-evidence ≈ exclude cat-5" is WRONG for this dataset. Must exclude by `category === 5` explicitly in the evaluator/scoring (filtering empty gold_dia_ids alone misses all 446 cat-5). Fixture stores `category`; `scoring-lib.mjs isScorable()` enforces both rules.

## Files
- Generators (committable into `benchmark/fixture/` + `benchmark/fusion-evolve/`): `dump.mjs`/`dump.ts`, `build-locomo-fixture.ts`, `container-embed-smoke.mjs`, `container-proxy-smoke.ts`; `evaluator.mjs`, `scoring-lib.mjs` (shared pure scoring), `parametric_fusion.mjs` + `tune-constants.mjs` (constant-tuning ceiling), `initial_program.mjs` (baseline candidate).
- Staged experiment (gitignored `donotcommit/evolve-experiments/memory-fusion/`): mirrors `donotcommit/ASI-Evolve/experiments/circle_packing_demo/` — `input.md`, `initial_program` (extensionless baseline), `evaluator.mjs`+`scoring-lib.mjs`, `eval.sh` (`$1=code $2=results`, copies code→.mjs), `config.yaml`, `init_cognition.py` + `cognition_seed.md` (md is the form the evolve container actually uses; py needs non-vendored Evolve.*), `locomo-pool.jsonl` (static-staged fixture), `requirements.txt` (empty).
- Do NOT run the live evolve workflow (that's Phase 4, after human check-in). Do NOT commit. Do NOT `git stash` (unrelated stashes present).
