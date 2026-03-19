import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  annotateTools,
  buildRoleDescriptions,
  chunk,
  ANNOTATION_BATCH_SIZE,
  type MCPToolSchema,
} from '../src/pipeline/tool-annotator.js';
import { getRolesForServer } from '../src/types/argument-roles.js';

const sampleTools: MCPToolSchema[] = [
  {
    name: 'read_file',
    description: 'Read the complete contents of a file',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to read' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a file with new content',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source path' },
        destination: { type: 'string', description: 'Destination path' },
      },
      required: ['source', 'destination'],
    },
  },
  {
    name: 'list_allowed_directories',
    description: 'List the directories the server is allowed to access',
    inputSchema: { type: 'object', properties: {} },
  },
];

const cannedAnnotations = {
  annotations: [
    {
      toolName: 'read_file',
      comment: 'Reads the complete contents of a file from disk',

      args: { path: ['read-path'] },
    },
    {
      toolName: 'write_file',
      comment: 'Creates or overwrites a file with new content',

      args: { path: ['write-path'], content: ['none'] },
    },
    {
      toolName: 'move_file',
      comment: 'Moves a file from source to destination, deleting the source',

      args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
    },
    {
      toolName: 'list_allowed_directories',
      comment: 'Lists directories the server is allowed to access',

      args: {},
    },
  ],
};

function createMockModel(response: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      finishReason: { unified: 'stop' as const, raw: 'stop' },
      usage: {
        inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 50, text: undefined, reasoning: undefined },
      },
      warnings: [],
      request: {},
      response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
    }),
  });
}

