/**
 * Synthetic scenario runner for the mock WS server.
 *
 * Loads a scenario JSON + corpus text, produces deterministic/reproducible
 * event emission with two interleaved tracks:
 *
 *   1. Timeline driver: scheduled `workflow.*` events at fixed wall-clock
 *      offsets (from the JSON `timeline` array).
 *   2. Token generator: `session.token_stream` batches emitted every
 *      TOKEN_BATCH_INTERVAL_MS, with corpus-sampled `text_delta` chunks and
 *      occasional Poisson-scheduled `tool_use`/`tool_result` pairs.
 *
 * The runner is a pure logic module -- the caller provides an `emit()` hook
 * and a `scheduler` (real or fake timers for tests).
 *
 * No runtime dependencies beyond the corpus RNG shared with matrix-rain.
 */

import type { RainRng } from '../src/lib/matrix-rain/engine.js';
import { createSeededRng } from '../src/lib/matrix-rain/engine.js';
import type { TokenStreamEvent as FrontendTokenStreamEvent } from '../src/lib/types.js';
import { makeAgentSessionEndedPayload } from './agent-session-events.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TokenProfile {
  readonly corpus: string;
  readonly baseTokenRate: number;
  readonly burstiness: number;
  readonly toolCallRatePerMin: number;
}

export interface TimelineEntry {
  readonly at: number;
  readonly event: string;
  readonly payload: unknown;
}

export interface Scenario {
  readonly description: string;
  readonly tokenProfile: TokenProfile;
  readonly timeline: readonly TimelineEntry[];
}

/** The three TokenStreamEvent variants this runner emits. Narrowed from the
 *  canonical union so contract changes surface here at compile time. */
export type TokenStreamEvent = Extract<FrontendTokenStreamEvent, { kind: 'text_delta' | 'tool_use' | 'tool_result' }>;

export type EmitFn = (event: string, payload: unknown) => void;

export interface ScenarioRunnerOptions {
  readonly speedMultiplier?: number;
  readonly loop?: boolean;
  /** Virtual clock origin (ms since epoch). Only used to stamp event.timestamp. */
  readonly initialNowMs?: number;
  /** Seed for the internal RNG. Omit to use Math.random. */
  readonly seed?: number;
  /**
   * Session label attached to `session.token_stream` payloads. Defaults to 1.
   * Real daemon uses monotonically increasing labels; the mock uses a fixed one.
   */
  readonly sessionLabel?: number;
}

export interface ScenarioRunner {
  readonly start: (emit: EmitFn) => void;
  readonly stop: () => void;
  readonly isRunning: () => boolean;
}

/**
 * Minimal scheduler interface so unit tests can inject fake timers without
 * coupling to `setTimeout`/`setInterval` globals. The mock server passes the
 * real globals.
 */
