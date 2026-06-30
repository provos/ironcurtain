/**
 * Fake PipelineModels for the Phase 0 golden harness.
 *
 * Provides a deterministic, content-routing fake LanguageModelV3 that replays
 * canned responses for the policy-compilation call graph WITHOUT any network or
 * real LLM. The fake routes on the system prompt (and, for the system-less list
 * resolver, on the absence of a system prompt) so it is robust to internal
 * phase reordering — it does NOT depend on a positional response queue.
 *
 * Injected via `new PipelineRunner(fakeModels)` — no production change required.
 *
 * Call graph replayed (single-server, no cache, no prefilter, verify passes
 * in round 1, no discarded scenarios):
 *   1. ConstitutionCompilerSession.compile()  -> system "You are compiling a security policy"
 *   2. resolveViaLlm() (per knowledge list)   -> no system prompt
 *   3. generateScenarios() (single batch)     -> system "You are generating test scenarios"
 *   4. PolicyVerifierSession.judgeRound()      -> system "You are a security policy verifier"
 */

import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3, LanguageModelV3CallOptions } from '@ai-sdk/provider';
import type { PromptCacheStrategy } from '../../src/session/prompt-cache.js';
import type { PipelineModels } from '../../src/pipeline/pipeline-runner.js';

/** Canned responses keyed by pipeline phase. Each value is the bare JSON object the LLM "returns". */
export interface CannedResponses {
  /** Response for the constitution compiler (rules + listDefinitions). */
  readonly compile: unknown;
  /** Response for each knowledge-list resolution ({ values: [...] }). */
  readonly listResolution: unknown;
  /** Response for the scenario generator ({ scenarios: [...] }). */
  readonly scenarios: unknown;
  /** Response for the verifier judge ({ analysis, pass, failureAttributions, additionalScenarios }). */
  readonly judge: unknown;
}

/** Builds a mock V3 generate result with the correct finishReason/usage shapes. */
function mockV3Result(responseJson: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(responseJson) }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [] as never[],
    request: {},
    response: { id: 'fake-id', modelId: 'fake-model', timestamp: new Date(0) },
  };
}

/** Extracts the system-prompt text from V3 call options (system may be string or message). */
function systemTextOf(options: LanguageModelV3CallOptions): string {
  const sys: unknown = (options as { system?: unknown }).system;
  if (typeof sys === 'string') return sys;
  // The Vercel AI SDK passes `system` into the prompt as a system-role message.
  for (const msg of options.prompt) {
    if (msg.role === 'system') {
      // System message content is a plain string in V3 prompt format.
      return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    }
  }
  return '';
}

/**
 * Creates a content-routing fake base LLM. Returns the canned response that
 * matches the phase implied by the system prompt. Throws on any unrecognized
 * call so a changed/extra LLM call surfaces loudly instead of silently passing.
 */
export function createRoutingFakeBaseLlm(responses: CannedResponses): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (options) => {
      const system = systemTextOf(options);

      if (system.includes('You are compiling a security policy')) {
        return mockV3Result(responses.compile);
      }
      if (system.includes('You are generating test scenarios')) {
        return mockV3Result(responses.scenarios);
      }
      if (system.includes('You are a security policy verifier')) {
        return mockV3Result(responses.judge);
      }
      // The knowledge-based list resolver issues a generateText call with NO
      // system prompt — its user message carries the generationPrompt.
      if (system === '') {
        return mockV3Result(responses.listResolution);
      }

      throw new Error(`Fake LLM: unrecognized call. System prompt prefix: ${JSON.stringify(system.slice(0, 120))}`);
    },
  });
}

/** Identity cache strategy: the system prompt passes through unchanged as a string. */
const identityCacheStrategy: PromptCacheStrategy = {
  wrapSystemPrompt: (s: string) => s,
};

/**
 * Builds a complete fake PipelineModels. The prefilter model is the same routing
 * fake but is never exercised when the golden run passes `prefilterText: undefined`.
 */
export function createFakePipelineModels(responses: CannedResponses, logPath: string): PipelineModels {
  const baseLlm = createRoutingFakeBaseLlm(responses);
  return {
    baseLlm,
    cacheStrategy: identityCacheStrategy,
    logPath,
    // Never called in the golden run (prefilterText undefined). Provided for type
    // completeness; cast through unknown because MockLanguageModelV3 is a V3 model
    // and the prefilter field is typed as the wrapped `LanguageModel`.
    prefilterModel: baseLlm,
  };
}
