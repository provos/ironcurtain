import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

/** Env var names that need save/restore between tests. */
const ENV_VARS_TO_ISOLATE = [
  'IRONCURTAIN_HOME',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
] as const;

// Mock @clack/prompts before importing anything that uses it
const mockSelect = vi.fn();
const mockConfirm = vi.fn();
const mockText = vi.fn();
const mockIntro = vi.fn();
const mockOutro = vi.fn();
const mockNote = vi.fn();
const mockCancel = vi.fn();
const mockIsCancel = vi.fn().mockReturnValue(false);
const mockLogInfo = vi.fn();
const mockLogSuccess = vi.fn();
const mockLogError = vi.fn();

vi.mock('@clack/prompts', () => ({
  select: (...args: unknown[]) => mockSelect(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  text: (...args: unknown[]) => mockText(...args),
  intro: (...args: unknown[]) => mockIntro(...args),
  outro: (...args: unknown[]) => mockOutro(...args),
  note: (...args: unknown[]) => mockNote(...args),
  cancel: (...args: unknown[]) => mockCancel(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
  log: {
    info: (...args: unknown[]) => mockLogInfo(...args),
    success: (...args: unknown[]) => mockLogSuccess(...args),
    error: (...args: unknown[]) => mockLogError(...args),
    warn: vi.fn(),
  },
}));

// Now import the modules under test
import {
  buildSystemPrompt,
  buildUserMessage,
  formatAnnotationsForPrompt,
  computeLineDiff,
  formatDiff,
  applyChanges,
  writeConstitution,
  revertConstitution,
  seedBaseConstitution,
  CustomizerResponseSchema,
  type DiffLine,
} from '../src/pipeline/constitution-customizer.js';
import type { ToolAnnotation } from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Environment Isolation Helper
// ---------------------------------------------------------------------------

/**
 * Sets up and tears down a temporary IRONCURTAIN_HOME directory,
 * saving and restoring env vars between tests.
 */
function useIsolatedHome(): { getHome: () => string } {
  let testHome = '';
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    testHome = mkdtempSync(resolve(tmpdir(), 'ironcurtain-customizer-'));
    for (const key of ENV_VARS_TO_ISOLATE) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.IRONCURTAIN_HOME = testHome;
  });

  afterEach(() => {
    for (const key of ENV_VARS_TO_ISOLATE) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
    rmSync(testHome, { recursive: true, force: true });
  });

  return { getHome: () => testHome };
}

// ---------------------------------------------------------------------------
// Test Fixtures
// ---------------------------------------------------------------------------

const sampleAnnotations: ToolAnnotation[] = [
  {
    toolName: 'read_file',
    serverName: 'filesystem',
    comment: 'Reads the contents of a file',
    sideEffects: false,
    args: { path: ['read-path'] },
  },
  {
    toolName: 'write_file',
    serverName: 'filesystem',
    comment: 'Writes content to a file',
    sideEffects: true,
    args: { path: ['write-path'], content: ['none'] },
  },
  {
    toolName: 'git_status',
    serverName: 'git',
    comment: 'Shows the current git status',
    sideEffects: false,
    args: { path: ['read-path'] },
  },
];

const sampleBaseConstitution = `# Guiding Principles
1. Least privilege
2. No destruction
3. Human oversight`;

// ---------------------------------------------------------------------------
// Prompt Construction Tests
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
  it('includes base constitution in output', () => {
    const result = buildSystemPrompt(sampleBaseConstitution, sampleAnnotations);
    expect(result).toContain(sampleBaseConstitution);
  });

  it('includes tool annotations in output', () => {
    const result = buildSystemPrompt(sampleBaseConstitution, sampleAnnotations);
    expect(result).toContain('filesystem/read_file');
    expect(result).toContain('filesystem/write_file');
    expect(result).toContain('git/git_status');
  });

  it('includes purpose-driven reasoning instructions', () => {
    const result = buildSystemPrompt(sampleBaseConstitution, sampleAnnotations);
    expect(result).toContain('Which tools does this task require');
    expect(result).toContain('principle of least privilege');
  });

  it('includes response format instructions', () => {
    const result = buildSystemPrompt(sampleBaseConstitution, sampleAnnotations);
    expect(result).toContain('"changes"');
    expect(result).toContain('"question"');
    expect(result).toContain('addRules');
  });

  it('includes policy statement rules', () => {
    const result = buildSystemPrompt(sampleBaseConstitution, sampleAnnotations);
    expect(result).toContain('clear, specific policy statement');
    expect(result).toContain('principle of least privilege');
  });
});

