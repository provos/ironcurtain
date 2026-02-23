/**
 * Tests for dynamic lists: types, compiler emission, validation,
 * list type registry, list resolver, policy engine expansion,
 * ListCondition evaluation, and MCP-backed resolution.
 */

import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import {
  compileConstitution,
  validateCompiledRules,
  type CompilerConfig,
} from '../src/pipeline/constitution-compiler.js';
import { LIST_TYPE_REGISTRY, getListMatcher } from '../src/pipeline/dynamic-list-types.js';
import {
  resolveList,
  resolveAllLists,
  type McpServerConnection,
  type ListResolverConfig,
} from '../src/pipeline/list-resolver.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type {
  CompiledPolicyFile,
  CompiledRule,
  DynamicListsFile,
  ListDefinition,
  ResolvedList,
  ToolAnnotation,
  ToolAnnotationsFile,
} from '../src/pipeline/types.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const sampleAnnotations: ToolAnnotation[] = [
  {
    toolName: 'fetch',
    serverName: 'fetch',
    comment: 'Fetches a URL via HTTP',
    sideEffects: false,
    args: { url: ['fetch-url'] },
  },
  {
    toolName: 'read_file',
    serverName: 'filesystem',
    comment: 'Reads a file',
    sideEffects: false,
    args: { path: ['read-path'] },
  },
];

const compilerConfig: CompilerConfig = {
  protectedPaths: ['/etc/ironcurtain'],
};

const MOCK_GENERATE_RESULT = {
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage: {
    inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 50, text: undefined, reasoning: undefined },
  },
  warnings: [],
  request: {},
  response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
};

function createMockModel(response: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'text' as const, text: JSON.stringify(response) }],
      ...MOCK_GENERATE_RESULT,
    }),
  });
}

/**
 * Creates a mock model that counts calls and returns dynamic values.
 * The valueFactory receives the 1-based call index for dynamic responses.
 */
function createCountingModel(valueFactory: (callIndex: number) => string[] = () => ['NEW']): {
  model: MockLanguageModelV3;
  getCallCount: () => number;
} {
  let callCount = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      callCount++;
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ values: valueFactory(callCount) }) }],
        ...MOCK_GENERATE_RESULT,
      };
    },
  });
  return { model, getCallCount: () => callCount };
}

function createPromptCapturingModel(response: unknown): {
  model: MockLanguageModelV3;
  getPrompt: () => string;
  getSystemPrompt: () => string;
} {
  let capturedPrompt = '';
  let capturedSystem = '';
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      for (const msg of options.prompt) {
        if (msg.role === 'system') {
          capturedSystem = typeof msg.content === 'string' ? msg.content : '';
        }
        if (msg.role === 'user') {
          for (const part of msg.content) {
            if (part.type === 'text') capturedPrompt = part.text;
          }
        }
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(response) }],
        ...MOCK_GENERATE_RESULT,
      };
    },
  });
  return { model, getPrompt: () => capturedPrompt, getSystemPrompt: () => capturedSystem };
}

const fetchAnnotation: ToolAnnotation = {
  toolName: 'fetch',
  serverName: 'fetch',
  comment: 'Fetches URL',
  sideEffects: false,
  args: { url: ['fetch-url'] },
};

// Reusable list definitions for tests
const newsListDef: ListDefinition = {
  name: 'major-news-sites',
  type: 'domains',
  principle: 'collect news from major news sites',
  generationPrompt: 'List 20 major English-language news sites.',
  requiresMcp: false,
};

const contactsListDef: ListDefinition = {
  name: 'my-contacts',
  type: 'emails',
  principle: 'send email to my contacts',
  generationPrompt: 'Query the contacts database for all email addresses.',
  requiresMcp: true,
  mcpServerHint: 'contacts',
};

const stocksListDef: ListDefinition = {
  name: 'tech-stock-tickers',
  type: 'identifiers',
  principle: 'get financial data for major tech stocks',
  generationPrompt: 'List 20 major tech stock ticker symbols.',
  requiresMcp: false,
};

const plainReadRule: CompiledRule = {
  name: 'allow-reads',
  description: 'Allow reads',
  principle: 'open',
  if: { sideEffects: false },
  then: 'allow',
  reason: 'Safe',
};

// Reusable rules that reference lists
function makeRuleWithDomainList(listName: string): CompiledRule {
  return {
    name: 'allow-news',
    description: 'Allow fetching from news sites',
    principle: 'collect news',
    if: {
      domains: {
        roles: ['fetch-url'],
        allowed: [`@${listName}`],
      },
    },
    then: 'allow',
    reason: 'News sites are allowed',
  };
}

function makeRuleWithListCondition(listName: string, matchType: 'domains' | 'emails' | 'identifiers'): CompiledRule {
  return {
    name: 'allow-contacts',
    description: 'Allow sending to contacts',
    principle: 'send to contacts',
    if: {
      lists: [
        {
          roles: ['fetch-url'],
          allowed: [`@${listName}`],
          matchType,
        },
      ],
    },
    then: 'allow',
    reason: 'Known contacts are allowed',
  };
}

