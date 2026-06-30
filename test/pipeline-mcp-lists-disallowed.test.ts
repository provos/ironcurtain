/**
 * R3 — a list that requires live MCP (`requiresMcp: true`) compiled with
 * `allowMcpLists: false` must surface the typed `McpListsDisallowedError`
 * (discriminant `code: 'MCP_LISTS_DISALLOWED'`) OUT of `PipelineRunner.run`.
 *
 * The bug: `resolveServerLists` throws this error PER SERVER, but the per-server
 * compile loops (`compileServersSequential` / `compileServersParallel`) caught
 * every error and folded it into a generic `failedServers` aggregate, so the
 * orchestrator only ever saw "All N server(s) failed compilation" — losing the
 * `MCP_LISTS_DISALLOWED` discriminant it maps to the UI `LIST_REQUIRES_MCP`
 * code. The fix re-throws this specific error past the aggregation.
 *
 * These tests drive the REAL runner (fake LLM only) so a regression that
 * re-swallows the error fails here. Both the sequential (single-server) and
 * parallel (>1 server) aggregation paths are covered.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import type { LanguageModelV3CallOptions } from '@ai-sdk/provider';

import { PipelineRunner, type PipelineRunConfig, type PipelineModels } from '../src/pipeline/pipeline-runner.js';
import type { ServerProgressReporter } from '../src/pipeline/pipeline-shared.js';
import type { PromptCacheStrategy } from '../src/session/prompt-cache.js';
import type { StoredToolAnnotationsFile } from '../src/pipeline/types.js';
import { createFakePipelineModels } from './fixtures/fake-pipeline-models.js';
import {
  GOLDEN_ALLOWED_DIR,
  GOLDEN_ANNOTATIONS,
  GOLDEN_CONSTITUTION,
  GOLDEN_RESPONSES,
} from './fixtures/golden-pipeline-fixture.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeOutputDir(): { workDir: string; outputDir: string; logPath: string } {
  const workDir = mkdtempSync(resolve(tmpdir(), 'ic-r3-'));
  dirs.push(workDir);
  const outputDir = resolve(workDir, 'generated');
  mkdirSync(outputDir, { recursive: true });
  return { workDir, outputDir, logPath: resolve(workDir, 'llm-interactions.jsonl') };
}

/** Discriminant the orchestrator keys on (code === 'MCP_LISTS_DISALLOWED'). */
function errorCodeOf(err: unknown): unknown {
  return typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
}

