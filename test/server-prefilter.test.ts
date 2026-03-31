import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { checkServerRelevance, prefilterServers } from '../src/pipeline/server-prefilter.js';
import { mergeServerResults } from '../src/pipeline/pipeline-runner.js';
import type { ToolAnnotation, CompiledRule } from '../src/pipeline/types.js';

/** Matches the unexported ServerCompilationResult shape from pipeline-runner. */
type ServerResult = Parameters<typeof mergeServerResults>[0][number];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeV3Result(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [],
    request: {},
    response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
  };
}

function createMockModel(responses: string[]): MockLanguageModelV3 {
  let callIndex = 0;
  return new MockLanguageModelV3({
    doGenerate: async () => {
      if (callIndex >= responses.length) {
        throw new Error(
          `MockLanguageModelV3 called ${callIndex + 1} times, but only ${responses.length} responses were provided.`,
        );
      }
      return makeV3Result(responses[callIndex++]);
    },
  });
}

function createFailingModel(error: Error): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => {
      throw error;
    },
  });
}

const filesystemTools: ToolAnnotation[] = [
  { toolName: 'read_file', serverName: 'filesystem', comment: 'Read a file from the filesystem', args: {} },
  { toolName: 'write_file', serverName: 'filesystem', comment: 'Write content to a file', args: {} },
];

const githubTools: ToolAnnotation[] = [
  { toolName: 'search_issues', serverName: 'github', comment: 'Search GitHub issues', args: {} },
  { toolName: 'create_pr', serverName: 'github', comment: 'Create a pull request', args: {} },
];

const gitTools: ToolAnnotation[] = [
  { toolName: 'git_log', serverName: 'git', comment: 'Show commit history', args: {} },
  { toolName: 'git_branch', serverName: 'git', comment: 'List or create branches', args: {} },
];

// ---------------------------------------------------------------------------
// Unit tests: checkServerRelevance
// ---------------------------------------------------------------------------

describe('checkServerRelevance', () => {
  it('returns skip: true when the model says the server is irrelevant', async () => {
    const model = createMockModel([JSON.stringify({ skip: true, reason: 'No filesystem guidance found' })]);

    const result = await checkServerRelevance(
      'Only allow GitHub operations',
      'filesystem',
      filesystemTools,
      model,
      'constitution',
    );

    expect(result.serverName).toBe('filesystem');
    expect(result.skip).toBe(true);
    expect(result.reason).toBe('No filesystem guidance found');
  });

  it('returns skip: false when the model says the server is relevant', async () => {
    const model = createMockModel([JSON.stringify({ skip: false, reason: 'Constitution mentions file reading' })]);

    const result = await checkServerRelevance(
      'Allow reading any text files in the workspace',
      'filesystem',
      filesystemTools,
      model,
      'constitution',
    );

    expect(result.serverName).toBe('filesystem');
    expect(result.skip).toBe(false);
    expect(result.reason).toBe('Constitution mentions file reading');
  });

  it('fails open (skip: false) when the model throws an error', async () => {
    const model = createFailingModel(new Error('API rate limit exceeded'));

    const result = await checkServerRelevance(
      'Allow reading files',
      'filesystem',
      filesystemTools,
      model,
      'constitution',
    );

    expect(result.serverName).toBe('filesystem');
    expect(result.skip).toBe(false);
    expect(result.reason).toContain('Pre-filter error');
    expect(result.reason).toContain('API rate limit exceeded');
  });

  it('fails open when model returns invalid JSON (schema validation fails)', async () => {
    // generateObjectWithRepair will try to repair once, then throw.
    // Both attempts return invalid JSON, so checkServerRelevance catches the error.
    const model = createMockModel(['not valid json at all', 'still not valid json']);

    const result = await checkServerRelevance(
      'Allow reading files',
      'filesystem',
      filesystemTools,
      model,
      'constitution',
    );

    expect(result.serverName).toBe('filesystem');
    expect(result.skip).toBe(false);
    expect(result.reason).toContain('Pre-filter error');
  });

  it('works with task-policy constitution kind', async () => {
    const model = createMockModel([JSON.stringify({ skip: true, reason: 'Task does not require GitHub' })]);

    const result = await checkServerRelevance(
      'Analyze CSV files in the data directory',
      'github',
      githubTools,
      model,
      'task-policy',
    );

    expect(result.skip).toBe(true);
    expect(result.serverName).toBe('github');
  });
});

