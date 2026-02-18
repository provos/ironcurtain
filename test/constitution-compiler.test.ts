import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  compileConstitution,
  validateCompiledRules,
  type CompilerConfig,
} from '../src/pipeline/constitution-compiler.js';
import type { ToolAnnotation, CompiledRule } from '../src/pipeline/types.js';

const sampleAnnotations: ToolAnnotation[] = [
  {
    toolName: 'read_file', serverName: 'filesystem',
    comment: 'Reads the complete contents of a file from disk', sideEffects: true,
    args: { path: ['read-path'] },
  },
  {
    toolName: 'write_file', serverName: 'filesystem',
    comment: 'Creates or overwrites a file with new content', sideEffects: true,
    args: { path: ['write-path'] },
  },
  {
    toolName: 'delete_file', serverName: 'filesystem',
    comment: 'Permanently deletes a file from disk', sideEffects: true,
    args: { path: ['delete-path'] },
  },
  {
    toolName: 'move_file', serverName: 'filesystem',
    comment: 'Moves a file from source to destination, deleting the source', sideEffects: true,
    args: { source: ['read-path', 'delete-path'], destination: ['write-path'] },
  },
  {
    toolName: 'list_allowed_directories', serverName: 'filesystem',
    comment: 'Lists directories the server is allowed to access', sideEffects: false,
    args: {},
  },
];

const cannedRules: CompiledRule[] = [
  {
    name: 'allow-side-effect-free-tools',
    description: 'Pure query tools can always be called',
    principle: 'Least privilege',
    if: { sideEffects: false },
    then: 'allow',
    reason: 'Tool has no side effects',
  },
  {
    name: 'deny-delete-operations',
    description: 'Block all tools that have delete-path arguments',
    principle: 'No destruction',
    if: { roles: ['delete-path'] },
    then: 'deny',
    reason: 'Delete operations are never permitted',
  },
  {
    name: 'allow-read-in-sandbox',
    description: 'Allow reading files within the sandbox',
    principle: 'Containment',
    if: {
      paths: { roles: ['read-path'], within: '/tmp/ironcurtain-sandbox' },
    },
    then: 'allow',
    reason: 'Read within sandbox directory',
  },
  {
    name: 'deny-read-elsewhere',
    description: 'Deny reading files outside permitted directories',
    principle: 'Containment',
    if: { roles: ['read-path'] },
    then: 'deny',
    reason: 'Read outside permitted directories',
  },
];

const sampleConstitution = `# Constitution
1. Least privilege
2. No destruction
3. Containment to sandbox
4. Transparency
5. Human oversight
6. Self-protection`;

const compilerConfig: CompilerConfig = {
  sandboxDirectory: '/tmp/ironcurtain-sandbox',
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

describe('Constitution Compiler', () => {
  describe('compileConstitution', () => {
    it('returns compiled rules from LLM response', async () => {
      const mockLLM = createMockModel({ rules: cannedRules });

      const result = await compileConstitution(
        sampleConstitution,
        sampleAnnotations,
        compilerConfig,
        mockLLM,
      );

      expect(result).toHaveLength(4);
      expect(result[0].name).toBe('allow-side-effect-free-tools');
      expect(result[1].name).toBe('deny-delete-operations');
    });

    it('preserves rule order from LLM response', async () => {
      const mockLLM = createMockModel({ rules: cannedRules });

      const result = await compileConstitution(
        sampleConstitution,
        sampleAnnotations,
        compilerConfig,
        mockLLM,
      );

      const names = result.map(r => r.name);
      expect(names).toEqual([
        'allow-side-effect-free-tools',
        'deny-delete-operations',
        'allow-read-in-sandbox',
        'deny-read-elsewhere',
      ]);
    });

    it('each rule has principle linking back to constitution', async () => {
      const mockLLM = createMockModel({ rules: cannedRules });

      const result = await compileConstitution(
        sampleConstitution,
        sampleAnnotations,
        compilerConfig,
        mockLLM,
      );

      for (const rule of result) {
        expect(rule.principle).toBeTruthy();
      }
    });
  });

  describe('validateCompiledRules', () => {
    it('passes for valid rules', () => {
      const result = validateCompiledRules(cannedRules);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('catches invalid roles in paths', () => {
      const badRules: CompiledRule[] = [{
        ...cannedRules[2],
        if: {
          paths: { roles: ['invalid-role' as never], within: '/tmp/sandbox' },
        },
      }];

      const result = validateCompiledRules(badRules);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid role'))).toBe(true);
    });

    it('catches invalid roles in top-level roles', () => {
      const badRules: CompiledRule[] = [{
        ...cannedRules[1],
        if: { roles: ['invalid-role' as never] },
      }];

      const result = validateCompiledRules(badRules);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('invalid role'))).toBe(true);
    });

    it('catches relative paths in within', () => {
      const badRules: CompiledRule[] = [{
        ...cannedRules[2],
        if: {
          paths: { roles: ['read-path'], within: './relative/path' },
        },
      }];

      const result = validateCompiledRules(badRules);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('absolute path'))).toBe(true);
    });

    it('catches structural invariant concepts in compiled rules', () => {
      const badRules: CompiledRule[] = [{
        name: 'deny-protected-paths',
        description: 'Deny access to protected path files',
        principle: 'Self-protection',
        if: { roles: ['read-path'] },
        then: 'deny',
        reason: 'Protected paths',
      }];

      const result = validateCompiledRules(badRules);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('structural invariant'))).toBe(true);
    });
  });
});
