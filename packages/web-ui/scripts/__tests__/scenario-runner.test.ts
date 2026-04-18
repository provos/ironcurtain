import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  createScenarioRunner,
  loadCorpusFromText,
  realScheduler,
  sampleTokensThisTick,
  validateScenario,
  ScenarioValidationError,
  type Scenario,
  type Corpus,
} from '../scenario-runner.js';
import { createSeededRng } from '../../src/lib/matrix-rain/engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIMPLE_CORPUS: Corpus = loadCorpusFromText('the quick brown fox jumps over the lazy dog every morning at dawn');

function buildScenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    description: 'test scenario',
    tokenProfile: {
      corpus: 'default',
      baseTokenRate: 40,
      burstiness: 0,
      toolCallRatePerMin: 6,
    },
    timeline: [
      { at: 100, event: 'workflow.started', payload: { workflowId: 'wf-test' } },
      { at: 500, event: 'workflow.state_entered', payload: { state: 'analyze' } },
      { at: 2000, event: 'workflow.agent_completed', payload: { verdict: 'done' } },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('validateScenario', () => {
  it('accepts a well-formed scenario', () => {
    const raw = buildScenario();
    expect(() => validateScenario(raw)).not.toThrow();
  });

  it('rejects non-object input', () => {
    expect(() => validateScenario('not an object')).toThrow(ScenarioValidationError);
  });

  it('rejects missing description', () => {
    const raw = { ...buildScenario() } as Record<string, unknown>;
    delete raw.description;
    expect(() => validateScenario(raw)).toThrow(/description/);
  });

  it('rejects burstiness out of [0, 1]', () => {
    const raw = buildScenario({
      tokenProfile: { corpus: 'default', baseTokenRate: 40, burstiness: 2, toolCallRatePerMin: 6 },
    });
    expect(() => validateScenario(raw)).toThrow(/burstiness/);
  });

  it('rejects negative at', () => {
    const raw = buildScenario({
      timeline: [{ at: -1, event: 'oops', payload: {} }],
    });
    expect(() => validateScenario(raw)).toThrow(/at/);
  });

  it('rejects non-array timeline', () => {
    const raw = { ...buildScenario(), timeline: 'not an array' };
    expect(() => validateScenario(raw)).toThrow(/timeline/);
  });
});

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

describe('loadCorpusFromText', () => {
  it('splits on whitespace', () => {
    const corpus = loadCorpusFromText('one  two\nthree\tfour');
    expect(corpus.words).toEqual(['one', 'two', 'three', 'four']);
  });

  it('throws on empty text', () => {
    expect(() => loadCorpusFromText('   \n  ')).toThrow(ScenarioValidationError);
  });
});

// ---------------------------------------------------------------------------
// Token arrival
// ---------------------------------------------------------------------------

describe('sampleTokensThisTick', () => {
  it('returns ~baseRate * dt on average at burstiness=0', () => {
    const rng = createSeededRng(1);
    const samples: number[] = [];
    for (let i = 0; i < 2000; i++) samples.push(sampleTokensThisTick(40, 0, rng));
    const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
    // 40 tok/s * 0.05s/tick = 2 tokens per tick expected mean.
    expect(mean).toBeGreaterThan(1.5);
    expect(mean).toBeLessThan(2.7);
  });

  it('produces higher variance at burstiness=1 than burstiness=0', () => {
    const runVar = (burstiness: number): number => {
      const rng = createSeededRng(42);
      const samples: number[] = [];
      for (let i = 0; i < 5000; i++) samples.push(sampleTokensThisTick(40, burstiness, rng));
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      return samples.reduce((acc, x) => acc + (x - mean) ** 2, 0) / samples.length;
    };
    const smooth = runVar(0);
    const bursty = runVar(1);
    expect(bursty).toBeGreaterThan(smooth);
  });

  it('is clamped to a sane maximum', () => {
    const rng = createSeededRng(7);
    for (let i = 0; i < 1000; i++) {
      const n = sampleTokensThisTick(1000, 1, rng);
      expect(n).toBeLessThanOrEqual(20);
    }
  });
});

// ---------------------------------------------------------------------------
// Runner: timeline firing
// ---------------------------------------------------------------------------

describe('createScenarioRunner: timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires timeline entries at their scheduled offsets under speed=1', () => {
    const scenario = buildScenario();
    const emitted: { at: number; event: string }[] = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 1 });
    runner.start((event) => emitted.push({ at: Date.now(), event }));

    const start = Date.now();
    vi.advanceTimersByTime(150);
    expect(emitted.filter((e) => e.event === 'workflow.started')).toHaveLength(1);
    expect(emitted.find((e) => e.event === 'workflow.started')!.at - start).toBe(100);

    vi.advanceTimersByTime(400);
    expect(emitted.filter((e) => e.event === 'workflow.state_entered')).toHaveLength(1);

    vi.advanceTimersByTime(1600);
    expect(emitted.filter((e) => e.event === 'workflow.agent_completed')).toHaveLength(1);

    runner.stop();
  });

  it('compresses timeline under speedMultiplier=2', () => {
    const scenario = buildScenario();
    const emitted: string[] = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 1, speedMultiplier: 2 });
    runner.start((event) => emitted.push(event));

    vi.advanceTimersByTime(55); // 100ms/2 + fudge
    expect(emitted).toContain('workflow.started');

    runner.stop();
  });
});