// ---------------------------------------------------------------------------
// Unit tests: prefilterServers
// ---------------------------------------------------------------------------

describe('prefilterServers', () => {
  it('short-circuits on empty text without calling the model', async () => {
    let modelCalled = false;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        modelCalled = true;
        return makeV3Result(JSON.stringify({ skip: false, reason: 'should not happen' }));
      },
    });

    const servers: Array<[string, ReadonlyArray<ToolAnnotation>]> = [
      ['filesystem', filesystemTools],
      ['github', githubTools],
    ];

    const results = await prefilterServers('', servers, model, 'constitution');

    expect(modelCalled).toBe(false);
    expect(results).toHaveLength(2);
    expect(results.every((d) => d.skip)).toBe(true);

    // Also works with whitespace-only text
    const results2 = await prefilterServers('   \n  ', servers, model, 'constitution');
    expect(modelCalled).toBe(false);
    expect(results2).toHaveLength(2);
    expect(results2.every((d) => d.skip)).toBe(true);
  });

  it('calls the model for each server and returns decisions', async () => {
    const model = createMockModel([
      JSON.stringify({ skip: false, reason: 'Filesystem is relevant' }),
      JSON.stringify({ skip: true, reason: 'GitHub is not needed' }),
    ]);

    const servers: Array<[string, ReadonlyArray<ToolAnnotation>]> = [
      ['filesystem', filesystemTools],
      ['github', githubTools],
    ];

    const results = await prefilterServers('Allow reading local files only', servers, model, 'constitution');

    expect(results).toHaveLength(2);

    const fsDecision = results.find((d) => d.serverName === 'filesystem');
    expect(fsDecision?.skip).toBe(false);

    const ghDecision = results.find((d) => d.serverName === 'github');
    expect(ghDecision?.skip).toBe(true);
  });

  it('handles a single server', async () => {
    const model = createMockModel([JSON.stringify({ skip: false, reason: 'Git is needed for branch operations' })]);

    const results = await prefilterServers('Allow listing branches', [['git', gitTools]], model, 'task-policy');

    expect(results).toHaveLength(1);
    expect(results[0].serverName).toBe('git');
    expect(results[0].skip).toBe(false);
  });

  it('runs all servers concurrently (returns results for all even if some fail)', async () => {
    // First call succeeds, second call fails (model only has one response)
    // The second call will throw, but checkServerRelevance catches it and fails open
    let callCount = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return makeV3Result(JSON.stringify({ skip: true, reason: 'Not needed' }));
        }
        throw new Error('Connection timeout');
      },
    });

    const servers: Array<[string, ReadonlyArray<ToolAnnotation>]> = [
      ['filesystem', filesystemTools],
      ['github', githubTools],
    ];

    const results = await prefilterServers('Some task', servers, model, 'constitution');

    expect(results).toHaveLength(2);
    // One should have skip: true (succeeded), one should have skip: false (failed open)
    const succeeded = results.find((d) => d.skip);
    const failedOpen = results.find((d) => !d.skip);
    expect(succeeded).toBeDefined();
    expect(failedOpen).toBeDefined();
    expect(failedOpen!.reason).toContain('Pre-filter error');
  });
});

// ---------------------------------------------------------------------------
// Prompt content tests (tested indirectly through checkServerRelevance)
// ---------------------------------------------------------------------------

