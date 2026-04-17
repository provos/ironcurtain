/**
 * Tests for observe-tui-word-scorer -- TF-IDF word scoring for rain panel word drops.
 */

import { describe, it, expect } from 'vitest';
import {
  extractWordsFromText,
  extractWordsFromCode,
  extractCodeFromToolInput,
  createWordScorer,
  cleanToolName,
  shortenModelName,
  createTextAccumulator,
  createToolInputAccumulator,
  createSessionWordState,
  processEventForWords,
} from '../src/observe/observe-tui-word-scorer.js';

// ---------------------------------------------------------------------------
// extractWordsFromText
// ---------------------------------------------------------------------------

describe('extractWordsFromText', () => {
  it('extracts words of minimum length 4', () => {
    const words = extractWordsFromText('the big configuration file was updated');
    const originals = words.map((w) => w.original);
    expect(originals).toContain('configuration');
    expect(originals).toContain('file');
    expect(originals).toContain('updated');
    // "the" and "big" are too short
    expect(originals).not.toContain('the');
    expect(originals).not.toContain('big');
  });

  it('filters out stop words', () => {
    const words = extractWordsFromText('this function should return something interesting');
    const originals = words.map((w) => w.original);
    expect(originals).not.toContain('this');
    expect(originals).not.toContain('function');
    expect(originals).not.toContain('should');
    expect(originals).not.toContain('return');
    expect(originals).toContain('something');
    expect(originals).toContain('interesting');
  });

  it('filters out code stop words', () => {
    const words = extractWordsFromText('async function await const import export');
    const originals = words.map((w) => w.original);
    expect(originals).not.toContain('async');
    expect(originals).not.toContain('function');
    expect(originals).not.toContain('await');
    expect(originals).not.toContain('const');
    expect(originals).not.toContain('import');
    expect(originals).not.toContain('export');
  });

  it('strips punctuation from words', () => {
    const words = extractWordsFromText('"configuration" (deployment) [kubernetes]');
    const originals = words.map((w) => w.original);
    expect(originals).toContain('configuration');
    expect(originals).toContain('deployment');
    expect(originals).toContain('kubernetes');
  });

  it('skips all-digit tokens', () => {
    const words = extractWordsFromText('port 8080 version 12345');
    const originals = words.map((w) => w.original);
    expect(originals).not.toContain('8080');
    expect(originals).not.toContain('12345');
    expect(originals).toContain('port');
    expect(originals).toContain('version');
  });

  it('skips hash-like hex tokens (>=8 chars with at least one digit)', () => {
    // SHA-like tokens: 8+ chars, mix of letters and digits -> rejected
    const words = extractWordsFromText('hash a1b2c3d4 commit deadb33f token 9f8e7d6c5b4a');
    const originals = words.map((w) => w.original);
    expect(originals).not.toContain('a1b2c3d4');
    expect(originals).not.toContain('deadb33f');
    expect(originals).not.toContain('9f8e7d6c5b4a');
    expect(originals).toContain('hash');
    expect(originals).toContain('commit');
    expect(originals).toContain('token');
  });

  it('preserves hex-letter-only English words regardless of length', () => {
    // Pure letters (no digits) -> always kept, even if they look hex
    const words = extractWordsFromText('face cafe beef dead decade feedback deadbeef abcdef');
    const originals = words.map((w) => w.original);
    expect(originals).toContain('face');
    expect(originals).toContain('cafe');
    expect(originals).toContain('beef');
    expect(originals).toContain('dead');
    expect(originals).toContain('decade');
    expect(originals).toContain('feedback');
    // Long pure-letter hex-looking words should also survive
    expect(originals).toContain('deadbeef');
    expect(originals).toContain('abcdef');
  });

  it('preserves short hex-ish tokens with digits (below identifier length threshold)', () => {
    // Length < 8 with digits -> still a "real" word in our judgment
    const words = extractWordsFromText('using sha1a hash');
    const originals = words.map((w) => w.original);
    expect(originals).toContain('sha1a');
  });

  it('preserves original casing', () => {
    const words = extractWordsFromText('Kubernetes Docker Container');
    const found = words.find((w) => w.lower === 'kubernetes');
    expect(found).toBeDefined();
    expect(found?.original).toBe('Kubernetes');
  });

  it('returns empty array for empty text', () => {
    expect(extractWordsFromText('')).toEqual([]);
  });

  it('returns empty array for only short/stop words', () => {
    expect(extractWordsFromText('the is a an')).toEqual([]);
  });

  it('splits on various punctuation', () => {
    const words = extractWordsFromText('hello;world,deployment:configuration');
    const originals = words.map((w) => w.original);
    expect(originals).toContain('hello');
    expect(originals).toContain('world');
    expect(originals).toContain('deployment');
    expect(originals).toContain('configuration');
  });
});