// ---------------------------------------------------------------------------
// Validation tests
// ---------------------------------------------------------------------------

describe('Dynamic Lists Validation', () => {
  describe('orphaned @list-name references', () => {
    it('errors when @list-name in domains.allowed has no matching definition', () => {
      const rules = [makeRuleWithDomainList('nonexistent-list')];
      const result = validateCompiledRules(rules, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('@nonexistent-list');
      expect(result.errors[0]).toContain('no matching list definition');
    });

    it('errors when @list-name in lists[].allowed has no matching definition', () => {
      const rules = [makeRuleWithListCondition('nonexistent-list', 'emails')];
      const result = validateCompiledRules(rules, []);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain('@nonexistent-list');
      expect(result.errors[0]).toContain('no matching list definition');
    });
  });

  describe('orphaned list definitions', () => {
    it('warns when a list definition is not referenced by any rule', () => {
      const rules: CompiledRule[] = [
        {
          name: 'allow-all-reads',
          description: 'Allow reads',
          principle: 'open read',
          if: { sideEffects: false },
          then: 'allow',
          reason: 'No side effects',
        },
      ];

      const result = validateCompiledRules(rules, [newsListDef]);

      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain('major-news-sites');
      expect(result.warnings[0]).toContain('not referenced');
    });
  });

  describe('domain-type list in ListCondition', () => {
    it('errors when a domains-type list appears in lists[] instead of domains.allowed', () => {
      const rules = [makeRuleWithListCondition('major-news-sites', 'domains')];
      const result = validateCompiledRules(rules, [newsListDef]);

      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes('@major-news-sites') && e.includes('"domains" list') && e.includes('domains.allowed'),
        ),
      ).toBe(true);
    });
  });

  describe('matchType mismatch with list type', () => {
    it('errors when lists[].matchType does not match the list definition type', () => {
      // contacts list is type: 'emails', but rule says matchType: 'identifiers'
      const rules = [makeRuleWithListCondition('my-contacts', 'identifiers')];
      const result = validateCompiledRules(rules, [contactsListDef]);

      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.includes('matchType "identifiers"') && e.includes('@my-contacts') && e.includes('"emails"'),
        ),
      ).toBe(true);
    });
  });

  describe('non-domain list in domains.allowed', () => {
    it('errors when an emails-type list is referenced in domains.allowed', () => {
      const rules = [makeRuleWithDomainList('my-contacts')];
      const result = validateCompiledRules(rules, [contactsListDef]);

      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) =>
            e.includes('@my-contacts') &&
            e.includes('"emails" list') &&
            e.includes('only "domains" lists belong in domains.allowed'),
        ),
      ).toBe(true);
    });
  });

  describe('valid list references', () => {
    it('passes when domain list is correctly referenced in domains.allowed', () => {
      const rules = [makeRuleWithDomainList('major-news-sites')];
      const result = validateCompiledRules(rules, [newsListDef]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('passes when email list is correctly referenced in lists[] with matching matchType', () => {
      const rules = [makeRuleWithListCondition('my-contacts', 'emails')];
      const result = validateCompiledRules(rules, [contactsListDef]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('passes when identifier list is correctly referenced in lists[] with matching matchType', () => {
      const rules = [makeRuleWithListCondition('tech-stock-tickers', 'identifiers')];
      const result = validateCompiledRules(rules, [stocksListDef]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });

    it('passes with mixed concrete values and @list-name references', () => {
      const rules: CompiledRule[] = [
        {
          name: 'allow-news-and-specific',
          description: 'Allow news sites and a specific domain',
          principle: 'news access',
          if: {
            domains: {
              roles: ['fetch-url'],
              allowed: ['example.com', '@major-news-sites'],
            },
          },
          then: 'allow',
          reason: 'Allowed domains',
        },
      ];

      const result = validateCompiledRules(rules, [newsListDef]);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('passes with no list definitions and no @list-name references', () => {
      const result = validateCompiledRules([plainReadRule], []);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Compiler output tests
// ---------------------------------------------------------------------------

describe('Dynamic Lists Compiler Output', () => {
  it('includes listDefinitions when LLM emits them', async () => {
    const rulesWithLists = [makeRuleWithDomainList('major-news-sites')];

    const mockLLM = createMockModel({
      rules: rulesWithLists,
      listDefinitions: [newsListDef],
    });

    const result = await compileConstitution(
      'Collect news from major news sites.',
      sampleAnnotations,
      compilerConfig,
      mockLLM,
    );

    expect(result.rules).toHaveLength(1);
    expect(result.listDefinitions).toHaveLength(1);
    expect(result.listDefinitions[0].name).toBe('major-news-sites');
    expect(result.listDefinitions[0].type).toBe('domains');
    expect(result.listDefinitions[0].requiresMcp).toBe(false);
  });

  it('returns empty listDefinitions when LLM emits none', async () => {
    const mockLLM = createMockModel({ rules: [plainReadRule] });

    const result = await compileConstitution('Allow all read operations.', sampleAnnotations, compilerConfig, mockLLM);

    expect(result.rules).toHaveLength(1);
    expect(result.listDefinitions).toEqual([]);
  });

  it('returns empty listDefinitions when LLM explicitly passes empty array', async () => {
    const mockLLM = createMockModel({ rules: [plainReadRule], listDefinitions: [] });

    const result = await compileConstitution('Allow all read operations.', sampleAnnotations, compilerConfig, mockLLM);

    expect(result.listDefinitions).toEqual([]);
  });

  it('includes lists condition in rule when LLM emits it', async () => {
    const rulesWithListCondition: CompiledRule[] = [
      {
        name: 'allow-contacts',
        description: 'Allow sending to contacts',
        principle: 'send to contacts',
        if: {
          lists: [
            {
              roles: ['fetch-url'],
              allowed: ['@my-contacts'],
              matchType: 'emails',
            },
          ],
        },
        then: 'allow',
        reason: 'Contact is known',
      },
    ];

    const mockLLM = createMockModel({
      rules: rulesWithListCondition,
      listDefinitions: [contactsListDef],
    });

    const result = await compileConstitution(
      'Send email to my contacts without asking.',
      sampleAnnotations,
      compilerConfig,
      mockLLM,
    );

    expect(result.rules[0].if.lists).toBeDefined();
    expect(result.rules[0].if.lists![0].matchType).toBe('emails');
    expect(result.rules[0].if.lists![0].allowed).toEqual(['@my-contacts']);
    expect(result.listDefinitions[0].name).toBe('my-contacts');
  });

  it('system prompt includes Dynamic Lists section', async () => {
    const { model, getSystemPrompt } = createPromptCapturingModel({ rules: [] });

    await compileConstitution('Allow news sites.', sampleAnnotations, compilerConfig, model);

    const system = getSystemPrompt();
    expect(system).toContain('## Dynamic Lists');
    expect(system).toContain('@major-news-sites');
    expect(system).toContain('listDefinitions');
    expect(system).toContain('kebab-case');
  });
});

// ---------------------------------------------------------------------------
// Backward compatibility
// ---------------------------------------------------------------------------

describe('Dynamic Lists Backward Compatibility', () => {
  it('validateCompiledRules works without listDefinitions parameter', () => {
    // Call without second argument -- should use default empty array
    const result = validateCompiledRules([plainReadRule]);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('CompiledRuleCondition without lists field is valid', () => {
    const rules: CompiledRule[] = [
      {
        name: 'allow-sandbox',
        description: 'Allow sandbox reads',
        principle: 'containment',
        if: {
          paths: { roles: ['read-path'], within: '/tmp/sandbox' },
        },
        then: 'allow',
        reason: 'Sandbox',
      },
    ];

    const result = validateCompiledRules(rules, []);

    expect(result.valid).toBe(true);
  });

  it('PolicyEngine works without dynamicLists parameter', () => {
    const policy: CompiledPolicyFile = {
      generatedAt: '',
      constitutionHash: '',
      inputHash: '',
      rules: [plainReadRule],
    };
    const annotations: ToolAnnotationsFile = {
      generatedAt: '',
      servers: {
        filesystem: { inputHash: '', tools: [sampleAnnotations[1]] },
      },
    };

    // No dynamicLists parameter -- backward compatible
    const engine = new PolicyEngine(policy, annotations, []);
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/tmp/file.txt' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });
});

// ===========================================================================
// Phase 2: List type registry, resolver, policy engine expansion
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared fixtures for Phase 2 tests
// ---------------------------------------------------------------------------

function makeToolAnnotationsFile(tools: ToolAnnotation[]): ToolAnnotationsFile {
  const servers: ToolAnnotationsFile['servers'] = {};
  for (const tool of tools) {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive: building map, key may not exist yet
    if (!servers[tool.serverName]) {
      servers[tool.serverName] = { inputHash: '', tools: [] };
    }
    servers[tool.serverName].tools.push(tool);
  }
  return { generatedAt: '', servers };
}

function makePolicyFile(rules: CompiledRule[], listDefinitions?: ListDefinition[]): CompiledPolicyFile {
  return {
    generatedAt: '',
    constitutionHash: '',
    inputHash: '',
    rules,
    listDefinitions,
  };
}

function makeDynamicLists(lists: Record<string, Partial<ResolvedList> & { values: string[] }>): DynamicListsFile {
  const fullLists: Record<string, ResolvedList> = {};
  for (const [name, partial] of Object.entries(lists)) {
    fullLists[name] = {
      values: partial.values,
      manualAdditions: partial.manualAdditions ?? [],
      manualRemovals: partial.manualRemovals ?? [],
      resolvedAt: partial.resolvedAt ?? new Date().toISOString(),
      inputHash: partial.inputHash ?? 'test-hash',
    };
  }
  return { generatedAt: '', lists: fullLists };
}

// ---------------------------------------------------------------------------
// List Type Registry tests
// ---------------------------------------------------------------------------

describe('List Type Registry', () => {
  describe('domains type', () => {
    const domainType = LIST_TYPE_REGISTRY.get('domains')!;

    it('validates valid domain names', () => {
      expect(domainType.validate('example.com')).toBe(true);
      expect(domainType.validate('sub.example.com')).toBe(true);
      expect(domainType.validate('*.example.com')).toBe(true);
      expect(domainType.validate('bbc.com')).toBe(true);
    });

    it('rejects invalid domain values', () => {
      expect(domainType.validate('')).toBe(false);
      expect(domainType.validate('has spaces')).toBe(false);
      expect(domainType.validate('https://example.com')).toBe(false);
      expect(domainType.validate('example.com/path')).toBe(false);
      expect(domainType.validate('*.')).toBe(false);
    });

    it('has format guidance', () => {
      expect(domainType.formatGuidance).toContain('domain');
    });
  });

  describe('emails type', () => {
    const emailType = LIST_TYPE_REGISTRY.get('emails')!;

    it('validates valid email addresses', () => {
      expect(emailType.validate('user@example.com')).toBe(true);
      expect(emailType.validate('a@b.c')).toBe(true);
    });

    it('rejects invalid email values', () => {
      expect(emailType.validate('')).toBe(false);
      expect(emailType.validate('no-at-sign')).toBe(false);
      expect(emailType.validate('has spaces@example.com')).toBe(false);
      expect(emailType.validate('@')).toBe(false);
    });

    it('has format guidance', () => {
      expect(emailType.formatGuidance).toContain('email');
    });
  });

  describe('identifiers type', () => {
    const idType = LIST_TYPE_REGISTRY.get('identifiers')!;

    it('validates valid identifier values', () => {
      expect(idType.validate('AAPL')).toBe(true);
      expect(idType.validate('my-thing')).toBe(true);
      expect(idType.validate('123')).toBe(true);
    });

    it('rejects invalid identifier values', () => {
      expect(idType.validate('')).toBe(false);
      expect(idType.validate('has spaces')).toBe(false);
      expect(idType.validate('has\ttabs')).toBe(false);
    });

    it('has format guidance', () => {
      expect(idType.formatGuidance).toContain('identifiers');
    });
  });

  describe('matcher functions', () => {
    it('domains matcher uses domainMatchesAllowlist', () => {
      const matcher = getListMatcher('domains');
      expect(matcher('example.com', 'example.com')).toBe(true);
      expect(matcher('sub.example.com', '*.example.com')).toBe(true);
      expect(matcher('other.com', 'example.com')).toBe(false);
    });

    it('emails matcher is case-insensitive', () => {
      const matcher = getListMatcher('emails');
      expect(matcher('User@Example.COM', 'user@example.com')).toBe(true);
      expect(matcher('user@example.com', 'USER@EXAMPLE.COM')).toBe(true);
      expect(matcher('other@example.com', 'user@example.com')).toBe(false);
    });

    it('identifiers matcher is case-sensitive exact', () => {
      const matcher = getListMatcher('identifiers');
      expect(matcher('AAPL', 'AAPL')).toBe(true);
      expect(matcher('aapl', 'AAPL')).toBe(false);
      expect(matcher('GOOG', 'AAPL')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// List Resolver tests
// ---------------------------------------------------------------------------

describe('List Resolver', () => {
  it('resolves a knowledge-based list via LLM', async () => {
    const mockLLM = createMockModel({
      values: ['cnn.com', 'bbc.com', 'nytimes.com'],
    });

    const result = await resolveList(newsListDef, { model: mockLLM });

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('bbc.com');
    expect(result.values).toContain('nytimes.com');
    expect(result.manualAdditions).toEqual([]);
    expect(result.manualRemovals).toEqual([]);
    expect(result.resolvedAt).toBeTruthy();
    expect(result.inputHash).toBeTruthy();
  });

  it('filters invalid values using type validation', async () => {
    const mockLLM = createMockModel({
      values: ['cnn.com', 'not a domain', 'https://bad.com', 'bbc.com'],
    });

    const result = await resolveList(newsListDef, { model: mockLLM });

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('bbc.com');
    expect(result.values).not.toContain('not a domain');
    expect(result.values).not.toContain('https://bad.com');
  });

  it('deduplicates values', async () => {
    const mockLLM = createMockModel({
      values: ['cnn.com', 'bbc.com', 'cnn.com', 'bbc.com'],
    });

    const result = await resolveList(newsListDef, { model: mockLLM });

    expect(result.values).toEqual(['cnn.com', 'bbc.com']);
  });

  it('preserves manualAdditions from existing resolution', async () => {
    const mockLLM = createMockModel({ values: ['cnn.com'] });
    const existing: ResolvedList = {
      values: ['old.com'],
      manualAdditions: ['custom.com'],
      manualRemovals: [],
      resolvedAt: '2025-01-01T00:00:00Z',
      inputHash: 'old-hash',
    };

    const result = await resolveList(newsListDef, { model: mockLLM }, existing);

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('custom.com');
    expect(result.manualAdditions).toEqual(['custom.com']);
  });

  it('applies manualRemovals from existing resolution', async () => {
    const mockLLM = createMockModel({ values: ['cnn.com', 'bbc.com'] });
    const existing: ResolvedList = {
      values: [],
      manualAdditions: [],
      manualRemovals: ['bbc.com'],
      resolvedAt: '2025-01-01T00:00:00Z',
      inputHash: 'old-hash',
    };

    const result = await resolveList(newsListDef, { model: mockLLM }, existing);

    expect(result.values).toContain('cnn.com');
    expect(result.values).not.toContain('bbc.com');
    expect(result.manualRemovals).toEqual(['bbc.com']);
  });

  it('fails with descriptive error for requiresMcp lists without MCP clients', async () => {
    const mockLLM = createMockModel({ values: [] });

    await expect(resolveList(contactsListDef, { model: mockLLM })).rejects.toThrow(/requires MCP server access/);
  });

  describe('resolveAllLists', () => {
    it('resolves all definitions', async () => {
      const mockLLM = createMockModel({ values: ['AAPL', 'GOOG'] });

      const result = await resolveAllLists([stocksListDef], { model: mockLLM });

      expect(result.lists['tech-stock-tickers']).toBeDefined();
      expect(result.lists['tech-stock-tickers'].values).toContain('AAPL');
      expect(result.generatedAt).toBeTruthy();
    });

    it('uses cache when inputHash matches', async () => {
      const { model, getCallCount } = createCountingModel();

      // First resolution to get the hash
      const first = await resolveAllLists([stocksListDef], { model });
      const firstHash = first.lists['tech-stock-tickers'].inputHash;
      expect(getCallCount()).toBe(1);

      // Second resolution with matching hash should be cached
      const result = await resolveAllLists([stocksListDef], { model }, first);

      expect(getCallCount()).toBe(1); // No additional LLM call
      expect(result.lists['tech-stock-tickers'].inputHash).toBe(firstHash);
    });

    it('re-resolves when inputHash does not match', async () => {
      const { model, getCallCount } = createCountingModel();

      const existing = makeDynamicLists({
        'tech-stock-tickers': {
          values: ['OLD'],
          inputHash: 'different-hash',
        },
      });

      await resolveAllLists([stocksListDef], { model }, existing);

      expect(getCallCount()).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Policy Engine Expansion tests
// ---------------------------------------------------------------------------

describe('Policy Engine List Expansion', () => {
  it('expands @list-name in domains.allowed', () => {
    const policy = makePolicyFile([makeRuleWithDomainList('major-news-sites')], [newsListDef]);
    const lists = makeDynamicLists({
      'major-news-sites': { values: ['cnn.com', 'bbc.com'] },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    // cnn.com should be allowed (expanded from @major-news-sites)
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://cnn.com/news' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });

  it('expands @list-name in lists[].allowed', () => {
    const rule: CompiledRule = {
      name: 'allow-known-ids',
      description: 'Allow known identifiers',
      principle: 'permit known values',
      if: {
        lists: [
          {
            roles: ['fetch-url'],
            allowed: ['@tech-stock-tickers'],
            matchType: 'identifiers',
          },
        ],
      },
      then: 'allow',
      reason: 'Known identifier',
    };
    const policy = makePolicyFile([rule], [stocksListDef]);
    const lists = makeDynamicLists({
      'tech-stock-tickers': { values: ['AAPL', 'GOOG'] },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'AAPL' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });

  it('throws when @list-name reference is missing from dynamic-lists.json', () => {
    const policy = makePolicyFile([makeRuleWithDomainList('missing-list')]);
    const emptyLists = makeDynamicLists({});
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    expect(() => {
      new PolicyEngine(policy, annotations, [], undefined, undefined, emptyLists);
    }).toThrow(/Dynamic list "@missing-list"/);
  });

  it('applies manual additions during expansion', () => {
    const policy = makePolicyFile([makeRuleWithDomainList('major-news-sites')], [newsListDef]);
    const lists = makeDynamicLists({
      'major-news-sites': {
        values: ['cnn.com'],
        manualAdditions: ['custom-news.com'],
      },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://custom-news.com/article' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });

  it('applies manual removals during expansion', () => {
    const policy = makePolicyFile([makeRuleWithDomainList('major-news-sites')], [newsListDef]);
    const lists = makeDynamicLists({
      'major-news-sites': {
        values: ['cnn.com', 'bbc.com'],
        manualRemovals: ['bbc.com'],
      },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    // bbc.com should NOT match (removed via manualRemovals)
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://bbc.com/news' },
      timestamp: '',
    });
    expect(result.decision).not.toBe('allow');
  });

  it('mixes concrete and expanded values in domains.allowed', () => {
    const rule: CompiledRule = {
      name: 'allow-news',
      description: 'Allow news',
      principle: 'news',
      if: {
        domains: {
          roles: ['fetch-url'],
          allowed: ['specific.com', '@major-news-sites'],
        },
      },
      then: 'allow',
      reason: 'Allowed',
    };
    const policy = makePolicyFile([rule], [newsListDef]);
    const lists = makeDynamicLists({
      'major-news-sites': { values: ['cnn.com'] },
    });
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);

    const engine = new PolicyEngine(policy, annotations, [], undefined, undefined, lists);

    // Both concrete and expanded values should work
    const specificResult = engine.evaluate({
      requestId: '1',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://specific.com/page' },
      timestamp: '',
    });
    expect(specificResult.decision).toBe('allow');

    const expandedResult = engine.evaluate({
      requestId: '2',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'https://cnn.com/news' },
      timestamp: '',
    });
    expect(expandedResult.decision).toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// ListCondition Evaluation tests
// ---------------------------------------------------------------------------

describe('ListCondition Evaluation', () => {
  it('matches email list condition (case-insensitive)', () => {
    const rule: CompiledRule = {
      name: 'allow-contacts',
      description: 'Allow sending to contacts',
      principle: 'contacts',
      if: {
        lists: [
          {
            roles: ['fetch-url'],
            allowed: ['alice@example.com', 'bob@example.com'],
            matchType: 'emails',
          },
        ],
      },
      then: 'allow',
      reason: 'Contact',
    };
    const policy = makePolicyFile([rule]);
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);
    const engine = new PolicyEngine(policy, annotations, []);

    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'ALICE@EXAMPLE.COM' },
      timestamp: '',
    });
    expect(result.decision).toBe('allow');
  });

  it('matches identifier list condition (case-sensitive)', () => {
    const rule: CompiledRule = {
      name: 'allow-tickers',
      description: 'Allow known tickers',
      principle: 'tickers',
      if: {
        lists: [
          {
            roles: ['fetch-url'],
            allowed: ['AAPL', 'GOOG'],
            matchType: 'identifiers',
          },
        ],
      },
      then: 'allow',
      reason: 'Known ticker',
    };
    const policy = makePolicyFile([rule]);
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);
    const engine = new PolicyEngine(policy, annotations, []);

    const matchResult = engine.evaluate({
      requestId: '1',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'AAPL' },
      timestamp: '',
    });
    expect(matchResult.decision).toBe('allow');

    // Case mismatch should not match
    const noMatchResult = engine.evaluate({
      requestId: '2',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'aapl' },
      timestamp: '',
    });
    expect(noMatchResult.decision).not.toBe('allow');
  });

  it('returns false when zero values are extracted', () => {
    const rule: CompiledRule = {
      name: 'allow-contacts',
      description: 'Allow contacts',
      principle: 'contacts',
      if: {
        lists: [
          {
            roles: ['fetch-url'], // This role won't match read_file's path arg
            allowed: ['alice@example.com'],
            matchType: 'emails',
          },
        ],
      },
      then: 'allow',
      reason: 'Contact',
    };
    const readAnnotation: ToolAnnotation = {
      toolName: 'read_file',
      serverName: 'filesystem',
      comment: 'Reads file',
      sideEffects: false,
      args: { path: ['read-path'] },
    };
    const policy = makePolicyFile([rule]);
    const annotations = makeToolAnnotationsFile([readAnnotation]);
    const engine = new PolicyEngine(policy, annotations, []);

    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'filesystem',
      toolName: 'read_file',
      arguments: { path: '/tmp/file.txt' },
      timestamp: '',
    });
    // Rule should not match (zero extraction), falls through to default deny
    expect(result.decision).toBe('deny');
    expect(result.rule).toBe('default-deny');
  });

  it('requires ALL list conditions to be satisfied (AND semantics)', () => {
    const rule: CompiledRule = {
      name: 'allow-if-both',
      description: 'Both conditions must match',
      principle: 'dual check',
      if: {
        lists: [
          {
            roles: ['fetch-url'],
            allowed: ['AAPL'],
            matchType: 'identifiers',
          },
          {
            roles: ['fetch-url'],
            allowed: ['GOOG'],
            matchType: 'identifiers',
          },
        ],
      },
      then: 'allow',
      reason: 'Both matched',
    };
    const policy = makePolicyFile([rule]);
    const annotations = makeToolAnnotationsFile([fetchAnnotation]);
    const engine = new PolicyEngine(policy, annotations, []);

    // AAPL matches first condition but not second
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'fetch',
      toolName: 'fetch',
      arguments: { url: 'AAPL' },
      timestamp: '',
    });
    expect(result.decision).not.toBe('allow');
  });
});

// ---------------------------------------------------------------------------
// hasRoleConditions and ruleRelevantToRole integration tests
// ---------------------------------------------------------------------------

describe('Per-Role Evaluation with Lists', () => {
  it('lists condition makes a rule role-specific (not role-agnostic)', () => {
    // A rule with only lists condition should be treated as role-specific
    const emailSendAnnotation: ToolAnnotation = {
      toolName: 'send_email',
      serverName: 'email',
      comment: 'Sends email',
      sideEffects: true,
      // Tool has both a read-path arg (for attachment) and a fetch-url arg (for recipient)
      args: { recipient: ['fetch-url'], attachment: ['read-path'] },
    };
    const rule: CompiledRule = {
      name: 'allow-contacts',
      description: 'Allow sending to contacts',
      principle: 'contacts',
      if: {
        lists: [
          {
            roles: ['fetch-url'],
            allowed: ['alice@example.com'],
            matchType: 'emails',
          },
        ],
      },
      then: 'allow',
      reason: 'Contact',
    };
    const fallbackRule: CompiledRule = {
      name: 'escalate-all',
      description: 'Escalate everything else',
      principle: 'safety',
      if: {},
      then: 'escalate',
      reason: 'Not explicitly allowed',
    };
    const policy = makePolicyFile([rule, fallbackRule]);
    const annotations = makeToolAnnotationsFile([emailSendAnnotation]);

    const engine = new PolicyEngine(policy, annotations, []);

    // When the recipient matches the contact list, fetch-url role gets "allow"
    // but read-path role should fall through to escalate (lists condition is
    // not relevant to read-path)
    const result = engine.evaluate({
      requestId: 'test',
      serverName: 'email',
      toolName: 'send_email',
      arguments: { recipient: 'alice@example.com', attachment: '/tmp/file.txt' },
      timestamp: '',
    });
    // Most restrictive wins: escalate > allow
    expect(result.decision).toBe('escalate');
  });
});

// ===========================================================================
// Phase 3: MCP-backed list resolution
// ===========================================================================

// ---------------------------------------------------------------------------
// Shared fixtures for Phase 3 tests
// ---------------------------------------------------------------------------

function createMockMcpConnection(
  toolNames: string[] = ['list_contacts'],
  toolResult: unknown = { content: [{ type: 'text', text: '[]' }] },
): McpServerConnection {
  return {
    client: {
      callTool: vi.fn().mockResolvedValue(toolResult),
      close: vi.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    tools: toolNames.map((name) => ({
      name,
      description: `Mock tool: ${name}`,
      inputSchema: { type: 'object', properties: {} },
    })),
  };
}

/**
 * Creates a MockLanguageModelV3 that simulates a multi-step tool-use conversation:
 *   Step 1: LLM calls the specified tool
 *   Step 2: LLM returns text with the final JSON values
 */
function createToolUseModel(
  toolName: string,
  toolArgs: Record<string, unknown>,
  finalValues: string[],
): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: [
      // Step 1: LLM decides to call a tool
      {
        ...MOCK_GENERATE_RESULT,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'call-1',
            toolName,
            args: JSON.stringify(toolArgs),
          },
        ],
        finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
      },
      // Step 2: LLM returns text with the final answer
      {
        ...MOCK_GENERATE_RESULT,
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ values: finalValues }),
          },
        ],
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// MCP-backed resolution tests
// ---------------------------------------------------------------------------

describe('MCP-Backed List Resolution', () => {
  it('resolves a data-backed list via MCP tools', async () => {
    const connection = createMockMcpConnection(['list_contacts'], {
      content: [
        {
          type: 'text',
          text: JSON.stringify([
            { name: 'Alice', email: 'alice@example.com' },
            { name: 'Bob', email: 'bob@company.org' },
          ]),
        },
      ],
    });

    const mcpConnections = new Map([['contacts', connection]]);
    const model = createToolUseModel('contacts__list_contacts', {}, ['alice@example.com', 'bob@company.org']);

    const config: ListResolverConfig = { model, mcpConnections };
    const result = await resolveList(contactsListDef, config);

    expect(result.values).toContain('alice@example.com');
    expect(result.values).toContain('bob@company.org');
    expect(result.resolvedAt).toBeTruthy();
    expect(result.inputHash).toBeTruthy();
  });

  it('fails when requiresMcp but mcpConnections is empty', async () => {
    const model = createMockModel({ values: [] });
    const emptyConnections = new Map<string, McpServerConnection>();

    await expect(resolveList(contactsListDef, { model, mcpConnections: emptyConnections })).rejects.toThrow(
      /requires MCP server access/,
    );
  });

  it('uses mcpServerHint to select the correct connection', async () => {
    const contactsConn = createMockMcpConnection(['list_contacts'], {
      content: [
        {
          type: 'text',
          text: JSON.stringify([{ email: 'alice@example.com' }]),
        },
      ],
    });
    const otherConn = createMockMcpConnection(['other_tool']);

    const mcpConnections = new Map([
      ['other-server', otherConn],
      ['contacts', contactsConn],
    ]);

    const model = createToolUseModel('contacts__list_contacts', {}, ['alice@example.com']);

    const config: ListResolverConfig = { model, mcpConnections };
    const result = await resolveList(contactsListDef, config);

    expect(result.values).toContain('alice@example.com');
  });

  it('falls back to first connection when mcpServerHint does not match', async () => {
    const fallbackConn = createMockMcpConnection(['query_data'], {
      content: [
        {
          type: 'text',
          text: JSON.stringify([{ email: 'fallback@example.com' }]),
        },
      ],
    });

    const mcpConnections = new Map([['some-server', fallbackConn]]);

    // contactsListDef has mcpServerHint: 'contacts' but we only have 'some-server'
    const model = createToolUseModel('some-server__query_data', {}, ['fallback@example.com']);

    const config: ListResolverConfig = { model, mcpConnections };
    const result = await resolveList(contactsListDef, config);

    expect(result.values).toContain('fallback@example.com');
  });

  it('applies type validation to MCP-resolved values', async () => {
    const connection = createMockMcpConnection(['list_contacts']);
    const mcpConnections = new Map([['contacts', connection]]);

    // LLM returns some invalid emails mixed with valid ones
    const model = createToolUseModel('contacts__list_contacts', {}, [
      'alice@example.com',
      'not-an-email',
      'bob@company.org',
    ]);

    const config: ListResolverConfig = { model, mcpConnections };
    const result = await resolveList(contactsListDef, config);

    expect(result.values).toContain('alice@example.com');
    expect(result.values).toContain('bob@company.org');
    expect(result.values).not.toContain('not-an-email');
  });

  it('preserves manual overrides for MCP-resolved lists', async () => {
    const connection = createMockMcpConnection(['list_contacts']);
    const mcpConnections = new Map([['contacts', connection]]);

    const model = createToolUseModel('contacts__list_contacts', {}, ['alice@example.com']);

    const existing: ResolvedList = {
      values: ['old@example.com'],
      manualAdditions: ['manual@example.com'],
      manualRemovals: ['alice@example.com'],
      resolvedAt: '2025-01-01T00:00:00Z',
      inputHash: 'old-hash',
    };

    const config: ListResolverConfig = { model, mcpConnections };
    const result = await resolveList(contactsListDef, config, existing);

    expect(result.values).toContain('manual@example.com');
    expect(result.values).not.toContain('alice@example.com');
    expect(result.manualAdditions).toEqual(['manual@example.com']);
    expect(result.manualRemovals).toEqual(['alice@example.com']);
  });

  it('knowledge-based lists ignore mcpConnections', async () => {
    const connection = createMockMcpConnection(['list_contacts']);
    const mcpConnections = new Map([['contacts', connection]]);
    const model = createMockModel({
      values: ['cnn.com', 'bbc.com'],
    });

    // newsListDef has requiresMcp: false -- should use LLM directly
    const config: ListResolverConfig = { model, mcpConnections };
    const result = await resolveList(newsListDef, config);

    expect(result.values).toContain('cnn.com');
    expect(result.values).toContain('bbc.com');
  });
});

describe('MCP-Backed resolveAllLists', () => {
  it('resolves mixed knowledge-based and MCP-backed lists', async () => {
    const connection = createMockMcpConnection(['list_contacts']);
    const mcpConnections = new Map([['contacts', connection]]);

    let callIndex = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        callIndex++;
        // First call: knowledge-based list (stocksListDef)
        // Second+: MCP-backed list tool call then text
        if (callIndex === 1) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ values: ['AAPL', 'GOOG'] }),
              },
            ],
            ...MOCK_GENERATE_RESULT,
          };
        }
        if (callIndex === 2) {
          return {
            ...MOCK_GENERATE_RESULT,
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call-1',
                toolName: 'contacts__list_contacts',
                args: '{}',
              },
            ],
            finishReason: { unified: 'tool-calls' as const, raw: 'tool_use' },
          };
        }
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ values: ['alice@example.com'] }),
            },
          ],
          ...MOCK_GENERATE_RESULT,
        };
      },
    });

    const result = await resolveAllLists([stocksListDef, contactsListDef], { model, mcpConnections });

    expect(result.lists['tech-stock-tickers']).toBeDefined();
    expect(result.lists['tech-stock-tickers'].values).toContain('AAPL');
    expect(result.lists['my-contacts']).toBeDefined();
    expect(result.lists['my-contacts'].values).toContain('alice@example.com');
  });
});

// ===========================================================================
// Phase 4: bypassCache for refresh-lists
// ===========================================================================

describe('resolveAllLists bypassCache', () => {
  it('re-resolves even when hash matches when bypassCache is true', async () => {
    const { model, getCallCount } = createCountingModel((i) => [`value-${i}`]);

    // First resolution to get a valid hash
    const first = await resolveAllLists([stocksListDef], { model });
    expect(getCallCount()).toBe(1);

    // With bypassCache: true, should re-resolve despite matching hash
    const result = await resolveAllLists([stocksListDef], { model }, first, undefined, true);

    expect(getCallCount()).toBe(2);
    expect(result.lists['tech-stock-tickers'].values).toContain('value-2');
  });

  it('skips cached lists when bypassCache is false (default)', async () => {
    const { model, getCallCount } = createCountingModel(() => ['AAPL']);

    // First resolution
    const first = await resolveAllLists([stocksListDef], { model });
    expect(getCallCount()).toBe(1);

    // Default behavior (no bypassCache) should use cache
    const result = await resolveAllLists([stocksListDef], { model }, first);

    expect(getCallCount()).toBe(1); // No additional LLM call
    expect(result.lists['tech-stock-tickers'].values).toContain('AAPL');
  });
});