describe('buildPrefilterPrompt (indirect)', () => {
  /** Extract the system message from the V3 prompt array passed to doGenerate. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- AI SDK internal prompt shape
  function extractSystemFromPrompt(options: Record<string, any>): string | undefined {
    const prompt = options.prompt as Array<{ role: string; content: string }> | undefined;
    const systemMsg = prompt?.find((m: { role: string }) => m.role === 'system');
    return systemMsg?.content;
  }

  it('constitution mode prompt mentions "allowed or granted special permissions"', async () => {
    let capturedSystem: string | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedSystem = extractSystemFromPrompt(options);
        return makeV3Result(JSON.stringify({ skip: false, reason: 'relevant' }));
      },
    });

    await checkServerRelevance('Allow file reading', 'filesystem', filesystemTools, model, 'constitution');

    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).toContain('allowed or granted special permissions');
    expect(capturedSystem).not.toContain('accomplishing this task would require');
  });

  it('task-policy mode prompt mentions "accomplishing this task would require"', async () => {
    let capturedSystem: string | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedSystem = extractSystemFromPrompt(options);
        return makeV3Result(JSON.stringify({ skip: false, reason: 'relevant' }));
      },
    });

    await checkServerRelevance('Analyze CSV files', 'filesystem', filesystemTools, model, 'task-policy');

    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).toContain('accomplishing this task would require');
    expect(capturedSystem).not.toContain('allowed or granted special permissions');
  });

  it('prompt includes server name and tool descriptions', async () => {
    let capturedSystem: string | undefined;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        capturedSystem = extractSystemFromPrompt(options);
        return makeV3Result(JSON.stringify({ skip: false, reason: 'relevant' }));
      },
    });

    await checkServerRelevance('Some text', 'github', githubTools, model, 'constitution');

    expect(capturedSystem).toBeDefined();
    expect(capturedSystem).toContain('"github"');
    expect(capturedSystem).toContain('search_issues');
    expect(capturedSystem).toContain('Search GitHub issues');
    expect(capturedSystem).toContain('create_pr');
  });
});

// ---------------------------------------------------------------------------
// Functional tests: mergeServerResults with skippedServers
// ---------------------------------------------------------------------------

describe('mergeServerResults with skippedServers', () => {
  const sampleRule: CompiledRule = {
    name: 'allow-read-file',
    description: 'Allow reading files in sandbox',
    principle: 'File reading is safe',
    if: { server: ['filesystem'], tool: ['read_file'] },
    then: 'allow',
    reason: 'Read-only access is safe',
  };

  it('includes skippedServers in the output when provided', () => {
    const results: ServerResult[] = [
      {
        serverName: 'filesystem',
        rules: [sampleRule],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'abc123',
        constitutionHash: 'const-hash',
      },
    ];

    const skipped = [
      { serverName: 'github', reason: 'No GitHub guidance in constitution' },
      { serverName: 'slack', reason: 'No Slack guidance in constitution' },
    ];

    const merged = mergeServerResults(results, 'const-hash', skipped);

    expect(merged.skippedServers).toBeDefined();
    expect(merged.skippedServers).toHaveLength(2);
    expect(merged.skippedServers![0].serverName).toBe('github');
    expect(merged.skippedServers![1].serverName).toBe('slack');
    expect(merged.rules).toHaveLength(1);
  });

  it('omits skippedServers field when no servers were skipped', () => {
    const results: ServerResult[] = [
      {
        serverName: 'filesystem',
        rules: [sampleRule],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'abc123',
        constitutionHash: 'const-hash',
      },
    ];

    const merged = mergeServerResults(results, 'const-hash');

    expect(merged.skippedServers).toBeUndefined();
  });

  it('omits skippedServers field when empty array is passed', () => {
    const results: ServerResult[] = [
      {
        serverName: 'filesystem',
        rules: [sampleRule],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'abc123',
        constitutionHash: 'const-hash',
      },
    ];

    const merged = mergeServerResults(results, 'const-hash', []);

    expect(merged.skippedServers).toBeUndefined();
  });

  it('works when all servers are skipped (no rules)', () => {
    const skipped = [
      { serverName: 'filesystem', reason: 'Not relevant' },
      { serverName: 'github', reason: 'Not relevant' },
    ];

    const merged = mergeServerResults([] as ServerResult[], 'const-hash', skipped);

    expect(merged.rules).toHaveLength(0);
    expect(merged.skippedServers).toHaveLength(2);
  });

  it('preserves rules from compiled servers alongside skipped servers', () => {
    const rule2: CompiledRule = {
      name: 'allow-git-log',
      description: 'Allow git log',
      principle: 'Read-only git is safe',
      if: { server: ['git'], tool: ['git_log'] },
      then: 'allow',
      reason: 'Read-only',
    };

    const results: ServerResult[] = [
      {
        serverName: 'filesystem',
        rules: [sampleRule],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'abc123',
        constitutionHash: 'const-hash',
      },
      {
        serverName: 'git',
        rules: [rule2],
        listDefinitions: [],
        scenarios: [],
        inputHash: 'def456',
        constitutionHash: 'const-hash',
      },
    ];

    const skipped = [{ serverName: 'github', reason: 'Skipped by pre-filter' }];

    const merged = mergeServerResults(results, 'const-hash', skipped);

    expect(merged.rules).toHaveLength(2);
    expect(merged.skippedServers).toHaveLength(1);
    // Rules should be sorted by server name (filesystem before git)
    expect(merged.rules[0].name).toBe('allow-read-file');
    expect(merged.rules[1].name).toBe('allow-git-log');
  });
});