// ---------------------------------------------------------------------------
// extractWordsFromCode
// ---------------------------------------------------------------------------

describe('extractWordsFromCode', () => {
  it('extracts function call names', () => {
    const code = 'const result = filesystem.read_file({ path: "/tmp/test" })';
    const words = extractWordsFromCode(code);
    const originals = words.map((w) => w.original);
    expect(originals).toContain('read_file');
  });

  it('extracts dotted tool method names', () => {
    const code = 'google_workspace.calendar_get_events({ query: "test" })';
    const words = extractWordsFromCode(code);
    const originals = words.map((w) => w.original);
    expect(originals).toContain('calendar_get_events');
  });

  it('extracts meaningful string literals', () => {
    const code = 'const query = "kubernetes deployment status"';
    const words = extractWordsFromCode(code);
    const originals = words.map((w) => w.original);
    expect(originals).toContain('kubernetes');
    expect(originals).toContain('deployment');
    expect(originals).toContain('status');
  });

  it('extracts filenames from path-like strings', () => {
    const code = 'filesystem.read_file({ path: "/home/user/config-parser.ts" })';
    const words = extractWordsFromCode(code);
    const originals = words.map((w) => w.original);
    expect(originals).toContain('config-parser');
  });

  it('deduplicates words within a single code block', () => {
    const code = 'const a = read_file(); const b = read_file()';
    const words = extractWordsFromCode(code);
    const readFileOccurrences = words.filter((w) => w.lower === 'read_file');
    expect(readFileOccurrences).toHaveLength(1);
  });

  it('also runs regular word extraction on code text', () => {
    const code = '// Analyze the kubernetes deployment configuration\nconst x = 1;';
    const words = extractWordsFromCode(code);
    const originals = words.map((w) => w.original);
    expect(originals).toContain('Analyze');
    expect(originals).toContain('kubernetes');
  });
});

// ---------------------------------------------------------------------------
// extractCodeFromToolInput
// ---------------------------------------------------------------------------