describe('R3 — MCP-backed list with allowMcpLists:false surfaces past per-server aggregation', () => {
  it('sequential path: rejects run() with MCP_LISTS_DISALLOWED (not a generic aggregate error)', async () => {
    const { outputDir, logPath } = makeOutputDir();

    // Reuse the single-server golden fixture but flip its one list to require MCP.
    const responses = {
      ...GOLDEN_RESPONSES,
      compile: {
        ...(GOLDEN_RESPONSES.compile as { listDefinitions: unknown[] }),
        listDefinitions: [
          {
            name: 'trusted-news-sites',
            type: 'domains',
            principle: 'Allow fetching news only from major trusted news sites.',
            generationPrompt: 'List the major trusted news site domains.',
            requiresMcp: true, // <-- now needs live MCP
          },
        ],
      },
    };

    const config: PipelineRunConfig = {
      constitutionInput: GOLDEN_CONSTITUTION,
      constitutionKind: 'constitution',
      outputDir,
      toolAnnotationsDir: outputDir,
      allowedDirectory: GOLDEN_ALLOWED_DIR,
      protectedPaths: [],
      preloadedStoredAnnotations: GOLDEN_ANNOTATIONS,
      includeHandwrittenScenarios: false,
      llmLogPath: logPath,
      allowMcpLists: false, // <-- WS compile path
    };

    let caught: unknown;
    try {
      await new PipelineRunner(createFakePipelineModels(responses, logPath)).run(config);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorCodeOf(caught)).toBe('MCP_LISTS_DISALLOWED');
    // The specific list name is carried for a useful UI message.
    expect((caught as { listNames?: string[] }).listNames).toContain('trusted-news-sites');
  });

  it('parallel path (>1 server): rejects run() with MCP_LISTS_DISALLOWED', async () => {
    const { outputDir, logPath } = makeOutputDir();

    // Two servers => entriesToCompile.length > 1 => parallel compile path.
    const SERVERS = ['srv-a', 'srv-b'];
    const annotations: StoredToolAnnotationsFile = {
      generatedAt: '2024-01-01T00:00:00.000Z',
      servers: Object.fromEntries(
        SERVERS.map((s) => [
          s,
          {
            inputHash: `golden-${s}`,
            tools: [
              {
                toolName: 'http_fetch',
                serverName: s,
                comment: 'Fetches web content via HTTP GET.',
                args: { url: ['fetch-url' as const] },
                inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
              },
            ],
          },
        ]),
      ),
    };

    const models = makePerServerFakeModels(logPath);
    const config: PipelineRunConfig = {
      constitutionInput: GOLDEN_CONSTITUTION,
      constitutionKind: 'constitution',
      outputDir,
      toolAnnotationsDir: outputDir,
      allowedDirectory: GOLDEN_ALLOWED_DIR,
      protectedPaths: [],
      preloadedStoredAnnotations: annotations,
      includeHandwrittenScenarios: false,
      llmLogPath: logPath,
      allowMcpLists: false,
      // No-op reporter => the built-in ParallelProgressDisplay is not constructed
      // (no stderr spam) while still exercising the parallel aggregation path.
      reporterFactory: () => noopReporter,
    };

    let caught: unknown;
    try {
      await new PipelineRunner(models).run(config);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(errorCodeOf(caught)).toBe('MCP_LISTS_DISALLOWED');
  });
});

const noopReporter: ServerProgressReporter = {
  update: () => {},
  complete: () => {},
  warn: () => {},
  fail: () => {},
  done: () => {},
};

const identityCacheStrategy: PromptCacheStrategy = { wrapSystemPrompt: (s: string) => s };

/** System-prompt text from V3 call options (string or system-role message). */
function systemTextOf(options: LanguageModelV3CallOptions): string {
  const sys: unknown = (options as { system?: unknown }).system;
  if (typeof sys === 'string') return sys;
  for (const msg of options.prompt) {
    if (msg.role === 'system') return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  }
  return '';
}

/**
 * Fake models for the parallel path: routes the per-server compile call by the
 * server scope embedded in the compiler system prompt, returning rules scoped to
 * that server with an MCP-backed list. The run aborts at list resolution, so the
 * scenario/judge/list-resolution responses are never requested.
 */
function makePerServerFakeModels(logPath: string): PipelineModels {
  const baseLlm = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const system = systemTextOf(options);
      if (system.includes('You are compiling a security policy')) {
        const m = /compiling rules for the "(.+?)" server/.exec(system);
        const server = m?.[1];
        if (!server) throw new Error(`Fake LLM: compile call without a server scope. System: ${system.slice(0, 200)}`);
        const listName = `${server}-news`;
        return mockV3Result({
          rules: [
            {
              name: `${server}-allow-news`,
              description: 'Allow fetching from trusted news domains.',
              principle: 'Allow fetching news only from major trusted news sites.',
              if: {
                server: [server],
                tool: ['http_fetch'],
                domains: { roles: ['fetch-url'], allowed: [`@${listName}`] },
              },
              then: 'allow',
              reason: 'Trusted news domain.',
            },
          ],
          listDefinitions: [
            {
              name: listName,
              type: 'domains',
              principle: 'Allow fetching news only from major trusted news sites.',
              generationPrompt: 'List the major trusted news site domains.',
              requiresMcp: true,
            },
          ],
        });
      }
      throw new Error(
        `Fake LLM: unexpected call before list resolution. System: ${JSON.stringify(system.slice(0, 120))}`,
      );
    },
  });
  return {
    baseLlm,
    cacheStrategy: identityCacheStrategy,
    logPath,
    prefilterModel: baseLlm,
  };
}

/** Minimal V3 generate result wrapping a JSON object (matches the golden fake). */
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