describe('buildUserMessage', () => {
  it('includes current user constitution when present', () => {
    const result = buildUserMessage('Allow reading ~/docs', 'add git access');
    expect(result).toContain('## Current User Customizations');
    expect(result).toContain('Allow reading ~/docs');
    expect(result).toContain('"add git access"');
  });

  it('handles missing user constitution', () => {
    const result = buildUserMessage(undefined, 'fix bugs in my code');
    expect(result).toContain('## No existing user customizations.');
    expect(result).toContain('"fix bugs in my code"');
    expect(result).not.toContain('## Current User Customizations');
  });

  it('wraps user request in quotes', () => {
    const result = buildUserMessage(undefined, 'some request');
    expect(result).toContain('"some request"');
  });
});

// ---------------------------------------------------------------------------
// formatAnnotationsForPrompt Tests
// ---------------------------------------------------------------------------

describe('formatAnnotationsForPrompt', () => {
  it('formats tool names with server prefix', () => {
    const result = formatAnnotationsForPrompt(sampleAnnotations);
    expect(result).toContain('**filesystem/read_file**');
    expect(result).toContain('**filesystem/write_file**');
    expect(result).toContain('**git/git_status**');
  });

  it('includes tool descriptions', () => {
    const result = formatAnnotationsForPrompt(sampleAnnotations);
    expect(result).toContain('Reads the contents of a file');
    expect(result).toContain('Writes content to a file');
  });

  it('includes non-none argument roles', () => {
    const result = formatAnnotationsForPrompt(sampleAnnotations);
    expect(result).toContain('path (read-path)');
    expect(result).toContain('path (write-path)');
  });

  it('omits none-only arguments', () => {
    const result = formatAnnotationsForPrompt(sampleAnnotations);
    // write_file has content: ['none'] which should be omitted
    expect(result).not.toContain('content (none)');
  });

  it('handles empty annotations array', () => {
    const result = formatAnnotationsForPrompt([]);
    expect(result).toBe('');
  });

  it('handles annotations with all-none args', () => {
    const ann: ToolAnnotation[] = [
      {
        toolName: 'ping',
        serverName: 'util',
        comment: 'Pings a service',
        sideEffects: false,
        args: { target: ['none'] },
      },
    ];
    const result = formatAnnotationsForPrompt(ann);
    expect(result).toContain('**util/ping**');
    // Should not include Args section for all-none
    expect(result).not.toContain('Args:');
  });

  it('truncates to summary-only when output exceeds size limit', () => {
    // Generate enough annotations to exceed the 8KB limit
    const largeAnnotations: ToolAnnotation[] = Array.from({ length: 200 }, (_, i) => ({
      toolName: `tool_with_a_long_name_${i}`,
      serverName: `server_${i}`,
      comment: `This is a detailed description of tool number ${i} that takes up space`,
      sideEffects: false,
      args: {
        longArgName1: ['read-path'],
        longArgName2: ['write-path'],
        longArgName3: ['domain'],
      },
    }));

    const result = formatAnnotationsForPrompt(largeAnnotations);

    // Summary-only mode omits argument details
    expect(result).not.toContain('Args:');
    // But still includes tool names and descriptions
    expect(result).toContain('**server_0/tool_with_a_long_name_0**');
    expect(result).toContain('detailed description');
  });
});

// ---------------------------------------------------------------------------
// Diff Generation Tests
// ---------------------------------------------------------------------------