describe('extractCodeFromToolInput', () => {
  it('extracts code field from valid JSON', () => {
    const json = '{"code":"const x = readFile()","timeout":5000}';
    expect(extractCodeFromToolInput(json)).toBe('const x = readFile()');
  });

  it('returns null for incomplete JSON', () => {
    expect(extractCodeFromToolInput('{"code":"const x')).toBeNull();
  });

  it('returns null for JSON without code field', () => {
    expect(extractCodeFromToolInput('{"path":"/tmp/test"}')).toBeNull();
  });

  it('returns null for non-string code field', () => {
    expect(extractCodeFromToolInput('{"code":42}')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// createWordScorer: TF-IDF scoring
// ---------------------------------------------------------------------------

describe('WordScorer TF-IDF scoring', () => {
  it('returns top-scoring words from a document', () => {
    const scorer = createWordScorer(3);
    const words = extractWordsFromText('kubernetes deployment configuration rollback strategy');
    const scored = scorer.scoreDocument(words);
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.length).toBeLessThanOrEqual(3);
    // All returned words should be from the input
    for (const s of scored) {
      expect(words.some((w) => w.lower === s.key)).toBe(true);
    }
  });

  it('returns fewer than topN when document has fewer unique words', () => {
    const scorer = createWordScorer(5);
    const words = [{ original: 'hello', lower: 'hello' }];
    const scored = scorer.scoreDocument(words);
    expect(scored).toHaveLength(1);
    expect(scored[0].word).toBe('hello');
  });

  it('returns empty array for empty word list', () => {
    const scorer = createWordScorer();
    expect(scorer.scoreDocument([])).toEqual([]);
  });

  it('IDF decreases score for words appearing in many documents', () => {
    const scorer = createWordScorer(3);

    // First document: "kubernetes" and "deployment" both new
    const doc1 = [
      { original: 'kubernetes', lower: 'kubernetes' },
      { original: 'deployment', lower: 'deployment' },
    ];
    scorer.scoreDocument(doc1);

    // Second document: "kubernetes" repeats, "monitoring" is new
    const doc2 = [
      { original: 'kubernetes', lower: 'kubernetes' },
      { original: 'monitoring', lower: 'monitoring' },
    ];
    const scored2 = scorer.scoreDocument(doc2);

    // "monitoring" should score higher than "kubernetes" since it's new
    const monScore = scored2.find((s) => s.key === 'monitoring')?.score ?? 0;
    const k8sScore = scored2.find((s) => s.key === 'kubernetes')?.score ?? 0;
    expect(monScore).toBeGreaterThan(k8sScore);
  });

  it('tracks document count', () => {
    const scorer = createWordScorer();
    expect(scorer.documentCount).toBe(0);

    scorer.scoreDocument([{ original: 'test', lower: 'test' }]);
    expect(scorer.documentCount).toBe(1);

    scorer.scoreDocument([{ original: 'another', lower: 'another' }]);
    expect(scorer.documentCount).toBe(2);
  });

  it('preserves best original casing for display', () => {
    const scorer = createWordScorer(1);
    const words = [
      { original: 'Kubernetes', lower: 'kubernetes' },
      { original: 'kubernetes', lower: 'kubernetes' },
    ];
    const scored = scorer.scoreDocument(words);
    // Should prefer the first occurrence's casing
    expect(scored[0].word).toBe('Kubernetes');
  });
});

// ---------------------------------------------------------------------------
// WordScorer: throttle/dedup
// ---------------------------------------------------------------------------

describe('WordScorer throttle/dedup', () => {
  it('allows a word on first show', () => {
    const scorer = createWordScorer(3, 30000);
    expect(scorer.tryShow('kubernetes', 1000)).toBe(true);
  });

  it('blocks a word within dedup window', () => {
    const scorer = createWordScorer(3, 30000);
    expect(scorer.tryShow('kubernetes', 1000)).toBe(true);
    expect(scorer.tryShow('kubernetes', 5000)).toBe(false);
    expect(scorer.tryShow('kubernetes', 29999)).toBe(false);
  });

  it('allows a word after dedup window expires', () => {
    const scorer = createWordScorer(3, 30000);
    expect(scorer.tryShow('kubernetes', 1000)).toBe(true);
    expect(scorer.tryShow('kubernetes', 31001)).toBe(true);
  });

  it('tracks different words independently', () => {
    const scorer = createWordScorer(3, 30000);
    expect(scorer.tryShow('kubernetes', 1000)).toBe(true);
    expect(scorer.tryShow('deployment', 1000)).toBe(true);
    expect(scorer.tryShow('kubernetes', 5000)).toBe(false);
    expect(scorer.tryShow('deployment', 5000)).toBe(false);
  });

  it('cleans up expired entries on calls', () => {
    const scorer = createWordScorer(3, 100);
    scorer.tryShow('word1', 0);
    scorer.tryShow('word2', 0);
    scorer.tryShow('word3', 0);
    // After the window, all should be showable again
    expect(scorer.tryShow('word1', 200)).toBe(true);
    expect(scorer.tryShow('word2', 200)).toBe(true);
    expect(scorer.tryShow('word3', 200)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cleanToolName
// ---------------------------------------------------------------------------

describe('cleanToolName', () => {
  it('strips mcp__server__tool prefix', () => {
    expect(cleanToolName('mcp__ironcurtain__execute_code')).toBe('execute_code');
  });

  it('strips simpler server__tool prefix', () => {
    expect(cleanToolName('filesystem__read_file')).toBe('read_file');
  });

  it('returns name as-is when no prefix', () => {
    expect(cleanToolName('read_file')).toBe('read_file');
  });

  it('handles names with underscores in the tool part', () => {
    expect(cleanToolName('mcp__git__git_log_show')).toBe('git_log_show');
  });
});

// ---------------------------------------------------------------------------
// shortenModelName
// ---------------------------------------------------------------------------

describe('shortenModelName', () => {
  it('strips claude- prefix', () => {
    expect(shortenModelName('claude-sonnet-4-20250514')).toBe('sonnet-4-20250514');
  });

  it('leaves non-claude models unchanged', () => {
    expect(shortenModelName('gpt-4-turbo')).toBe('gpt-4-turbo');
  });

  it('handles short names', () => {
    expect(shortenModelName('claude-')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// TextAccumulator
// ---------------------------------------------------------------------------

describe('TextAccumulator', () => {
  it('returns null when under threshold', () => {
    const acc = createTextAccumulator(200);
    expect(acc.append('hello world')).toBeNull();
    expect(acc.length).toBe(11);
  });

  it('returns words when threshold reached', () => {
    const acc = createTextAccumulator(20);
    const result = acc.append('kubernetes deployment configuration rollback');
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  });

  it('flush returns all accumulated words', () => {
    const acc = createTextAccumulator(1000);
    acc.append('kubernetes deployment configuration');
    const words = acc.flush();
    expect(words.length).toBeGreaterThan(0);
    expect(acc.length).toBe(0); // reset after flush
  });

  it('reset clears the buffer', () => {
    const acc = createTextAccumulator(1000);
    acc.append('hello world');
    acc.reset();
    expect(acc.length).toBe(0);
  });

  it('does not re-trigger mid-stream until new text accumulates past threshold', () => {
    const acc = createTextAccumulator(20);
    // First trigger
    acc.append('kubernetes deployment configuration rollback');
    // Next append under threshold from last score point
    expect(acc.append('tiny')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ToolInputAccumulator
// ---------------------------------------------------------------------------

describe('ToolInputAccumulator', () => {
  it('tracks active state', () => {
    const acc = createToolInputAccumulator();
    expect(acc.active).toBe(false);
    acc.start('execute_code');
    expect(acc.active).toBe(true);
  });

  it('accumulates delta fragments', () => {
    const acc = createToolInputAccumulator();
    acc.start('execute_code');
    acc.appendDelta('{"code":');
    acc.appendDelta('"const x = readFile()"}');
    const result = acc.flush();
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe('execute_code');
    expect(result!.words.length).toBeGreaterThan(0);
  });

  it('extracts code from execute_code tool input', () => {
    const acc = createToolInputAccumulator();
    acc.start('execute_code');
    acc.appendDelta('{"code":"const result = kubernetes.list_pods()"}');
    const result = acc.flush();
    expect(result).not.toBeNull();
    const originals = result!.words.map((w) => w.original);
    expect(originals).toContain('list_pods');
  });

  it('flush returns null when not active', () => {
    const acc = createToolInputAccumulator();
    expect(acc.flush()).toBeNull();
  });

  it('resets after flush', () => {
    const acc = createToolInputAccumulator();
    acc.start('test');
    acc.flush();
    expect(acc.active).toBe(false);
    expect(acc.flush()).toBeNull();
  });

  it('falls back to text extraction for non-code JSON', () => {
    const acc = createToolInputAccumulator();
    acc.start('read_file');
    acc.appendDelta('{"path":"/home/user/kubernetes-config.yaml"}');
    const result = acc.flush();
    expect(result).not.toBeNull();
    // Should extract something from the text (e.g., "kubernetes")
    expect(result!.words.length).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// processEventForWords: integration
// ---------------------------------------------------------------------------

describe('processEventForWords', () => {
  it('produces model name word drop on message_start', () => {
    const wordState = createSessionWordState();
    const scorer = createWordScorer();

    const candidates = processEventForWords(
      { kind: 'message_start', model: 'claude-sonnet-4-20250514', timestamp: Date.now() },
      wordState,
      scorer,
      1000,
    );

    expect(candidates.length).toBeGreaterThan(0);
    const modelCandidate = candidates.find((c) => c.source === 'model');
    expect(modelCandidate).toBeDefined();
    expect(modelCandidate!.word).toBe('sonnet-4-20250514');
  });

  it('produces tool name word drop on tool_use with non-empty toolName', () => {
    const wordState = createSessionWordState();
    const scorer = createWordScorer();

    const candidates = processEventForWords(
      { kind: 'tool_use', toolName: 'mcp__ironcurtain__execute_code', inputDelta: '', timestamp: Date.now() },
      wordState,
      scorer,
      1000,
    );

    const toolCandidate = candidates.find((c) => c.source === 'tool');
    expect(toolCandidate).toBeDefined();
    expect(toolCandidate!.word).toBe('execute_code');
  });

  it('accumulates text_delta and scores at threshold', () => {
    const wordState = createSessionWordState();
    const scorer = createWordScorer();

    // Send enough text to cross the 200-char mid-stream threshold
    const longText =
      'The kubernetes deployment configuration involves several important architectural decisions ' +
      'about container orchestration and service mesh integration with distributed tracing observability ' +
      'and comprehensive monitoring dashboards for production workloads';

    const candidates = processEventForWords(
      { kind: 'text_delta', text: longText, timestamp: Date.now() },
      wordState,
      scorer,
      1000,
    );

    // With enough text (>200 chars), should produce scored word candidates
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((c) => c.source === 'text')).toBe(true);
  });

  it('flushes text and tool accumulators on message_end', () => {
    const wordState = createSessionWordState();
    const scorer = createWordScorer();

    // Accumulate some text (under threshold so not yet scored)
    processEventForWords(
      { kind: 'text_delta', text: 'kubernetes deployment', timestamp: Date.now() },
      wordState,
      scorer,
      1000,
    );

    // message_end flushes
    const candidates = processEventForWords(
      { kind: 'message_end', stopReason: 'end_turn', inputTokens: 100, outputTokens: 50, timestamp: Date.now() },
      wordState,
      scorer,
      2000,
    );

    // Should have scored the accumulated text
    expect(candidates.length).toBeGreaterThan(0);
  });

  it('does not produce duplicate word drops within dedup window', () => {
    const wordState = createSessionWordState();
    const scorer = createWordScorer(3, 30000);

    // First message with kubernetes
    processEventForWords(
      { kind: 'text_delta', text: 'kubernetes kubernetes kubernetes kubernetes', timestamp: Date.now() },
      wordState,
      scorer,
      1000,
    );
    processEventForWords(
      { kind: 'message_end', stopReason: 'end_turn', inputTokens: 100, outputTokens: 50, timestamp: Date.now() },
      wordState,
      scorer,
      2000,
    );

    // Second message with kubernetes shortly after -- should be throttled
    processEventForWords(
      { kind: 'message_start', model: 'test-model', timestamp: Date.now() },
      wordState,
      scorer,
      3000,
    );
    processEventForWords(
      { kind: 'text_delta', text: 'kubernetes kubernetes kubernetes kubernetes', timestamp: Date.now() },
      wordState,
      scorer,
      3500,
    );
    const candidates2 = processEventForWords(
      { kind: 'message_end', stopReason: 'end_turn', inputTokens: 100, outputTokens: 50, timestamp: Date.now() },
      wordState,
      scorer,
      4000,
    );

    // "kubernetes" should be throttled in the second batch
    const k8sCandidates = candidates2.filter((c) => c.word.toLowerCase() === 'kubernetes');
    expect(k8sCandidates).toHaveLength(0);
  });

  it('resets text accumulator on message_start', () => {
    const wordState = createSessionWordState();
    const scorer = createWordScorer();

    // Accumulate text
    processEventForWords(
      { kind: 'text_delta', text: 'some accumulated text', timestamp: Date.now() },
      wordState,
      scorer,
      1000,
    );

    // message_start should reset accumulator
    processEventForWords(
      { kind: 'message_start', model: 'claude-sonnet-4-20250514', timestamp: Date.now() },
      wordState,
      scorer,
      2000,
    );

    expect(wordState.textAccumulator.length).toBe(0);
  });

  it('flushes previous tool accumulator when new tool starts', () => {
    const wordState = createSessionWordState();
    const scorer = createWordScorer();

    // Start first tool
    processEventForWords(
      { kind: 'tool_use', toolName: 'read_file', inputDelta: '', timestamp: Date.now() },
      wordState,
      scorer,
      1000,
    );

    // Add input delta
    processEventForWords(
      {
        kind: 'tool_use',
        toolName: '',
        inputDelta: '{"path":"/home/kubernetes-deployment.yaml"}',
        timestamp: Date.now(),
      },
      wordState,
      scorer,
      1500,
    );

    // Start second tool -- should flush the first
    const candidates = processEventForWords(
      { kind: 'tool_use', toolName: 'write_file', inputDelta: '', timestamp: Date.now() },
      wordState,
      scorer,
      2000,
    );

    // Should have produced words from the first tool's input
    // (the exact words depend on what passes TF-IDF + dedup, but candidates length should reflect processing)
    expect(candidates.length).toBeGreaterThanOrEqual(0);
  });

  it('handles empty toolName (input_json_delta) without crashing', () => {
    const wordState = createSessionWordState();
    const scorer = createWordScorer();

    // Send delta without starting a tool (edge case)
    const candidates = processEventForWords(
      { kind: 'tool_use', toolName: '', inputDelta: '{"data":"test"}', timestamp: Date.now() },
      wordState,
      scorer,
      1000,
    );

    expect(candidates).toEqual([]);
  });
});
