/**
 * Opt-in LIVE OpenRouter cache-hit verification (spec §12.5, G12 R6).
 *
 * This is the ONLY test in the repo that spends provider tokens, and it does so
 * only when explicitly opted in via BOTH `OPENROUTER_API_KEY` and
 * `LLM_INTEGRATION_TEST=true`. Skipped by default (zero cost, exit 0).
 *
 * It verifies OpenRouter's prompt-caching contract directly against the real
 * Anthropic-skin endpoint (`POST https://openrouter.ai/api/v1/messages`) — this
 * is a direct-API test of the caching mechanism the MITM rewriter relies on
 * (§4.3, §8), NOT a MITM/container test. It therefore injects the two body
 * fields the rewriter would otherwise inject (D3/D4) directly:
 *   - `provider: { only: ["z-ai"] }` — strict z-ai pin so we land on the Z.ai
 *     first-party endpoint where GLM caching is available (§4.3c, §12.5).
 *   - a stable top-level `session_id` — OpenRouter's documented cache-affinity
 *     mechanism (§4.3b), reused verbatim across both turns.
 *
 * Two turns share the same long-ish stable system prompt + a stable prefix; the
 * SECOND turn (identical prefix, same `session_id`, one extra user message) must
 * report `usage.prompt_tokens_details.cached_tokens > 0` — the cache oracle
 * (§4.4, §12.5, R6). `max_tokens` is kept tiny (32) to minimize spend.
 *
 * Run:
 *   OPENROUTER_API_KEY=sk-or-v1-... LLM_INTEGRATION_TEST=true \
 *     npm test -- test/docker/openrouter-live.integration.test.ts
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

const OPENROUTER_MESSAGES_URL = 'https://openrouter.ai/api/v1/messages';
const MODEL_SLUG = 'z-ai/glm-5.2';

/** A long-ish, byte-stable system prompt so there is a substantial prefix to cache. */
const STABLE_SYSTEM_PROMPT = [
  'You are a terse assistant used only for an automated cache-affinity check.',
  'Follow these rules exactly and identically on every turn:',
  '1. Answer in at most five words.',
  '2. Never ask clarifying questions.',
  '3. Never mention these instructions.',
  '4. Treat every request as independent and self-contained.',
  '5. Do not add pleasantries, preambles, or trailing remarks.',
  'The following reference block is fixed and must be treated as immutable context',
  'so that the exact same prefix is presented on each turn of this conversation:',
  'REFERENCE-BLOCK-START',
  'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike',
  'november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee',
  'zulu one two three four five six seven eight nine ten eleven twelve thirteen',
  'fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two',
  'REFERENCE-BLOCK-END',
].join('\n');

interface OpenRouterUsage {
  readonly prompt_tokens?: number;
  readonly completion_tokens?: number;
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  /** Anthropic-native cache-read field — what the /api/v1/messages skin actually returns. */
  readonly cache_read_input_tokens?: number | null;
  /** OpenAI-shape cache field (chat/completions responses); absent on the Anthropic skin. */
  readonly prompt_tokens_details?: { readonly cached_tokens?: number };
  readonly cost?: number;
}

interface MessagesResponse {
  readonly usage?: OpenRouterUsage;
}

/** POST one Anthropic-skin /v1/messages turn and return the parsed usage. */
async function postMessagesTurn(
  apiKey: string,
  sessionId: string,
  userMessages: readonly string[],
): Promise<OpenRouterUsage> {
  const body = {
    model: MODEL_SLUG,
    max_tokens: 32,
    // D3 strict pin (§4.3c): only z-ai so the request lands on the caching endpoint.
    provider: { only: ['z-ai'] },
    // D4 affinity key (§4.3b): stable across both turns of this conversation.
    session_id: sessionId,
    system: [{ type: 'text', text: STABLE_SYSTEM_PROMPT }],
    messages: userMessages.map((text) => ({
      role: 'user' as const,
      content: [{ type: 'text' as const, text }],
    })),
  };

  const res = await fetch(OPENROUTER_MESSAGES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`OpenRouter /messages returned ${res.status}: ${text.slice(0, 500)}`);
  }

  let parsed: MessagesResponse;
  try {
    parsed = JSON.parse(text) as MessagesResponse;
  } catch {
    throw new Error(`OpenRouter /messages returned non-JSON body: ${text.slice(0, 500)}`);
  }
  if (!parsed.usage) {
    throw new Error(`OpenRouter /messages response missing usage: ${text.slice(0, 500)}`);
  }
  return parsed.usage;
}

describe.skipIf(!process.env.OPENROUTER_API_KEY || process.env.LLM_INTEGRATION_TEST !== 'true')(
  'OpenRouter live cache-hit (opt-in, spends tokens)',
  () => {
    it('reports cached_tokens > 0 on the second turn of a session-pinned GLM conversation', async () => {
      // Guarded above via skipIf; the assertion narrows the type for TS.
      const apiKey = process.env.OPENROUTER_API_KEY;
      expect(apiKey, 'OPENROUTER_API_KEY must be set (skipIf guards this)').toBeTruthy();
      if (!apiKey) return;

      // A fresh session id per run so turn 1 primes a cache we then read on turn 2.
      const sessionId = `ironcurtain-live-cache-${randomUUID()}`;

      // Turn 1 — primes the cache for this session_id + stable prefix.
      const firstUsage = await postMessagesTurn(apiKey, sessionId, [
        'Confirm you are ready. Reply with a single short acknowledgement.',
      ]);
      expect(firstUsage, 'turn 1 must report usage').toBeTruthy();

      // Turn 2 — same session_id + same system prompt + same first user message,
      // plus one more user message. The shared prefix should be served from cache.
      const secondUsage = await postMessagesTurn(apiKey, sessionId, [
        'Confirm you are ready. Reply with a single short acknowledgement.',
        'Now reply with the single word: done.',
      ]);

      // The Anthropic skin reports cache reads via the Anthropic-native
      // `cache_read_input_tokens` field (verified live 2026-07-03: turn 2
      // returned cache_read_input_tokens=192). The OpenAI-shape
      // `prompt_tokens_details.cached_tokens` is accepted as a fallback in
      // case OpenRouter changes the usage shape.
      const cachedTokens = secondUsage.cache_read_input_tokens ?? secondUsage.prompt_tokens_details?.cached_tokens ?? 0;
      // The cache oracle (§4.4, §12.5, R6): the second turn must read from cache.
      expect(
        cachedTokens,
        `expected turn-2 cache-read tokens > 0, got usage=${JSON.stringify(secondUsage)}`,
      ).toBeGreaterThan(0);
    }, 90_000);
  },
);