export interface Scheduler {
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly setInterval: (fn: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
  readonly now: () => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Real TokenStreamBridge batches at this cadence; we match it. */
const TOKEN_BATCH_INTERVAL_MS = 50;

/** Upper bound on tokens per 50ms tick -- guards against runaway bursts. */
const MAX_TOKENS_PER_TICK = 20;

/** How long after `tool_use` emission to fire the paired `tool_result`. */
const TOOL_RESULT_DELAY_MS = 200;

const SYNTHETIC_TOOLS = [
  'filesystem__read_file',
  'filesystem__write_file',
  'filesystem__list_directory',
  'git__log',
  'git__status',
  'git__diff',
];

// ---------------------------------------------------------------------------
// Default scheduler (wraps globals). Tests inject their own.
// ---------------------------------------------------------------------------

export const realScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export class ScenarioValidationError extends Error {
  constructor(message: string) {
    super(`Invalid scenario: ${message}`);
    this.name = 'ScenarioValidationError';
  }
}

/**
 * Hand-rolled shape validation. We deliberately avoid zod here -- the mock
 * server has no other zod usage and taking a dep for five fixture files isn't
 * worth it.
 */
export function validateScenario(raw: unknown): Scenario {
  if (typeof raw !== 'object' || raw === null) {
    throw new ScenarioValidationError('must be an object');
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.description !== 'string') {
    throw new ScenarioValidationError('description must be a string');
  }

  const profile = obj.tokenProfile;
  if (typeof profile !== 'object' || profile === null) {
    throw new ScenarioValidationError('tokenProfile must be an object');
  }
  const p = profile as Record<string, unknown>;
  if (typeof p.corpus !== 'string') throw new ScenarioValidationError('tokenProfile.corpus must be string');
  if (typeof p.baseTokenRate !== 'number' || p.baseTokenRate < 0) {
    throw new ScenarioValidationError('tokenProfile.baseTokenRate must be a non-negative number');
  }
  if (typeof p.burstiness !== 'number' || p.burstiness < 0 || p.burstiness > 1) {
    throw new ScenarioValidationError('tokenProfile.burstiness must be in [0, 1]');
  }
  if (typeof p.toolCallRatePerMin !== 'number' || p.toolCallRatePerMin < 0) {
    throw new ScenarioValidationError('tokenProfile.toolCallRatePerMin must be a non-negative number');
  }

  if (!Array.isArray(obj.timeline)) {
    throw new ScenarioValidationError('timeline must be an array');
  }
  const timeline: TimelineEntry[] = [];
  for (let i = 0; i < obj.timeline.length; i++) {
    const entry = obj.timeline[i];
    if (typeof entry !== 'object' || entry === null) {
      throw new ScenarioValidationError(`timeline[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.at !== 'number' || e.at < 0) {
      throw new ScenarioValidationError(`timeline[${i}].at must be a non-negative number`);
    }
    if (typeof e.event !== 'string') {
      throw new ScenarioValidationError(`timeline[${i}].event must be a string`);
    }
    timeline.push({ at: e.at, event: e.event, payload: e.payload });
  }

  return {
    description: obj.description,
    tokenProfile: {
      corpus: p.corpus,
      baseTokenRate: p.baseTokenRate,
      burstiness: p.burstiness,
      toolCallRatePerMin: p.toolCallRatePerMin,
    },
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Corpus
// ---------------------------------------------------------------------------

export interface Corpus {
  /** Flat list of tokens (words + punctuation) sampled uniformly at random. */
  readonly words: readonly string[];
}

export function loadCorpusFromText(text: string): Corpus {
  const words = text
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 0);
  if (words.length === 0) {
    throw new ScenarioValidationError('corpus text is empty');
  }
  return { words };
}

/**
 * Sample a variable-length chunk of corpus words. The visual design doesn't
 * care about semantic coherence -- just that batches feel like real LLM output.
 */
function sampleChunk(corpus: Corpus, rng: RainRng, minWords: number, maxWords: number): string {
  const span = maxWords - minWords;
  const n = minWords + Math.floor(rng.random() * (span + 1));
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const idx = Math.floor(rng.random() * corpus.words.length);
    parts.push(corpus.words[idx]);
  }
  return parts.join(' ') + ' ';
}

// ---------------------------------------------------------------------------
// Token arrival process
// ---------------------------------------------------------------------------

/**
 * Sample N tokens for the next `TOKEN_BATCH_INTERVAL_MS` window using a
 * burstiness-biased arrival process.
 *
 * At burstiness=0, emission is near-uniform: draws from Poisson(mean=rate*dt).
 * At burstiness=1, draws from a heavy-tailed distribution: most ticks emit 0,
 * occasional ticks emit many. We approximate this by multiplying the mean by
 * a uniform [0.5, 2] factor gated on the burstiness -- mathematically not a
 * true Poisson mixture, but visually indistinguishable and cheap.
 *
 * Returned value is clamped to [0, MAX_TOKENS_PER_TICK].
 */
export function sampleTokensThisTick(baseRate: number, burstiness: number, rng: RainRng): number {
  const meanPerTick = (baseRate * TOKEN_BATCH_INTERVAL_MS) / 1000;

  // Burstiness modulates variance: at b=0, factor is 1; at b=1, factor ranges
  // ~[0.1, 4] with heavy skew toward the extremes.
  const bias = rng.random();
  const factor = burstiness === 0 ? 1 : 1 + burstiness * (bias < 0.5 ? -0.95 * (1 - bias * 2) : 3 * (bias * 2 - 1));

  const mean = Math.max(0, meanPerTick * factor);
  // Cheap Poisson approximation via Knuth's method. Small mean -> fast.
  const n = poissonSample(mean, rng);
  return Math.min(n, MAX_TOKENS_PER_TICK);
}

function poissonSample(mean: number, rng: RainRng): number {
  if (mean <= 0) return 0;
  // For large means the Knuth loop can slow; clamp to a reasonable upper
  // bound since our rate * dt is small anyway.
  const L = Math.exp(-Math.min(mean, 30));
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rng.random();
  } while (p > L && k < 100);
  return k - 1;
}

// ---------------------------------------------------------------------------
// Runner factory
// ---------------------------------------------------------------------------

export function createScenarioRunner(
  scenario: Scenario,
  corpus: Corpus,
  options: ScenarioRunnerOptions = {},
  scheduler: Scheduler = realScheduler,
): ScenarioRunner {
  const speed = options.speedMultiplier ?? 1;
  const loop = options.loop ?? false;
  const sessionLabel = options.sessionLabel ?? 1;
  const seed = options.seed;

  // The RNG is reset on each loop iteration if seeded -- determinism requires
  // repeatable draws within an iteration, not across iterations.
  const makeRng = (): RainRng => (seed !== undefined ? createSeededRng(seed) : { random: () => Math.random() });

  let rng = makeRng();
  let emit: EmitFn | null = null;
  let running = false;

  // Active timer handles -- cleared on stop().
  const timeouts: unknown[] = [];
  let tokenTicker: unknown = null;
  let nextToolUseAt = 0;
  let toolUseCounter = 0;
  let iterationStartVirtualMs = 0;
  let iterationCounter = 0;

  function scheduleTimeline(): void {
    const maxAt = scenario.timeline.reduce((max, entry) => Math.max(max, entry.at), 0);
    // Track synthetic sessionIds per (workflowId, stateId) so we can inject
    // them into agent_started payloads and emit a paired agent_session_ended
    // on the matching agent_completed or state_failed. Mirrors the daemon's
    // "finally" emission pattern so the mock is protocol-faithful.
    const activeSessions = new Map<string, string>();
    const sessionKey = (workflowId: string, stateId: string): string => `${workflowId}::${stateId}`;

    for (const entry of scenario.timeline) {
      const delayMs = entry.at / speed;
      const handle = scheduler.setTimeout(() => {
        if (!running || !emit) return;

        if (entry.event === 'workflow.agent_started') {
          const p = (entry.payload ?? {}) as { workflowId?: string; stateId?: string };
          if (p.workflowId && p.stateId) {
            const sid = `${p.workflowId}-${p.stateId}-${iterationCounter}-${scheduler.now()}`;
            activeSessions.set(sessionKey(p.workflowId, p.stateId), sid);
            emit(entry.event, { ...p, sessionId: sid });
            return;
          }
        }

        emit(entry.event, entry.payload);

        if (entry.event === 'workflow.agent_completed' || entry.event === 'workflow.state_failed') {
          const p = (entry.payload ?? {}) as { workflowId?: string; stateId?: string; state?: string };
          const stateId = p.stateId ?? p.state;
          if (p.workflowId && stateId) {
            const key = sessionKey(p.workflowId, stateId);
            const sid = activeSessions.get(key);
            if (sid !== undefined) {
              activeSessions.delete(key);
              emit('workflow.agent_session_ended', makeAgentSessionEndedPayload(p.workflowId, stateId, sid));
            }
          }
        }
      }, delayMs);
      timeouts.push(handle);
    }

    if (loop && maxAt > 0) {
      const restartMs = (maxAt + 500) / speed;
      const handle = scheduler.setTimeout(() => {
        if (!running) return;
        iterationCounter++;
        iterationStartVirtualMs = scheduler.now();
        rng = makeRng(); // reset RNG so each loop iteration is deterministic
        nextToolUseAt = sampleNextToolUseOffset();
        timeouts.length = 0;
        scheduleTimeline();
      }, restartMs);
      timeouts.push(handle);
    }
  }

  function sampleNextToolUseOffset(): number {
    const ratePerMin = scenario.tokenProfile.toolCallRatePerMin;
    if (ratePerMin <= 0) return Number.POSITIVE_INFINITY;
    // Exponential inter-arrival time: -ln(U)/lambda, lambda in 1/ms.
    const lambda = ratePerMin / 60000;
    const u = Math.max(rng.random(), 1e-9);
    return -Math.log(u) / lambda;
  }

  function tokenTick(): void {
    if (!running || !emit) return;

    const nowVirtual = scheduler.now() - iterationStartVirtualMs;
    const events: TokenStreamEvent[] = [];

    const tokensThisTick = sampleTokensThisTick(
      scenario.tokenProfile.baseTokenRate,
      scenario.tokenProfile.burstiness,
      rng,
    );
    if (tokensThisTick > 0) {
      // Convert token count into 1-N chunks of variable word length so the
      // consumer sees the kind of variable-size text_delta batches a real
      // LLM would produce.
      const chunkCount = 1 + Math.floor(rng.random() * 2); // 1 or 2 chunks
      const perChunk = Math.max(1, Math.floor(tokensThisTick / chunkCount));
      for (let i = 0; i < chunkCount; i++) {
        const text = sampleChunk(corpus, rng, perChunk, perChunk + 3);
        events.push({
          kind: 'text_delta',
          text,
          timestamp: (options.initialNowMs ?? Date.now()) + nowVirtual,
        });
      }
    }

    // Tool calls: fire when we've crossed the next-tool-use wall-clock mark.
    while (nowVirtual >= nextToolUseAt && nextToolUseAt !== Number.POSITIVE_INFINITY) {
      const toolName = SYNTHETIC_TOOLS[Math.floor(rng.random() * SYNTHETIC_TOOLS.length)];
      const toolUseId = `tool-${++toolUseCounter}`;
      events.push({
        kind: 'tool_use',
        toolName,
        inputDelta: JSON.stringify({ path: `./src/module-${toolUseCounter}.ts` }),
        timestamp: (options.initialNowMs ?? Date.now()) + nowVirtual,
      });

      // Schedule the paired tool_result. The result content is hand-rolled;
      // the visualization doesn't read the text, but future chunks may.
      const resultHandle = scheduler.setTimeout(() => {
        if (!running || !emit) return;
        emit('session.token_stream', {
          label: sessionLabel,
          events: [
            {
              kind: 'tool_result',
              toolUseId,
              toolName,
              content: sampleChunk(corpus, rng, 4, 10),
              isError: false,
              timestamp: (options.initialNowMs ?? Date.now()) + (scheduler.now() - iterationStartVirtualMs),
            },
          ],
        });
      }, TOOL_RESULT_DELAY_MS / speed);
      timeouts.push(resultHandle);

      nextToolUseAt += sampleNextToolUseOffset();
    }

    if (events.length > 0) {
      emit('session.token_stream', { label: sessionLabel, events });
    }
  }

  function start(emitFn: EmitFn): void {
    if (running) return;
    running = true;
    emit = emitFn;
    iterationStartVirtualMs = scheduler.now();
    iterationCounter = 0;
    toolUseCounter = 0;
    nextToolUseAt = sampleNextToolUseOffset();
    scheduleTimeline();
    tokenTicker = scheduler.setInterval(tokenTick, TOKEN_BATCH_INTERVAL_MS);
  }

  function stop(): void {
    if (!running) return;
    running = false;
    emit = null;
    for (const h of timeouts) scheduler.clearTimeout(h);
    timeouts.length = 0;
    if (tokenTicker !== null) {
      scheduler.clearInterval(tokenTicker);
      tokenTicker = null;
    }
  }

  return {
    start,
    stop,
    isRunning: () => running,
  };
}
