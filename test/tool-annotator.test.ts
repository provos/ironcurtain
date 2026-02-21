import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  annotateTools,
  validateAnnotationsHeuristic,
  buildRoleDescriptions,
  type MCPToolSchema,
} from '../src/pipeline/tool-annotator.js';
import type { ToolAnnotation } from '../src/pipeline/types.js';
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
      sideEffects: true,
      args: { path: ['read-path'] },
    },
    {
      toolName: 'write_file',
      comment: 'Creates or overwrites a file with new content',
      sideEffects: true,
      args: { path: ['write-path'], content: ['none'] },
    },
    {
      toolName: 'move_file',
      comment: 'Moves a file from source to destination, deleting the source',
      sideEffects: true,
      args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
    },
    {
      toolName: 'list_allowed_directories',
      comment: 'Lists directories the server is allowed to access',
      sideEffects: false,
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

  describe('validateAnnotationsHeuristic', () => {
    const fullAnnotations: ToolAnnotation[] = cannedAnnotations.annotations.map((a) => ({
      ...a,
      serverName: 'filesystem',
    }));

    it('passes when all path arguments are annotated', () => {
      const result = validateAnnotationsHeuristic(sampleTools, fullAnnotations);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });

    it('warns when a path-like argument has no path role', () => {
      const badAnnotations: ToolAnnotation[] = fullAnnotations.map((a) => {
        if (a.toolName === 'read_file') {
          return { ...a, args: { path: ['none'] } };
        }
        return a;
      });

      const result = validateAnnotationsHeuristic(sampleTools, badAnnotations);
      expect(result.valid).toBe(false);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('read_file');
      expect(result.warnings[0]).toContain('path');
    });

    it('warns when tool has no annotation at all', () => {
      const missingAnnotations = fullAnnotations.filter((a) => a.toolName !== 'write_file');
      const result = validateAnnotationsHeuristic(sampleTools, missingAnnotations);
      expect(result.valid).toBe(false);
      expect(result.warnings.some((w) => w.includes('write_file'))).toBe(true);
    });

    it('detects path-like defaults in schema', () => {
      const toolWithDefaults: MCPToolSchema[] = [
        {
          name: 'custom_tool',
          inputSchema: {
            type: 'object',
            properties: {
              target: {
                type: 'string',
                default: '/home/user/file.txt',
              },
            },
          },
        },
      ];

      const noPathRoleAnnotations: ToolAnnotation[] = [
        {
          toolName: 'custom_tool',
          serverName: 'test',
          comment: 'A custom tool with path-like defaults',
          sideEffects: false,
          args: { target: ['none'] },
        },
      ];

      const result = validateAnnotationsHeuristic(toolWithDefaults, noPathRoleAnnotations);
      expect(result.valid).toBe(false);
      expect(result.warnings.some((w) => w.includes('path-like defaults'))).toBe(true);
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
