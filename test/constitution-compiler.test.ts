import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  compileConstitution,
  validateCompiledRules,
  buildRepairPrompt,
  buildCompilerPrompt,
  type CompilerConfig,
} from '../src/pipeline/constitution-compiler.js';
import type { ToolAnnotation, CompiledRule, ExecutionResult, RepairContext } from '../src/pipeline/types.js';

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
    name: 'escalate-read-elsewhere',
    description: 'Reads outside sandbox need human approval',
    principle: 'Human oversight',
    if: { roles: ['read-path'] },
    then: 'escalate',
    reason: 'Read outside sandbox requires human approval',
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
  protectedPaths: ['/home/test/config/constitution.md', '/home/test/config/generated'],
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
        'escalate-read-elsewhere',
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

  describe('buildRepairPrompt', () => {
    const basePrompt = buildCompilerPrompt(sampleConstitution, sampleAnnotations, compilerConfig);

    const failedScenarios: ExecutionResult[] = [
      {
        scenario: {
          description: 'Deny delete outside sandbox',
          request: { serverName: 'filesystem', toolName: 'delete_file', arguments: { path: '/etc/passwd' } },
          expectedDecision: 'deny',
          reasoning: 'Deleting system files should be denied',
          source: 'generated',
        },
        actualDecision: 'allow',
        matchingRule: 'allow-side-effect-free-tools',
        pass: false,
      },
      {
        scenario: {
          description: 'Escalate read outside sandbox',
          request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/home/user/secret.txt' } },
          expectedDecision: 'escalate',
          reasoning: 'Reading outside sandbox needs approval',
          source: 'handwritten',
        },
        actualDecision: 'allow',
        matchingRule: 'allow-side-effect-free-tools',
        pass: false,
      },
    ];

    const repairContext: RepairContext = {
      previousRules: cannedRules,
      failedScenarios,
      judgeAnalysis: 'The allow-side-effect-free-tools rule is too broad and matches before more specific rules.',
      attemptNumber: 1,
    };

    it('includes previous rules in the repair prompt', () => {
      const prompt = buildRepairPrompt(basePrompt, repairContext);

      expect(prompt).toContain('allow-side-effect-free-tools');
      expect(prompt).toContain('deny-delete-operations');
      expect(prompt).toContain('allow-read-in-sandbox');
      expect(prompt).toContain('escalate-read-elsewhere');
    });

    it('includes failed scenarios in the repair prompt', () => {
      const prompt = buildRepairPrompt(basePrompt, repairContext);

      expect(prompt).toContain('Deny delete outside sandbox');
      expect(prompt).toContain('Escalate read outside sandbox');
      expect(prompt).toContain('Expected: deny');
      expect(prompt).toContain('Actual: allow');
    });

    it('includes judge analysis in the repair prompt', () => {
      const prompt = buildRepairPrompt(basePrompt, repairContext);

      expect(prompt).toContain('allow-side-effect-free-tools rule is too broad');
    });

    it('includes attempt number in the repair prompt', () => {
      const prompt = buildRepairPrompt(basePrompt, repairContext);

      expect(prompt).toContain('attempt 1');
    });

    it('starts with the base prompt', () => {
      const prompt = buildRepairPrompt(basePrompt, repairContext);

      expect(prompt.startsWith(basePrompt)).toBe(true);
    });

    it('includes repair instructions section', () => {
      const prompt = buildRepairPrompt(basePrompt, repairContext);

      expect(prompt).toContain('REPAIR INSTRUCTIONS');
      expect(prompt).toContain('Do NOT break scenarios that were already passing');
      expect(prompt).toContain('complete, corrected rule set');
    });
  });

  describe('compileConstitution with repair context', () => {
    it('uses repair prompt when repairContext is provided', async () => {
      let capturedPrompt = '';
      const mockLLM = new MockLanguageModelV3({
        doGenerate: async (options) => {
          // Capture the prompt sent to the LLM
          const msgs = options.prompt;
          for (const msg of msgs) {
            if (msg.role === 'user') {
              for (const part of msg.content) {
                if (part.type === 'text') {
                  capturedPrompt = part.text;
                }
              }
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ rules: cannedRules }) }],
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

      const repairContext: RepairContext = {
        previousRules: cannedRules,
        failedScenarios: [{
          scenario: {
            description: 'Test failure',
            request: { serverName: 'filesystem', toolName: 'read_file', arguments: { path: '/etc/passwd' } },
            expectedDecision: 'deny',
            reasoning: 'Should be denied',
            source: 'generated',
          },
          actualDecision: 'allow',
          matchingRule: 'allow-side-effect-free-tools',
          pass: false,
        }],
        judgeAnalysis: 'Rules need reordering.',
        attemptNumber: 1,
      };

      await compileConstitution(
        sampleConstitution,
        sampleAnnotations,
        compilerConfig,
        mockLLM,
        repairContext,
      );

      expect(capturedPrompt).toContain('REPAIR INSTRUCTIONS');
      expect(capturedPrompt).toContain('Rules need reordering.');
      expect(capturedPrompt).toContain('Test failure');
    });

    it('does not include repair section without repairContext', async () => {
      let capturedPrompt = '';
      const mockLLM = new MockLanguageModelV3({
        doGenerate: async (options) => {
          const msgs = options.prompt;
          for (const msg of msgs) {
            if (msg.role === 'user') {
              for (const part of msg.content) {
                if (part.type === 'text') {
                  capturedPrompt = part.text;
                }
              }
            }
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ rules: cannedRules }) }],
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

      await compileConstitution(
        sampleConstitution,
        sampleAnnotations,
        compilerConfig,
        mockLLM,
      );

      expect(capturedPrompt).not.toContain('REPAIR INSTRUCTIONS');
    });
  });
});