describe('Tool Annotator', () => {
  describe('annotateTools', () => {
    it('returns annotations for all tools from LLM response', async () => {
      const mockLLM = createMockModel(cannedAnnotations);
      const result = await annotateTools('filesystem', sampleTools, mockLLM);

      expect(result).toHaveLength(4);
      expect(result.every((a) => a.serverName === 'filesystem')).toBe(true);
    });

    it('correctly maps tool names', async () => {
      const mockLLM = createMockModel(cannedAnnotations);
      const result = await annotateTools('filesystem', sampleTools, mockLLM);

      const names = result.map((a) => a.toolName);
      expect(names).toContain('read_file');
      expect(names).toContain('write_file');
      expect(names).toContain('move_file');
      expect(names).toContain('list_allowed_directories');
    });

    it('preserves multi-role annotations for move source', async () => {
      const mockLLM = createMockModel(cannedAnnotations);
      const result = await annotateTools('filesystem', sampleTools, mockLLM);

      const moveAnnotation = result.find((a) => a.toolName === 'move_file')!;
      expect(moveAnnotation.args.source).toEqual(['read-path', 'delete-path']);
      expect(moveAnnotation.args.destination).toEqual(['write-path']);
    });

    it('throws when LLM response is missing tools', async () => {
      const incomplete = {
        annotations: [cannedAnnotations.annotations[0]], // only read_file
      };
      const mockLLM = createMockModel(incomplete);

      await expect(annotateTools('filesystem', sampleTools, mockLLM)).rejects.toThrow(
        'Annotation incomplete: missing tools',
      );
    });

    it('returns empty array for empty tools list', async () => {
      const mockLLM = createMockModel({ annotations: [] });
      const result = await annotateTools('filesystem', [], mockLLM);
      expect(result).toEqual([]);
    });
  });

  describe('getRolesForServer', () => {
    const gitOnlyRoles = ['git-remote-url', 'branch-name', 'commit-message', 'write-history', 'delete-history'];
    const filesystemAndGitRoles = ['read-path', 'write-path', 'delete-path'];
    const fetchOnlyRoles = ['fetch-url'];
    const universalRoles = ['none'];

    it('excludes git-specific roles for filesystem server', () => {
      const roles = getRolesForServer('filesystem');
      const roleNames = roles.map(([name]) => name);
      for (const gitRole of gitOnlyRoles) {
        expect(roleNames).not.toContain(gitRole);
      }
    });

    it('includes git-specific roles for git server', () => {
      const roles = getRolesForServer('git');
      const roleNames = roles.map(([name]) => name);
      for (const gitRole of gitOnlyRoles) {
        expect(roleNames).toContain(gitRole);
      }
    });

    it('always includes universal roles', () => {
      for (const serverName of ['filesystem', 'git', 'fetch', 'unknown-server']) {
        const roles = getRolesForServer(serverName);
        const roleNames = roles.map(([name]) => name);
        for (const role of universalRoles) {
          expect(roleNames).toContain(role);
        }
      }
    });

    it('includes filesystem/git path roles for both servers', () => {
      for (const serverName of ['filesystem', 'git']) {
        const roles = getRolesForServer(serverName);
        const roleNames = roles.map(([name]) => name);
        for (const role of filesystemAndGitRoles) {
          expect(roleNames).toContain(role);
        }
      }
    });

    it('excludes filesystem path roles from fetch server', () => {
      const roles = getRolesForServer('fetch');
      const roleNames = roles.map(([name]) => name);
      for (const role of filesystemAndGitRoles) {
        expect(roleNames).not.toContain(role);
      }
    });

    it('includes fetch-url only for fetch server', () => {
      const fetchRoles = getRolesForServer('fetch');
      const fetchRoleNames = fetchRoles.map(([name]) => name);
      for (const role of fetchOnlyRoles) {
        expect(fetchRoleNames).toContain(role);
      }

      const fsRoles = getRolesForServer('filesystem');
      const fsRoleNames = fsRoles.map(([name]) => name);
      for (const role of fetchOnlyRoles) {
        expect(fsRoleNames).not.toContain(role);
      }
    });

    it('git server gets the most roles (path + git-specific + universal)', () => {
      const gitRoles = getRolesForServer('git');
      const fsRoles = getRolesForServer('filesystem');
      const fetchRoles = getRolesForServer('fetch');
      expect(gitRoles.length).toBeGreaterThan(fsRoles.length);
      expect(gitRoles.length).toBeGreaterThan(fetchRoles.length);
    });
  });

  describe('chunk', () => {
    it('returns empty array wrapped for empty input', () => {
      expect(chunk([], 5)).toEqual([[]]);
    });

    it('returns single chunk when array is smaller than batch size', () => {
      const items = [1, 2, 3];
      const result = chunk(items, 5);
      expect(result).toEqual([[1, 2, 3]]);
      // Should return the original array reference (no copy)
      expect(result[0]).toBe(items);
    });

    it('returns single chunk when array equals batch size', () => {
      const items = [1, 2, 3, 4, 5];
      const result = chunk(items, 5);
      expect(result).toEqual([[1, 2, 3, 4, 5]]);
      expect(result[0]).toBe(items);
    });

    it('splits into exact multiples', () => {
      const result = chunk([1, 2, 3, 4, 5, 6], 3);
      expect(result).toEqual([
        [1, 2, 3],
        [4, 5, 6],
      ]);
    });

    it('handles non-exact multiples with smaller last chunk', () => {
      const result = chunk([1, 2, 3, 4, 5, 6, 7], 3);
      expect(result).toEqual([[1, 2, 3], [4, 5, 6], [7]]);
    });

    it('throws on zero size', () => {
      expect(() => chunk([1, 2], 0)).toThrow(RangeError);
    });

    it('throws on negative size', () => {
      expect(() => chunk([1, 2], -1)).toThrow(RangeError);
    });
  });

  describe('ANNOTATION_BATCH_SIZE', () => {
    it('is 25', () => {
      expect(ANNOTATION_BATCH_SIZE).toBe(25);
    });
  });

  describe('annotateTools batching', () => {
    // Helper to generate N minimal tools for the filesystem server
    function makeTools(count: number): MCPToolSchema[] {
      return Array.from({ length: count }, (_, i) => ({
        name: `tool_${i}`,
        description: `Tool number ${i}`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'A path' },
          },
          required: ['path'],
        },
      }));
    }

    // Create a mock model that tracks call count and returns correct annotations
    // for whichever tools appear in the prompt
    function createBatchTrackingModel(tools: MCPToolSchema[]) {
      let callCount = 0;
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          callCount++;
          // Extract tool names from the prompt to determine which batch this is.
          // Use word-boundary regex to avoid "tool_2" matching inside "tool_25".
          const prompt = JSON.stringify(options.prompt);
          const batchTools = tools.filter((t) => {
            const pattern = new RegExp(`Tool: ${t.name}\\b`);
            return pattern.test(prompt);
          });

          const annotations = batchTools.map((t) => ({
            toolName: t.name,
            comment: `Annotation for ${t.name}`,

            args: { path: ['read-path'] },
          }));

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ annotations }) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 50, text: undefined, reasoning: undefined },
            },
            warnings: [],
            request: {},
            response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
          };
        },
      });

      return { model, getCallCount: () => callCount };
    }

    it('makes a single LLM call for tools within batch size', async () => {
      const tools = makeTools(10);
      const { model, getCallCount } = createBatchTrackingModel(tools);

      const result = await annotateTools('filesystem', tools, model);

      expect(getCallCount()).toBe(1);
      expect(result).toHaveLength(10);
      expect(result.every((a) => a.serverName === 'filesystem')).toBe(true);
    });

    it('makes two LLM calls for tools exceeding batch size', async () => {
      const tools = makeTools(30);
      const { model, getCallCount } = createBatchTrackingModel(tools);

      const result = await annotateTools('filesystem', tools, model);

      expect(getCallCount()).toBe(2); // 25 + 5
      expect(result).toHaveLength(30);
      // Verify all tool names are present
      const names = new Set(result.map((a) => a.toolName));
      for (const t of tools) {
        expect(names.has(t.name)).toBe(true);
      }
    });

    it('makes three LLM calls for 60 tools', async () => {
      const tools = makeTools(60);
      const { model, getCallCount } = createBatchTrackingModel(tools);

      const result = await annotateTools('filesystem', tools, model);

      expect(getCallCount()).toBe(3); // 25 + 25 + 10
      expect(result).toHaveLength(60);
    });

    it('suppresses batch progress messages for single batch', async () => {
      const tools = makeTools(10);
      const { model } = createBatchTrackingModel(tools);
      const messages: string[] = [];

      await annotateTools('filesystem', tools, model, (msg) => messages.push(msg));

      // No "Batch 1/1" messages
      expect(messages.every((m) => !m.includes('Batch'))).toBe(true);
    });

    it('emits batch progress messages for multiple batches', async () => {
      const tools = makeTools(30);
      const { model } = createBatchTrackingModel(tools);
      const messages: string[] = [];

      await annotateTools('filesystem', tools, model, (msg) => messages.push(msg));

      expect(messages.some((m) => m.includes('Batch 1/2'))).toBe(true);
      expect(messages.some((m) => m.includes('Batch 2/2'))).toBe(true);
    });

    it('propagates error from failed batch without partial results', async () => {
      const tools = makeTools(30);
      let callCount = 0;

      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          callCount++;
          if (callCount === 2) {
            throw new Error('LLM service unavailable');
          }

          // Return valid annotations for the first batch
          const prompt = JSON.stringify(options.prompt);
          const batchTools = tools.filter((t) => new RegExp(`Tool: ${t.name}\\b`).test(prompt));
          const annotations = batchTools.map((t) => ({
            toolName: t.name,
            comment: `Annotation for ${t.name}`,

            args: { path: ['read-path'] },
          }));

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ annotations }) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 50, text: undefined, reasoning: undefined },
            },
            warnings: [],
            request: {},
            response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
          };
        },
      });

      await expect(annotateTools('filesystem', tools, model)).rejects.toThrow('LLM service unavailable');
    });

    it('detects missing tools across batches', async () => {
      const tools = makeTools(30);
      let callCount = 0;

      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          callCount++;
          const prompt = JSON.stringify(options.prompt);
          const batchTools = tools.filter((t) => new RegExp(`Tool: ${t.name}\\b`).test(prompt));

          // Second batch drops some tools
          const annotations =
            callCount === 2
              ? batchTools.slice(0, 2).map((t) => ({
                  toolName: t.name,
                  comment: `Annotation for ${t.name}`,

                  args: { path: ['read-path'] },
                }))
              : batchTools.map((t) => ({
                  toolName: t.name,
                  comment: `Annotation for ${t.name}`,

                  args: { path: ['read-path'] },
                }));

          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ annotations }) }],
            finishReason: { unified: 'stop' as const, raw: 'stop' },
            usage: {
              inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 50, text: undefined, reasoning: undefined },
            },
            warnings: [],
            request: {},
            response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
          };
        },
      });

      await expect(annotateTools('filesystem', tools, model)).rejects.toThrow('Annotation incomplete: missing tools');
    });
  });

  describe('buildRoleDescriptions', () => {
    it('includes all roles when no server name is given', () => {
      const descriptions = buildRoleDescriptions();
      expect(descriptions).toContain('read-path');
      expect(descriptions).toContain('git-remote-url');
      expect(descriptions).toContain('branch-name');
    });

    it('excludes git-specific roles for filesystem server', () => {
      const descriptions = buildRoleDescriptions('filesystem');
      expect(descriptions).toContain('read-path');
      expect(descriptions).toContain('write-path');
      expect(descriptions).not.toContain('git-remote-url');
      expect(descriptions).not.toContain('branch-name');
      expect(descriptions).not.toContain('commit-message');
    });

    it('includes git-specific roles for git server', () => {
      const descriptions = buildRoleDescriptions('git');
      expect(descriptions).toContain('git-remote-url');
      expect(descriptions).toContain('branch-name');
      expect(descriptions).toContain('commit-message');
    });
  });
});