// ---------------------------------------------------------------------------
// Runner: token batches
// ---------------------------------------------------------------------------

describe('createScenarioRunner: token stream', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits token_stream events roughly every 50ms', () => {
    const scenario = buildScenario({
      tokenProfile: { corpus: 'default', baseTokenRate: 40, burstiness: 0, toolCallRatePerMin: 0 },
    });
    const tokenBatches: unknown[] = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 1 });
    runner.start((event, payload) => {
      if (event === 'session.token_stream') tokenBatches.push(payload);
    });

    vi.advanceTimersByTime(505);
    // 10 ticks at 50ms intervals. Some ticks may emit 0 events depending on
    // the RNG draw, but at 40 tok/s we expect most ticks to emit something.
    expect(tokenBatches.length).toBeGreaterThanOrEqual(6);
    expect(tokenBatches.length).toBeLessThanOrEqual(10);

    runner.stop();
  });

  it('token batches carry text_delta chunks', () => {
    const scenario = buildScenario({
      tokenProfile: { corpus: 'default', baseTokenRate: 40, burstiness: 0, toolCallRatePerMin: 0 },
    });
    const batches: Array<{ label: number; events: Array<{ kind: string }> }> = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 1 });
    runner.start((event, payload) => {
      if (event === 'session.token_stream') batches.push(payload as { label: number; events: Array<{ kind: string }> });
    });

    vi.advanceTimersByTime(200);
    runner.stop();

    const textDeltas = batches.flatMap((b) => b.events).filter((e) => e.kind === 'text_delta');
    expect(textDeltas.length).toBeGreaterThan(0);
  });

  it('produces tool_use events at approximately the configured rate', () => {
    const scenario = buildScenario({
      tokenProfile: { corpus: 'default', baseTokenRate: 0, burstiness: 0, toolCallRatePerMin: 60 },
    });
    const toolUses: unknown[] = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 1 });
    runner.start((event, payload) => {
      if (event === 'session.token_stream') {
        const p = payload as { events: Array<{ kind: string }> };
        for (const e of p.events) if (e.kind === 'tool_use') toolUses.push(e);
      }
    });

    vi.advanceTimersByTime(60_000);
    runner.stop();

    // At 60/min we expect ~60 tool uses in 60s; allow wide tolerance for Poisson variance.
    expect(toolUses.length).toBeGreaterThan(30);
    expect(toolUses.length).toBeLessThan(100);
  });

  it('emits tool_result after tool_use (paired)', () => {
    const scenario = buildScenario({
      tokenProfile: { corpus: 'default', baseTokenRate: 0, burstiness: 0, toolCallRatePerMin: 30 },
    });
    const kinds: string[] = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 3 });
    runner.start((event, payload) => {
      if (event === 'session.token_stream') {
        const p = payload as { events: Array<{ kind: string }> };
        for (const e of p.events) kinds.push(e.kind);
      }
    });

    vi.advanceTimersByTime(30_000);
    runner.stop();

    const toolUses = kinds.filter((k) => k === 'tool_use').length;
    const toolResults = kinds.filter((k) => k === 'tool_result').length;
    expect(toolUses).toBeGreaterThan(0);
    expect(toolResults).toBeGreaterThan(0);
    // Each tool_use should have a paired tool_result, modulo stop() timing.
    expect(Math.abs(toolUses - toolResults)).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Loop mode