describe('computeLineDiff', () => {
  it('detects added lines', () => {
    const diff = computeLineDiff('line1', 'line1\nline2');
    expect(diff).toEqual([
      { type: 'unchanged', text: 'line1' },
      { type: 'added', text: 'line2' },
    ]);
  });

  it('detects removed lines', () => {
    const diff = computeLineDiff('line1\nline2', 'line1');
    expect(diff).toEqual([
      { type: 'unchanged', text: 'line1' },
      { type: 'removed', text: 'line2' },
    ]);
  });

  it('detects unchanged lines', () => {
    const diff = computeLineDiff('same\ncontent', 'same\ncontent');
    expect(diff).toEqual([
      { type: 'unchanged', text: 'same' },
      { type: 'unchanged', text: 'content' },
    ]);
  });

  it('handles empty old text (all additions)', () => {
    const diff = computeLineDiff('', 'new line 1\nnew line 2');
    expect(diff).toEqual([
      { type: 'added', text: 'new line 1' },
      { type: 'added', text: 'new line 2' },
    ]);
  });

  it('handles empty new text (all removals)', () => {
    const diff = computeLineDiff('old line 1\nold line 2', '');
    expect(diff).toEqual([
      { type: 'removed', text: 'old line 1' },
      { type: 'removed', text: 'old line 2' },
    ]);
  });

  it('handles both texts empty', () => {
    const diff = computeLineDiff('', '');
    expect(diff).toEqual([]);
  });

  it('handles identical texts', () => {
    const text = 'line1\nline2\nline3';
    const diff = computeLineDiff(text, text);
    expect(diff.every((d) => d.type === 'unchanged')).toBe(true);
    expect(diff).toHaveLength(3);
  });

  it('detects replacement (remove + add)', () => {
    const diff = computeLineDiff('old line', 'new line');
    const removed = diff.filter((d) => d.type === 'removed');
    const added = diff.filter((d) => d.type === 'added');
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].text).toBe('old line');
    expect(added[0].text).toBe('new line');
  });

  it('handles mixed changes correctly', () => {
    const old = 'keep\nremove this\nalso keep';
    const nw = 'keep\nadd this\nalso keep';
    const diff = computeLineDiff(old, nw);

    const unchanged = diff.filter((d) => d.type === 'unchanged');
    const removed = diff.filter((d) => d.type === 'removed');
    const added = diff.filter((d) => d.type === 'added');

    expect(unchanged).toHaveLength(2);
    expect(removed).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect(removed[0].text).toBe('remove this');
    expect(added[0].text).toBe('add this');
  });
});

