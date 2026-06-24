/**
 * Fixed fixture for the Phase 0 pipeline golden harness.
 *
 * A minimal SINGLE-server (`fetch`) fixture so the pipeline takes the
 * deterministic sequential compile path (useParallel = entriesToCompile > 1).
 *
 * Exercises:
 *  - constitution compilation (one allow rule with a domain list, one rule with
 *    a `paths.within` so resolveRulePaths' transform branch runs)
 *  - dynamic-list resolution (knowledge list `trusted-news-sites`)
 *  - scenario generation + engine execution
 *  - verification (judge passes in round 1)
 *  - artifact assembly + write of compiled-policy.json and dynamic-lists.json
 *
 * The canned LLM responses are hand-authored to be valid against the real Zod
 * schemas at each phase. They are deterministic, not real-world faithful.
 */

import { realpathSync } from 'node:fs';
import type { StoredToolAnnotationsFile } from '../../src/pipeline/types.js';
import type { CannedResponses } from './fake-pipeline-models.js';

/**
 * A pre-canonicalized real path used in a `paths.within` rule. We resolve it
 * up front via realpathSync so the value is already canonical: resolveRulePaths
 * still runs its transform branch (calls resolveRealPath, compares) but the
 * result is platform-stable, keeping the committed golden deterministic across
 * macOS (/tmp -> /private/tmp) and Linux.
 */
export const GOLDEN_WITHIN_PATH = realpathSync('/tmp');

/**
 * Fixed sandbox directory. The compiler-prompt hash (and thus the artifact
 * inputHash) depends on allowedDirectory, so it must be a stable, platform-
 * independent constant — NOT a random temp dir — for the committed golden to be
 * reproducible. No rule references it; it only appears in the prompt text.
 */
export const GOLDEN_ALLOWED_DIR = '/golden/sandbox';

/** Single-server constitution. Minimal but produces a list reference + a path rule. */
export const GOLDEN_CONSTITUTION = `# Fetch Policy

1. Allow fetching news only from major trusted news sites.
2. Reads under the temp directory are permitted.`;

/** Tool annotations for the single `fetch` server (StoredToolAnnotationsFile shape). */
export const GOLDEN_ANNOTATIONS: StoredToolAnnotationsFile = {
  generatedAt: '2024-01-01T00:00:00.000Z',
  servers: {
    fetch: {
      inputHash: 'golden-fixture',
      tools: [
        {
          toolName: 'http_fetch',
          serverName: 'fetch',
          comment: 'Fetches web content via HTTP GET.',
          args: { url: ['fetch-url'] },
          inputSchema: {
            type: 'object',
            properties: {
              url: { type: 'string' },
            },
            required: ['url'],
          },
        },
      ],
    },
  },
};

/**
 * Canned LLM responses, one per pipeline phase. Each is validated against the
 * real Zod schema by virtue of the pipeline accepting them without repair.
 */
export const GOLDEN_RESPONSES: CannedResponses = {
  // Phase 1: constitution compiler. Two rules:
  //  - allow-trusted-news: domain list rule referencing @trusted-news-sites
  //  - allow-temp-reads: a paths.within rule (exercises resolveRulePaths transform)
  compile: {
    rules: [
      {
        name: 'allow-trusted-news',
        description: 'Allow fetching from trusted news domains.',
        principle: 'Allow fetching news only from major trusted news sites.',
        if: {
          server: ['fetch'],
          tool: ['http_fetch'],
          domains: {
            roles: ['fetch-url'],
            allowed: ['@trusted-news-sites'],
          },
        },
        then: 'allow',
        reason: 'Trusted news domain.',
      },
      {
        name: 'allow-temp-reads',
        description: 'Allow fetch operations whose URL role resolves under the temp directory.',
        principle: 'Reads under the temp directory are permitted.',
        if: {
          server: ['fetch'],
          paths: {
            roles: ['read-path'],
            within: GOLDEN_WITHIN_PATH,
          },
        },
        then: 'allow',
        reason: 'Within temp directory.',
      },
    ],
    listDefinitions: [
      {
        name: 'trusted-news-sites',
        type: 'domains',
        principle: 'Allow fetching news only from major trusted news sites.',
        generationPrompt: 'List the major trusted news site domains.',
        requiresMcp: false,
      },
    ],
  },

  // Phase 2: knowledge-list resolution for `trusted-news-sites`.
  listResolution: { values: ['nytimes.com', 'bbc.com', 'reuters.com'] },

  // Phase 3: scenario generation. All scenarios are structurally valid (known
  // tool, non-sandbox, correct expectations) so no scenario-repair fires.
  scenarios: {
    scenarios: [
      {
        description: 'Fetch from a trusted news domain.',
        request: {
          serverName: 'fetch',
          toolName: 'http_fetch',
          arguments: { url: 'https://nytimes.com/world' },
        },
        expectedDecision: 'allow',
        reasoning: 'nytimes.com is in the trusted-news-sites list.',
      },
      {
        description: 'Fetch from an untrusted domain.',
        request: {
          serverName: 'fetch',
          toolName: 'http_fetch',
          arguments: { url: 'https://evil.example/payload' },
        },
        expectedDecision: 'deny',
        reasoning: 'No rule matches an untrusted domain; default-deny applies.',
      },
    ],
  },

  // Phase 4: verifier judge passes in round 1 (no probes, no failures).
  judge: {
    analysis: 'All scenarios match expected decisions. Policy correctly implements the constitution.',
    pass: true,
    failureAttributions: [],
    additionalScenarios: [],
  },
};