// ---------------------------------------------------------------------------

describe('createScenarioRunner: loop mode', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('restarts from t=0 when loop=true', () => {
    const scenario = buildScenario({
      timeline: [
        { at: 100, event: 'workflow.started', payload: {} },
        { at: 1000, event: 'workflow.agent_completed', payload: {} },
      ],
    });
    const emitted: string[] = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 1, loop: true });
    runner.start((event) => emitted.push(event));

    // First iteration completes at t=1000; loop restart fires at t=1500.
    vi.advanceTimersByTime(1400);
    expect(emitted.filter((e) => e === 'workflow.started')).toHaveLength(1);
    expect(emitted.filter((e) => e === 'workflow.agent_completed')).toHaveLength(1);

    // Second iteration: workflow.started at t=1500+100=1600; completed at t=2500.
    vi.advanceTimersByTime(1200); // t=2600, past second iteration's completion
    expect(emitted.filter((e) => e === 'workflow.started')).toHaveLength(2);
    expect(emitted.filter((e) => e === 'workflow.agent_completed')).toHaveLength(2);

    runner.stop();
  });
});

// ---------------------------------------------------------------------------
// Stop semantics
// ---------------------------------------------------------------------------

describe('createScenarioRunner: stop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels scheduled timeline entries on stop', () => {
    const scenario = buildScenario();
    const emitted: string[] = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 1 });
    runner.start((event) => emitted.push(event));

    runner.stop();
    vi.advanceTimersByTime(5000);
    expect(emitted).toHaveLength(0);
  });

  it('stops emitting token events after stop()', () => {
    const scenario = buildScenario();
    const tokenBatches: unknown[] = [];
    const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed: 1 });
    runner.start((event, payload) => {
      if (event === 'session.token_stream') tokenBatches.push(payload);
    });

    vi.advanceTimersByTime(200);
    const countBeforeStop = tokenBatches.length;
    runner.stop();

    vi.advanceTimersByTime(1000);
    expect(tokenBatches.length).toBe(countBeforeStop);
  });

  it('isRunning reflects lifecycle state', () => {
    const runner = createScenarioRunner(buildScenario(), SIMPLE_CORPUS, { seed: 1 });
    expect(runner.isRunning()).toBe(false);
    runner.start(() => {});
    expect(runner.isRunning()).toBe(true);
    runner.stop();
    expect(runner.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('createScenarioRunner: seeded determinism', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('two runners with the same seed produce identical event sequences', () => {
    const scenario = buildScenario();
    const runOne = captureRun(scenario, 99);
    const runTwo = captureRun(scenario, 99);
    expect(runOne).toEqual(runTwo);
  });

  it('different seeds produce different sequences', () => {
    const scenario = buildScenario();
    const runOne = captureRun(scenario, 1);
    const runTwo = captureRun(scenario, 2);
    expect(runOne).not.toEqual(runTwo);
  });
});

function captureRun(scenario: Scenario, seed: number): string[] {
  const emitted: string[] = [];
  const runner = createScenarioRunner(scenario, SIMPLE_CORPUS, { seed, initialNowMs: 1_000_000 });
  runner.start((event, payload) => {
    // Stringify with stable key order so we can compare across runs.
    emitted.push(`${event}:${JSON.stringify(payload)}`);
  });
  vi.advanceTimersByTime(1500);
  runner.stop();
  return emitted;
}

// ---------------------------------------------------------------------------
// Scheduler injection sanity
// ---------------------------------------------------------------------------

describe('realScheduler', () => {
  it('wraps setTimeout/clearTimeout symmetrically', () => {
    const fn = vi.fn();
    const handle = realScheduler.setTimeout(fn, 100);
    realScheduler.clearTimeout(handle);
    // Nothing should fire -- assert via timing flush
    return new Promise((resolve) =>
      setTimeout(() => {
        expect(fn).not.toHaveBeenCalled();
        resolve(undefined);
      }, 150),
    );
  });
});