describe('formatDiff', () => {
  it('prefixes added lines with +', () => {
    const diff: DiffLine[] = [{ type: 'added', text: 'new line' }];
    const result = formatDiff(diff);
    // chalk.green wraps the text, but the + prefix should be present
    expect(result).toContain('+ new line');
  });

  it('prefixes removed lines with -', () => {
    const diff: DiffLine[] = [{ type: 'removed', text: 'old line' }];
    const result = formatDiff(diff);
    expect(result).toContain('- old line');
  });

  it('indents unchanged lines with spaces', () => {
    const diff: DiffLine[] = [{ type: 'unchanged', text: 'same line' }];
    const result = formatDiff(diff);
    expect(result).toContain('  same line');
  });

  it('handles empty diff', () => {
    const result = formatDiff([]);
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Schema Validation Tests
// ---------------------------------------------------------------------------

describe('CustomizerResponseSchema', () => {
  it('accepts valid changes response', () => {
    const input = {
      type: 'changes' as const,
      addRules: ['The agent may fetch web content from finance news sites'],
      summary: 'Added finance news fetching',
    };
    const result = CustomizerResponseSchema.parse(input);
    expect(result.type).toBe('changes');
    expect(result.addRules).toHaveLength(1);
  });

  it('accepts valid question response', () => {
    const input = {
      type: 'question' as const,
      question: 'Where is your source code located?',
    };
    const result = CustomizerResponseSchema.parse(input);
    expect(result.type).toBe('question');
  });

  it('rejects invalid type', () => {
    const input = { type: 'invalid', text: 'something' };
    expect(() => CustomizerResponseSchema.parse(input)).toThrow();
  });

  it('accepts changes without optional fields', () => {
    const input = { type: 'changes' as const };
    const result = CustomizerResponseSchema.parse(input);
    expect(result.type).toBe('changes');
    expect(result.addRules).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// applyChanges Tests
// ---------------------------------------------------------------------------

describe('applyChanges', () => {
  const base = `## Concrete Guidance

 - The agent is allowed to read content in Downloads
 - The agent may fetch web content from popular news sites`;

  it('appends new rules', () => {
    const result = applyChanges(base, ['The agent may fetch from finance sites'], []);
    expect(result).toContain(' - The agent may fetch from finance sites');
    expect(result).toContain(' - The agent is allowed to read content in Downloads');
  });

  it('removes matching rules', () => {
    const result = applyChanges(base, [], [' - The agent may fetch web content from popular news sites']);
    expect(result).not.toContain('popular news sites');
    expect(result).toContain('Downloads');
  });

  it('removes and adds in one operation', () => {
    const result = applyChanges(
      base,
      ['The agent may fetch from finance and news sites'],
      [' - The agent may fetch web content from popular news sites'],
    );
    expect(result).not.toContain('popular news sites');
    expect(result).toContain('finance and news sites');
  });

  it('handles empty add and remove', () => {
    const result = applyChanges(base, [], []);
    expect(result.trim()).toBe(base.trim());
  });

  it('trims whitespace when matching removals', () => {
    const result = applyChanges(base, [], ['The agent may fetch web content from popular news sites']);
    expect(result).not.toContain('popular news sites');
  });
});

// ---------------------------------------------------------------------------
// Backup / Revert Tests
// ---------------------------------------------------------------------------

describe('writeConstitution and revertConstitution', () => {
  const { getHome } = useIsolatedHome();

  it('writes constitution to user path', () => {
    const content = 'Allow reading ~/docs';
    const path = writeConstitution(content);
    expect(readFileSync(path, 'utf-8')).toBe(content);
  });

  it('creates .bak of previous version when file exists', () => {
    const userPath = resolve(getHome(), 'constitution-user.md');
    writeFileSync(userPath, 'old content');

    writeConstitution('new content');

    expect(readFileSync(`${userPath}.bak`, 'utf-8')).toBe('old content');
    expect(readFileSync(userPath, 'utf-8')).toBe('new content');
  });

  it('skips backup when no existing file', () => {
    writeConstitution('first content');
    const bakPath = resolve(getHome(), 'constitution-user.md.bak');
    expect(existsSync(bakPath)).toBe(false);
  });

  it('revert restores from .bak file', () => {
    const userPath = resolve(getHome(), 'constitution-user.md');
    writeFileSync(userPath, 'old content');
    writeConstitution('new content');

    revertConstitution();

    expect(readFileSync(userPath, 'utf-8')).toBe('old content');
    // .bak should be gone (renamed, not copied)
    expect(existsSync(`${userPath}.bak`)).toBe(false);
  });

  it('revert throws when no .bak file exists', () => {
    const userPath = resolve(getHome(), 'constitution-user.md');
    writeFileSync(userPath, 'content');

    expect(() => revertConstitution()).toThrow('No backup file found');
  });
});

// ---------------------------------------------------------------------------
// Base Constitution Seeding Tests
// ---------------------------------------------------------------------------

describe('seedBaseConstitution', () => {
  const { getHome } = useIsolatedHome();

  it('copies base to user path when no user constitution exists', () => {
    // The base constitution is a real file shipped with the package
    const result = seedBaseConstitution();

    const userPath = resolve(getHome(), 'constitution-user.md');
    expect(existsSync(userPath)).toBe(true);
    expect(result).toBeTruthy();
    expect(result).toContain('Concrete Guidance');
  });

  it('does not overwrite existing user constitution', () => {
    const userPath = resolve(getHome(), 'constitution-user.md');
    writeFileSync(userPath, 'my custom rules');

    const result = seedBaseConstitution();

    expect(result).toBe('my custom rules');
    expect(readFileSync(userPath, 'utf-8')).toBe('my custom rules');
  });

  it('returns content of existing user constitution', () => {
    const userPath = resolve(getHome(), 'constitution-user.md');
    writeFileSync(userPath, 'existing content');

    const result = seedBaseConstitution();
    expect(result).toBe('existing content');
  });
});
