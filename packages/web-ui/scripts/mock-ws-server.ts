/**
 * Mock WebSocket server for web UI development and testing.
 *
 * Speaks the same JSON-RPC protocol as the real daemon, returning canned
 * data and emitting scripted event sequences with realistic timing.
 *
 * Usage:
 *   cd packages/web-ui && npm run mock-server
 *   cd packages/web-ui && npm run mock-server -- --replay
 *   cd packages/web-ui && npm run mock-server -- --replay --replay-file path/to/messages.jsonl
 *   # Then in another terminal: npm run dev
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { loadReplayPlan, createReplayController, type ReplayController, type ReplayPlan } from './replay-engine.js';
import { makeAgentSessionEndedPayload } from './agent-session-events.js';

// ---------------------------------------------------------------------------
// Types (mirrors the daemon protocol without importing from src/)
// ---------------------------------------------------------------------------

interface RequestFrame {
  readonly id: string;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

interface ResponseFrame {
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: { readonly code: string; readonly message: string };
}

interface EventFrame {
  readonly event: string;
  readonly payload: unknown;
  readonly seq: number;
}

interface MockSession {
  label: number;
  turnCount: number;
  createdAt: string;
  status: string;
  persona?: string;
  totalTokens: number;
  stepCount: number;
  estimatedCostUsd: number;
  /** True for a container-mode `web-pty` (terminal) session. */
  isPty?: boolean;
  /** ISO timestamp of the most recent ptyAttach (web-pty only). */
  lastAttachedAt?: string;
}

interface MockWhitelistCandidate {
  description: string;
}

interface MockEscalation {
  escalationId: string;
  sessionLabel: number;
  toolName: string;
  serverName: string;
  arguments: Record<string, unknown>;
  reason: string;
  whitelistCandidates?: MockWhitelistCandidate[];
  receivedAt: string;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? '7400', 10);
const MOCK_TOKEN = 'mock-dev-token';
const startTime = Date.now();

// ---------------------------------------------------------------------------
// PTY (Container Agent Mode) simulation
//
// The mock mirrors the current daemon launcher: new browser sessions are always
// live `web-pty` terminals. Chatbox/session-console launch modes are not
// available.
// ---------------------------------------------------------------------------

interface ResetOptions {
  allowPolicyMutation?: boolean;
}

/** base64 of the UTF-8 bytes of a terminal string (matches the daemon framing). */
function b64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64');
}

// A full-screen ANSI snapshot sent on attach (mirrors a serialize() replay).
const PTY_BANNER =
  '\x1b[2J\x1b[H' +
  '\x1b[1;36m┌─ IronCurtain PTY (mock) ─────────────────────────────┐\x1b[0m\r\n' +
  '\x1b[1;36m│\x1b[0m  Claude Code in a --network=none container (fake)   \x1b[1;36m│\x1b[0m\r\n' +
  '\x1b[1;36m└──────────────────────────────────────────────────────┘\x1b[0m\r\n' +
  '\r\n' +
  'Type to send keystrokes. Type "escalate" to trigger an escalation.\r\n' +
  '\r\n\x1b[32m$\x1b[0m ';

const PTY_SPINNER = ['|', '/', '-', '\\'];

// Per-label fake-TUI frame timers. A single interval per attached label repaints
// a bottom status line; cleared on detach / end / reset.
const ptyTimers = new Map<number, ReturnType<typeof setInterval>>();

function buildPtyFrame(tick: number): string {
  const spin = PTY_SPINNER[tick % PTY_SPINNER.length];
  // Save cursor, jump to the bottom row, clear it, paint a status line, restore.
  return `\x1b7\x1b[999;1H\x1b[2K\x1b[33m[mock] agent working ${spin}  frame ${tick}\x1b[0m\x1b8`;
}

function startPtyFrames(label: number): void {
  if (ptyTimers.has(label)) return;
  let tick = 0;
  const timer = setInterval(() => {
    tick++;
    broadcast('session.pty_output', { label, data: b64(buildPtyFrame(tick)) });
  }, 1000);
  ptyTimers.set(label, timer);
}

function stopPtyFrames(label: number): void {
  const timer = ptyTimers.get(label);
  if (timer) {
    clearInterval(timer);
    ptyTimers.delete(label);
  }
}

function stopAllPtyFrames(): void {
  for (const timer of ptyTimers.values()) clearInterval(timer);
  ptyTimers.clear();
}

// ---------------------------------------------------------------------------
// Replay mode CLI parsing
// ---------------------------------------------------------------------------

interface ReplayConfig {
  readonly jsonlPath: string;
  readonly definitionPath: string;
  readonly speedup: number;
}

const __scriptDir = dirname(fileURLToPath(import.meta.url));

function parseReplayArgs(): ReplayConfig | null {
  const { values } = parseArgs({
    options: {
      replay: { type: 'boolean', default: false },
      'replay-file': { type: 'string', default: undefined },
      definition: { type: 'string', default: undefined },
      speedup: { type: 'string', default: '50' },
    },
    allowPositionals: true,
    strict: false,
  });

  // --replay enables replay mode. --replay-file=<path> specifies a custom JSONL.
  // Bare --replay uses the bundled example files.
  if (!values.replay) return null;

  const defaultJsonl = resolve(__scriptDir, '../workflow-example-messages.jsonl');
  const defaultDef = resolve(__scriptDir, '../workflow-example-definition.json');

  const replayFile = values['replay-file'];
  let jsonlPath = typeof replayFile === 'string' && replayFile !== '' ? resolve(replayFile) : defaultJsonl;
  let definitionPath = defaultDef;

  // Look for definition adjacent to a custom JSONL file
  if (jsonlPath !== defaultJsonl) {
    const adjacentDef = resolve(dirname(jsonlPath), 'workflow-example-definition.json');
    const adjacentDef2 = resolve(dirname(jsonlPath), 'definition.json');
    if (existsSync(adjacentDef)) {
      definitionPath = adjacentDef;
    } else if (existsSync(adjacentDef2)) {
      definitionPath = adjacentDef2;
    }
  }

  // Explicit definition override
  const definition = values.definition;
  if (typeof definition === 'string' && definition !== '') {
    definitionPath = resolve(definition);
  }

  // Speedup factor
  const speedupValue = typeof values.speedup === 'string' ? values.speedup : '50';
  const speedup = Math.max(1, parseInt(speedupValue, 10) || 50);

  return { jsonlPath, definitionPath, speedup };
}

const replayConfig = parseReplayArgs();
const replayPlan: ReplayPlan | null = replayConfig
  ? loadReplayPlan(replayConfig.jsonlPath, replayConfig.definitionPath)
  : null;
let replayController: ReplayController | null = null;

let nextLabel = 1;
let eventSeq = 0;
const sessions = new Map<number, MockSession>();
const escalations = new Map<string, MockEscalation>();
const clients = new Set<WebSocket>();

// ---------------------------------------------------------------------------
// Canned data
// ---------------------------------------------------------------------------

const CANNED_RESPONSES = [
  `## Analysis Complete

Here's what I found in the codebase:

- **12 source files** modified in the last commit
- The \`PolicyEngine\` class handles all authorization decisions
- No security vulnerabilities detected

\`\`\`typescript
const result = engine.evaluate(request);
console.log(result.decision); // 'allow' | 'deny' | 'escalate'
\`\`\`

| File | Lines Changed | Status |
|------|--------------|--------|
| policy-engine.ts | +42 / -8 | Modified |
| types.ts | +15 / -3 | Modified |
| index.ts | +5 / -1 | Modified |`,

  `I've completed the requested changes. Here's a summary:

1. **Added input validation** to the \`createSession\` handler
2. **Fixed the race condition** in the WebSocket reconnection logic
3. Updated **3 test files** to cover the new edge cases

> Note: The budget tracker now correctly resets when a session is recycled.

All tests pass locally. Ready for review.`,

  `### Dependencies Audit

Found **2 outdated** packages:

\`\`\`
ws           8.16.0  ->  8.18.0  (minor)
typescript   5.6.0   ->  5.7.2   (minor)
\`\`\`

No **critical vulnerabilities** detected. The \`ws\` update includes a performance improvement for large payloads.

**Recommendation**: Update both packages. Neither has breaking changes.`,
];

const CANNED_HISTORY = [
  {
    turnNumber: 1,
    userMessage: 'Scan the codebase for any security vulnerabilities in the auth module.',
    assistantResponse: CANNED_RESPONSES[0],
    timestamp: new Date(Date.now() - 600_000).toISOString(),
    usage: {
      promptTokens: 1200,
      completionTokens: 850,
      totalTokens: 2050,
      cacheReadTokens: 400,
      cacheWriteTokens: 200,
    },
  },
  {
    turnNumber: 2,
    userMessage: 'Fix the race condition you found in the WebSocket reconnect logic.',
    assistantResponse: CANNED_RESPONSES[1],
    timestamp: new Date(Date.now() - 300_000).toISOString(),
    usage: {
      promptTokens: 2800,
      completionTokens: 1100,
      totalTokens: 3900,
      cacheReadTokens: 1800,
      cacheWriteTokens: 0,
    },
  },
  {
    turnNumber: 3,
    userMessage: 'Check for outdated dependencies and recommend updates.',
    assistantResponse: CANNED_RESPONSES[2],
    timestamp: new Date(Date.now() - 60_000).toISOString(),
    usage: { promptTokens: 1500, completionTokens: 600, totalTokens: 2100, cacheReadTokens: 900, cacheWriteTokens: 0 },
  },
];

const CANNED_DIAGNOSTICS = [
  { kind: 'tool_call' as const, toolName: 'filesystem__read_file', preview: 'Reading ./src/auth/middleware.ts' },
  { kind: 'tool_call' as const, toolName: 'filesystem__list_directory', preview: 'Listing ./src/auth/' },
  { kind: 'step_finish' as const, stepIndex: 1 },
  { kind: 'agent_text' as const, preview: 'Analyzing authentication flow...' },
  { kind: 'tool_call' as const, toolName: 'filesystem__write_file', preview: 'Writing ./src/auth/middleware.ts' },
  { kind: 'budget_warning' as const, dimension: 'tokens', percentUsed: 78, message: 'Token usage at 78% of limit' },
  { kind: 'step_finish' as const, stepIndex: 2 },
];

const CANNED_RUN_RECORDS = [
  {
    startedAt: new Date(Date.now() - 86400_000).toISOString(),
    completedAt: new Date(Date.now() - 86400_000 + 45_000).toISOString(),
    outcome: { kind: 'success' },
    budget: { totalTokens: 24500, stepCount: 12, elapsedSeconds: 45, estimatedCostUsd: 0.08 },
    summary: 'Daily scan complete. No vulnerabilities found.',
  },
  {
    startedAt: new Date(Date.now() - 172800_000).toISOString(),
    completedAt: new Date(Date.now() - 172800_000 + 90_000).toISOString(),
    outcome: { kind: 'error', message: 'Connection to npm registry timed out' },
    budget: { totalTokens: 8200, stepCount: 5, elapsedSeconds: 90, estimatedCostUsd: 0.03 },
    summary: null,
  },
  {
    startedAt: new Date(Date.now() - 259200_000).toISOString(),
    completedAt: new Date(Date.now() - 259200_000 + 1800_000).toISOString(),
    outcome: { kind: 'budget_exhausted', dimension: 'tokens' },
    budget: { totalTokens: 1000000, stepCount: 198, elapsedSeconds: 1800, estimatedCostUsd: 4.95 },
    summary: 'Partial scan completed before token budget was exhausted.',
  },
];

const CANNED_JOBS = [
  {
    job: {
      id: 'daily-security-scan',
      name: 'Daily Security Scan',
      schedule: '0 2 * * *',
      taskDescription: 'Scan codebase for security vulnerabilities and outdated dependencies',
      enabled: true,
    },
    nextRun: new Date(Date.now() + 3600_000).toISOString(),
    lastRun: {
      startedAt: new Date(Date.now() - 86400_000).toISOString(),
      completedAt: new Date(Date.now() - 86400_000 + 45_000).toISOString(),
      outcome: { kind: 'success' },
      budget: { totalTokens: 24500, stepCount: 12, elapsedSeconds: 45, estimatedCostUsd: 0.08 },
      summary: 'No vulnerabilities found. All dependencies up to date.',
    },
    isRunning: false,
  },
  {
    job: {
      id: 'weekly-report',
      name: 'Weekly Status Report',
      schedule: '0 9 * * 1',
      taskDescription: 'Generate a weekly summary of all changes and incidents',
      enabled: true,
    },
    nextRun: new Date(Date.now() + 259200_000).toISOString(),
    lastRun: null,
    isRunning: false,
  },
  {
    job: {
      id: 'code-review-helper',
      name: 'PR Review Helper',
      schedule: '*/30 * * * *',
      taskDescription: 'Review open pull requests and leave comments',
      enabled: false,
    },
    nextRun: null,
    lastRun: {
      startedAt: new Date(Date.now() - 172800_000).toISOString(),
      completedAt: new Date(Date.now() - 172800_000 + 120_000).toISOString(),
      outcome: { kind: 'failure', message: 'API rate limit exceeded' },
      budget: { totalTokens: 8200, stepCount: 5, elapsedSeconds: 120, estimatedCostUsd: 0.03 },
      summary: null,
    },
    isRunning: false,
  },
];

interface MockPersonaListItem {
  name: string;
  description: string;
  compiled: boolean;
  memory?: boolean;
}

let CANNED_PERSONAS: MockPersonaListItem[] = [
  { name: 'default', description: 'General-purpose assistant with standard policy', compiled: true },
  { name: 'researcher', description: 'Read-only access focused on code analysis', compiled: true },
  { name: 'devops', description: 'Infrastructure and deployment operations', compiled: false },
  // Sentinel persona whose compileStream preflight reports CREDENTIALS_MISSING,
  // so the e2e suite can render the typed credentials affordance.
  { name: 'no-creds', description: 'Persona missing model credentials (test sentinel)', compiled: false },
  // Sentinel persona whose compile never reaches a terminal phase, so it stays
  // in `active` -- used to test reconnect rehydration of an in-flight card.
  { name: 'slow-compile', description: 'Persona with a never-finishing compile (test sentinel)', compiled: false },
  // Sentinel persona whose compile starts then emits persona.compile.failed,
  // so the e2e suite can render the post-start failure affordance.
  { name: 'fail-compile', description: 'Persona whose compile fails after starting (test sentinel)', compiled: false },
];

// ---------------------------------------------------------------------------
// Persona streamed-compile state (Phase 1b)
//
// Mirrors the daemon's persona-compile-orchestrator: an `active` map of live
// operations and a bounded `recent` map of terminal records, both keyed by
// operationId. compileStream broadcasts started -> progress(x2) -> done and
// writes the terminal record into `recent` at/just-before `done` so a
// post-completion getCompile and a reconnect-time listCompiles both return a
// real record.
// ---------------------------------------------------------------------------

type MockCompilationPhase =
  | 'cached'
  | 'compiling'
  | 'lists'
  | 'scenarios'
  | 'repair-scenarios'
  | 'verifying'
  | 'repair-compile'
  | 'repair-verify'
  | 'done';

interface MockRuleDelta {
  added: number;
  loosened: number;
  removed: number;
  broadenedDomains: string[];
  outOfWorkspacePaths: string[];
}

interface MockCompileOperation {
  operationId: string;
  name: string;
  phase: 'started' | 'running' | 'done' | 'failed';
  serverProgress?: { server: string; compilationPhase: MockCompilationPhase; detail?: string };
  queuePosition?: number;
  startedAt: string;
  endedAt?: string;
  result?: { success: true; ruleCount: number; ruleDelta?: MockRuleDelta };
  error?: { code: string; message: string };
  actor: string;
}

const activeCompiles = new Map<string, MockCompileOperation>();
const recentCompiles = new Map<string, MockCompileOperation>();
const RECENT_COMPILES_CAP = 50;
let compileOpSeq = 0;
const compileTimers: ReturnType<typeof setTimeout>[] = [];

// Default-true in the mock so the e2e happy-path works (a flag-OFF override is
// a 1c concern). Drives the POLICY_MUTATION_FORBIDDEN gate on compileStream.
let allowPolicyMutation = true;

function mintOperationId(): string {
  return `mock-op-${Date.now()}-${++compileOpSeq}`;
}

function recordRecentCompile(op: MockCompileOperation): void {
  recentCompiles.set(op.operationId, op);
  // Bounded LRU: drop oldest insertion-order entries when over cap.
  while (recentCompiles.size > RECENT_COMPILES_CAP) {
    const oldest = recentCompiles.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    recentCompiles.delete(oldest);
  }
}

function clearCompileState(): void {
  for (const t of compileTimers) clearTimeout(t);
  compileTimers.length = 0;
  activeCompiles.clear();
  recentCompiles.clear();
  compileOpSeq = 0;
  allowPolicyMutation = true;
  // Full restore of the persona list + details mutated by simulateCompile and
  // the Phase 1c CRUD handlers (create/delete/edit/memory/broad-policy).
  CANNED_PERSONAS = structuredClone(ORIGINAL_PERSONAS_LIST);
  CANNED_PERSONA_DETAILS = structuredClone(ORIGINAL_PERSONA_DETAILS_FULL);
}

interface MockPersonaDetail {
  name: string;
  description: string;
  createdAt: string;
  constitution: string;
  servers?: string[];
  hasPolicy: boolean;
  policyRuleCount?: number;
  memory: boolean;
  allowBroadPolicy: boolean;
}

let CANNED_PERSONA_DETAILS: Record<string, MockPersonaDetail> = {
  default: {
    name: 'default',
    description: 'General-purpose assistant with standard policy',
    createdAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
    constitution:
      '# Default Persona\n\n## Principles\n\n- Allow read operations on all files\n- Escalate write operations to protected paths\n- Allow git read operations\n- Escalate destructive git operations\n',
    servers: ['filesystem', 'git'],
    hasPolicy: true,
    policyRuleCount: 12,
    memory: true,
    allowBroadPolicy: false,
  },
  researcher: {
    name: 'researcher',
    description: 'Read-only access focused on code analysis',
    createdAt: new Date(Date.now() - 14 * 86400_000).toISOString(),
    constitution:
      '# Researcher Persona\n\n## Principles\n\n- Allow all read operations\n- Deny all write operations\n- Allow search and analysis tools\n',
    servers: ['filesystem'],
    hasPolicy: true,
    policyRuleCount: 8,
    memory: true,
    allowBroadPolicy: false,
  },
  devops: {
    name: 'devops',
    description: 'Infrastructure and deployment operations',
    createdAt: new Date(Date.now() - 7 * 86400_000).toISOString(),
    constitution:
      '# DevOps Persona\n\n## Principles\n\n- Allow Docker operations\n- Allow deployment scripts\n- Escalate infrastructure changes\n',
    servers: ['filesystem', 'git', 'github'],
    hasPolicy: false,
    memory: true,
    allowBroadPolicy: false,
  },
  'no-creds': {
    name: 'no-creds',
    description: 'Persona missing model credentials (test sentinel)',
    createdAt: new Date(Date.now() - 2 * 86400_000).toISOString(),
    constitution: '# No-Creds Persona\n\n## Principles\n\n- Allow read operations\n',
    servers: ['filesystem'],
    hasPolicy: false,
    memory: true,
    allowBroadPolicy: false,
  },
  'slow-compile': {
    name: 'slow-compile',
    description: 'Persona with a never-finishing compile (test sentinel)',
    createdAt: new Date(Date.now() - 1 * 86400_000).toISOString(),
    constitution: '# Slow Compile Persona\n\n## Principles\n\n- Allow read operations\n',
    servers: ['filesystem'],
    hasPolicy: false,
    memory: true,
    allowBroadPolicy: false,
  },
  'fail-compile': {
    name: 'fail-compile',
    description: 'Persona whose compile fails after starting (test sentinel)',
    createdAt: new Date(Date.now() - 1 * 86400_000).toISOString(),
    constitution: '# Fail Compile Persona\n\n## Principles\n\n- Allow read operations\n',
    servers: ['filesystem'],
    hasPolicy: false,
    memory: true,
    allowBroadPolicy: false,
  },
};

// Deep snapshots of the original persona list + details so resetState can
// restore them after create/delete/edit mutate the in-memory copies.
const ORIGINAL_PERSONAS_LIST: MockPersonaListItem[] = structuredClone(CANNED_PERSONAS);
const ORIGINAL_PERSONA_DETAILS_FULL: Record<string, MockPersonaDetail> = structuredClone(CANNED_PERSONA_DETAILS);

// ---------------------------------------------------------------------------
// Model-provider profiles (config.getModelProviders / config.setModelProviders).
//
// Mirrors the daemon's config-dispatch contract (§12.6): the get response masks
// every openrouter profile's apiKey and includes the implicit `native` profile;
// the set path applies M5 (per-profile mask-unchanged/clear/set), F7 (drop a
// verbatim {type:'native'}, reject any other native value), and F10 (re-point a
// dropped default to 'native'). State holds the REAL keys; the wire always masks.
// ---------------------------------------------------------------------------

const NATIVE_NAME = 'native';
const DOCKER_AGENTS = ['claude-code', 'goose', 'codex'] as const;

interface MockOpenrouterProfile {
  type: 'openrouter';
  apiKey?: string;
  modelMap?: { match: string; model: string }[];
  perAgent?: Record<string, string>;
  providerPreference?: { order?: string[]; only?: string[]; allowFallbacks?: boolean };
  sessionAffinity?: boolean;
}
type MockStoredProfile = { type: 'native' } | MockOpenrouterProfile;

interface MockModelProviders {
  default: string;
  profiles: Record<string, MockStoredProfile>;
}

const DEFAULT_MODEL_MAP = [
  { match: '*opus*', model: 'z-ai/glm-5.2' },
  { match: '*sonnet*', model: 'z-ai/glm-5.2' },
  { match: '*haiku*', model: 'z-ai/glm-5.2' },
];

/** The stored config (REAL keys). The wire representation masks apiKey. */
let modelProviders: MockModelProviders = {
  default: 'glm-5.2',
  profiles: {
    'glm-5.2': {
      type: 'openrouter',
      apiKey: 'sk-or-v1-glmMOCKkey000000000000000000end',
      modelMap: [
        { match: '*opus*', model: 'z-ai/glm-5.2' },
        { match: '*sonnet*', model: 'z-ai/glm-5.2' },
      ],
      perAgent: { goose: 'z-ai/glm-5.2', codex: 'z-ai/glm-5.2' },
      providerPreference: { order: ['z-ai'], allowFallbacks: false },
      sessionAffinity: true,
    },
    kimi: {
      type: 'openrouter',
      modelMap: [{ match: '*', model: 'moonshot/kimi-k3' }],
    },
  },
};

const ORIGINAL_MODEL_PROVIDERS: MockModelProviders = structuredClone(modelProviders);

// ---------------------------------------------------------------------------
// OpenRouter model catalog (config.listOpenrouterModels).
//
// A realistic slug set for offline autocomplete/validation dev + demo. It MUST
// include every slug referenced by the canned profiles above (z-ai/glm-5.2,
// moonshot/kimi-k3) plus every DEFAULT_MODEL_MAP target, so opening/saving the
// seeded profiles never hard-blocks.
//
// The reported `source` defaults to 'live' so the HARD-BLOCK path is demoable
// offline (type a garbage slug -> see it blocked). Set the env var
// MOCK_OPENROUTER_SOURCE=bundled to reach the warn-degrade path (unknown slugs
// allowed), or =cache/=live for the authoritative path — all without a real daemon.
// ---------------------------------------------------------------------------

const MOCK_SLUGS: readonly string[] = [
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-opus-4.1',
  'anthropic/claude-sonnet-4.5',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-r1',
  'deepseek/deepseek-v3',
  'google/gemini-2.0-flash',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-pro',
  'moonshot/kimi-k3',
  'moonshotai/kimi-k2',
  'openai/gpt-4.1',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-5',
  'openai/o3',
  'openai/o4-mini',
  'x-ai/grok-4',
  'z-ai/glm-4.5',
  'z-ai/glm-4.6',
  'z-ai/glm-5.2',
];

function resolveMockOpenrouterSource(): 'live' | 'cache' | 'bundled' {
  const v = process.env.MOCK_OPENROUTER_SOURCE;
  if (v === 'bundled' || v === 'cache' || v === 'live') return v;
  return 'live';
}

/** Mirrors maskApiKey in config-command.ts / config-dispatch.ts (`sk-...xyz` / 'none'). */
function maskApiKey(key: string | undefined): string {
  if (!key) return 'none';
  if (key.length <= 6) return '***';
  return key.slice(0, 3) + '...' + key.slice(-3);
}

/** The resolved (defaults-applied) view of one stored openrouter profile. */
function resolveOpenrouter(p: MockOpenrouterProfile) {
  const perAgent: Record<string, string | undefined> = {};
  for (const agent of DOCKER_AGENTS) perAgent[agent] = p.perAgent?.[agent];
  return {
    type: 'openrouter' as const,
    apiKey: maskApiKey(p.apiKey),
    modelMap: (p.modelMap ?? DEFAULT_MODEL_MAP).map((r) => ({ match: r.match, model: r.model })),
    perAgent,
    providerPreference: p.providerPreference,
    sessionAffinity: p.sessionAffinity ?? true,
  };
}

/** Builds the masked GetModelProvidersDto (native always present, key-less). */
function buildModelProvidersDto() {
  const profiles: Record<string, unknown> = { [NATIVE_NAME]: { type: 'native' } };
  for (const [name, prof] of Object.entries(modelProviders.profiles)) {
    if (name === NATIVE_NAME) continue;
    profiles[name] = prof.type === 'openrouter' ? resolveOpenrouter(prof) : { type: 'native' };
  }
  return { default: modelProviders.default, profiles };
}

/**
 * Applies a config.setModelProviders request to `modelProviders`. Returns an
 * RpcError sentinel on a contract violation (reserved-native, bad default),
 * else undefined. Mirrors config-dispatch.ts exactly.
 */
function applySetModelProviders(params: Record<string, unknown>): RpcErrorResult | undefined {
  // Mirror the daemon's `z.record(...)` contract: `profiles` is required and
  // must be a plain object. `typeof x === 'object'` alone would let arrays (and
  // formerly null) through — `profiles: []` would be read as numeric profile
  // names and silently accepted, masking frontend/server contract bugs in e2e.
  const rawProfiles = params.profiles;
  if (typeof rawProfiles !== 'object' || rawProfiles === null || Array.isArray(rawProfiles)) {
    return errorResult('INVALID_PARAMS', 'profiles is required');
  }
  const inProfiles = rawProfiles as Record<string, Record<string, unknown>>;

  const priorNames = Object.keys(modelProviders.profiles);
  const next: Record<string, MockStoredProfile> = {};

  for (const [name, dto] of Object.entries(inProfiles)) {
    if (name === NATIVE_NAME) {
      // F7: accept-and-drop a verbatim { type: 'native' }; reject anything else.
      if (dto.type === 'native' && Object.keys(dto).length === 1) continue;
      return errorResult('INVALID_PARAMS', `"${NATIVE_NAME}" is a reserved profile name and cannot be redefined.`);
    }
    if (dto.type === 'native') {
      next[name] = { type: 'native' };
      continue;
    }
    if (dto.type !== 'openrouter') return errorResult('INVALID_PARAMS', `Invalid profile "${name}"`);

    const current = modelProviders.profiles[name];
    const currentKey = current?.type === 'openrouter' ? current.apiKey : undefined;
    const resolvedKey = resolveKey(dto.apiKey, currentKey);

    const built: MockOpenrouterProfile = { type: 'openrouter' };
    if (resolvedKey) built.apiKey = resolvedKey;
    if (Array.isArray(dto.modelMap)) {
      built.modelMap = (dto.modelMap as { match: string; model: string }[]).map((r) => ({
        match: r.match,
        model: r.model,
      }));
    }
    const perAgent: Record<string, string> = {};
    if (dto.perAgent && typeof dto.perAgent === 'object') {
      for (const agent of DOCKER_AGENTS) {
        const slug = (dto.perAgent as Record<string, unknown>)[agent];
        if (typeof slug === 'string' && slug.length > 0) perAgent[agent] = slug;
      }
    }
    if (Object.keys(perAgent).length > 0) built.perAgent = perAgent;
    if (dto.providerPreference && typeof dto.providerPreference === 'object') {
      built.providerPreference = dto.providerPreference as MockOpenrouterProfile['providerPreference'];
    }
    if (typeof dto.sessionAffinity === 'boolean') built.sessionAffinity = dto.sessionAffinity;
    next[name] = built;
  }

  // F10: re-point a `default` that names a DROPPED profile; reject a genuinely
  // bad default (one that never existed).
  const requested = typeof params.default === 'string' ? params.default : undefined;
  let resolvedDefault: string | undefined = requested;
  if (requested !== undefined && requested !== NATIVE_NAME && !(requested in next)) {
    resolvedDefault = priorNames.includes(requested) ? NATIVE_NAME : requested;
  }
  if (resolvedDefault !== undefined && resolvedDefault !== NATIVE_NAME && !(resolvedDefault in next)) {
    return errorResult('INVALID_PARAMS', 'modelProviders.default must name a configured profile or "native".');
  }

  modelProviders = { default: resolvedDefault ?? NATIVE_NAME, profiles: next };
  return undefined;
}

/** M5: absent/null/mask-equal → keep; '' → clear (undefined); other → set. */
function resolveKey(wire: unknown, currentKey: string | undefined): string | undefined {
  if (wire === undefined || wire === null) return currentKey;
  if (typeof wire !== 'string') return currentKey;
  if (wire === maskApiKey(currentKey)) return currentKey;
  if (wire === '') return undefined;
  return wire;
}

const CANNED_FILE_TREE = {
  entries: [
    { name: '.workflow', type: 'directory' as const },
    { name: 'src', type: 'directory' as const },
    { name: 'package.json', type: 'file' as const, size: 1234 },
    { name: 'tsconfig.json', type: 'file' as const, size: 456 },
    { name: 'README.md', type: 'file' as const, size: 2048 },
  ],
};

const CANNED_FILE_TREE_SRC = {
  entries: [
    { name: 'index.ts', type: 'file' as const, size: 890 },
    { name: 'utils.ts', type: 'file' as const, size: 1200 },
    { name: 'types.ts', type: 'file' as const, size: 650 },
  ],
};

const CANNED_FILE_TREE_WORKFLOW = {
  entries: [
    { name: 'plan', type: 'directory' as const },
    { name: 'spec', type: 'directory' as const },
  ],
};

const CANNED_FILE_CONTENTS: Record<string, { content: string; language: string }> = {
  'package.json': {
    content:
      '{\n  "name": "example-project",\n  "version": "1.0.0",\n  "type": "module",\n  "scripts": {\n    "build": "tsc",\n    "test": "vitest"\n  }\n}',
    language: 'json',
  },
  'tsconfig.json': {
    content: '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "module": "Node16",\n    "strict": true\n  }\n}',
    language: 'json',
  },
  'README.md': {
    content:
      '# Example Project\n\nThis is a generated workspace for the workflow.\n\n## Getting Started\n\n```bash\nnpm install\nnpm run build\n```\n',
    language: 'markdown',
  },
  'src/index.ts': {
    content:
      'import { greet } from "./utils.js";\n\nconst name = process.argv[2] ?? "World";\nconsole.log(greet(name));\n',
    language: 'typescript',
  },
  'src/utils.ts': {
    content:
      'export function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n',
    language: 'typescript',
  },
  'src/types.ts': {
    content: 'export interface Config {\n  readonly name: string;\n  readonly version: string;\n}\n',
    language: 'typescript',
  },
};

const CANNED_ARTIFACTS: Record<string, { files: Array<{ path: string; content: string }> }> = {
  plan: {
    files: [
      {
        path: 'plan.md',
        content:
          '# Implementation Plan\n\n## Overview\n\nThis plan outlines the steps to implement the requested feature.\n\n## Steps\n\n1. Create the data model\n2. Implement the service layer\n3. Add API endpoints\n4. Write tests\n\n## Timeline\n\nEstimated: 2 hours\n',
      },
    ],
  },
  spec: {
    files: [
      {
        path: 'spec.md',
        content:
          '# Technical Specification\n\n## Data Model\n\n```typescript\ninterface Widget {\n  id: string;\n  name: string;\n  createdAt: Date;\n}\n```\n\n## API\n\n- `GET /widgets` - List all widgets\n- `POST /widgets` - Create a widget\n',
      },
    ],
  },
  'plan.md': {
    files: [
      {
        path: 'plan.md',
        content:
          '# Implementation Plan\n\nDetailed plan for the workflow task.\n\n## Phase 1\n\n- Set up project structure\n- Install dependencies\n\n## Phase 2\n\n- Implement core logic\n- Add error handling\n',
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Canned workflow data
// ---------------------------------------------------------------------------

interface MockWorkflow {
  workflowId: string;
  name: string;
  phase: 'running' | 'waiting_human' | 'completed' | 'failed' | 'aborted';
  currentState: string;
  startedAt: string;
}

interface MockGate {
  gateId: string;
  workflowId: string;
  stateName: string;
  acceptedEvents: readonly string[];
  presentedArtifacts: readonly string[];
  summary: string;
}

const CANNED_WORKFLOWS: MockWorkflow[] = [
  {
    workflowId: 'wf-mock-001',
    name: 'design-and-code',
    phase: 'running',
    currentState: 'implement',
    startedAt: new Date(Date.now() - 120_000).toISOString(),
  },
  {
    workflowId: 'wf-mock-002',
    name: 'code-review',
    phase: 'waiting_human',
    currentState: 'plan_review',
    startedAt: new Date(Date.now() - 300_000).toISOString(),
  },
];

const workflows = new Map<string, MockWorkflow>();
const workflowGates = new Map<string, MockGate>();
const workflowTimers = new Map<string, ReturnType<typeof setTimeout>[]>();

function trackTimer(workflowId: string, timer: ReturnType<typeof setTimeout>): void {
  const existing = workflowTimers.get(workflowId) ?? [];
  existing.push(timer);
  workflowTimers.set(workflowId, existing);
}

function clearWorkflowTimers(workflowId: string): void {
  const timers = workflowTimers.get(workflowId);
  if (timers) {
    for (const t of timers) clearTimeout(t);
    workflowTimers.delete(workflowId);
  }
}

function initWorkflows(): void {
  workflows.clear();
  workflowGates.clear();
  for (const timers of workflowTimers.values()) {
    for (const t of timers) clearTimeout(t);
  }
  workflowTimers.clear();
  for (const wf of structuredClone(CANNED_WORKFLOWS)) {
    workflows.set(wf.workflowId, wf);
  }
  // Add a gate for the waiting workflow
  const gateId = 'wf-mock-002-plan_review';
  workflowGates.set(gateId, {
    gateId,
    workflowId: 'wf-mock-002',
    stateName: 'plan_review',
    acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT'],
    presentedArtifacts: ['plan'],
    summary: 'Waiting for human review at plan_review',
  });
}
initWorkflows();

// ---------------------------------------------------------------------------
// Mock state graph for design-and-code workflow
// ---------------------------------------------------------------------------

const DESIGN_AND_CODE_GRAPH = {
  states: [
    {
      id: 'plan',
      type: 'agent' as const,
      persona: 'planner',
      label: 'Plan',
      description: 'Breaks down the task into implementation steps',
    },
    { id: 'plan_review', type: 'human_gate' as const, label: 'Plan Review', description: 'Human review of the plan' },
    {
      id: 'implement',
      type: 'agent' as const,
      persona: 'coder',
      label: 'Implement',
      description: 'Implements all modules per the design spec',
    },
    {
      id: 'review',
      type: 'agent' as const,
      persona: 'critic',
      label: 'Review',
      description: 'Reviews code against the spec for correctness and quality',
    },
    {
      id: 'design_review',
      type: 'human_gate' as const,
      label: 'Design Review',
      description: 'Human review of the design specification',
    },
    { id: 'completed', type: 'terminal' as const, label: 'Completed', description: 'Workflow complete' },
    { id: 'aborted', type: 'terminal' as const, label: 'Aborted', description: 'Workflow aborted' },
  ],
  transitions: [
    { from: 'plan', to: 'plan_review', label: '' },
    { from: 'plan_review', to: 'implement', event: 'APPROVE', label: 'Approve' },
    { from: 'plan_review', to: 'plan', event: 'FORCE_REVISION', label: 'Force Revision' },
    { from: 'plan_review', to: 'aborted', event: 'ABORT', label: 'Abort' },
    { from: 'implement', to: 'review', label: '' },
    { from: 'review', to: 'implement', label: 'rejected' },
    { from: 'review', to: 'design_review', label: 'approved' },
    { from: 'design_review', to: 'completed', event: 'APPROVE', label: 'Approve' },
    { from: 'design_review', to: 'implement', event: 'FORCE_REVISION', label: 'Force Revision' },
    { from: 'design_review', to: 'aborted', event: 'ABORT', label: 'Abort' },
  ],
};

const CODE_REVIEW_GRAPH = {
  states: [
    {
      id: 'analyze',
      type: 'agent' as const,
      persona: 'reviewer',
      label: 'Analyze',
      description: 'Analyzes code for issues and improvements',
    },
    {
      id: 'report_review',
      type: 'human_gate' as const,
      label: 'Report Review',
      description: 'Human review of the analysis report',
    },
    { id: 'completed', type: 'terminal' as const, label: 'Completed', description: 'Review complete' },
  ],
  transitions: [
    { from: 'analyze', to: 'report_review', label: '' },
    { from: 'report_review', to: 'completed', event: 'APPROVE', label: 'Approve' },
    { from: 'report_review', to: 'analyze', event: 'FORCE_REVISION', label: 'Force Revision' },
  ],
};

// Workflows that ship a co-packaged README (mirrors the bundled design-and-code
// package). Drives `hasReadme` on definitions/details and `workflows.readme`.
const README_WORKFLOW_NAMES = new Set(['design-and-code']);

// Workflows hidden from the web UI (smoke tests / fixtures). The real daemon
// filters these out of listDefinitions / list / listResumable while still
// listing them in the CLI; the mock mirrors that suppression so the UI's
// "no test workflows visible" behavior is exercisable end-to-end.
const HIDDEN_WORKFLOW_NAMES = new Set(['deterministic-verdict-smoke']);

// Canned README markdown returned by `workflows.readme` for README workflows.
const MOCK_README = `# Design & Code

A four-phase workflow: **plan → design → implement → review**, with human gates
between the planning stages and an automated coder–critic loop at the end.

## Phases

| Phase | Role | Output |
|-------|------|--------|
| Plan | Planner — orders the work into steps | \`plan.md\` |
| Design | Architect — interfaces and types | \`spec.md\` |
| Implement | Engineer — code + unit tests | \`src/\` |
| Review | Reviewer — correctness and quality | \`review.md\` |

## Human gates

- **Plan review** — approve the approach before design.
- **Design review** — approve interfaces before implementation.

> Tip: write a detailed task description — the planner only sees the task text
> and whatever already exists in the workspace.
`;

function buildWorkflowDetailDto(wf: MockWorkflow, gate?: MockGate) {
  const isDesignAndCode = wf.name.includes('design');
  const graph = isDesignAndCode ? DESIGN_AND_CODE_GRAPH : CODE_REVIEW_GRAPH;

  // Build transition history from the completed states
  const transitionHistory = [];
  const baseTime = new Date(wf.startedAt).getTime();
  if (wf.currentState !== graph.states[0].id) {
    // Simulate that at least the initial state transitioned
    transitionHistory.push({
      from: graph.states[0].id,
      to: graph.states.length > 1 ? graph.states[1].id : graph.states[0].id,
      event: 'auto',
      timestamp: new Date(baseTime + 5000).toISOString(),
      durationMs: 5000,
    });
  }

  return {
    ...wf,
    description: `Mock workflow: ${wf.name}`,
    stateGraph: graph,
    transitionHistory,
    context: {
      taskDescription: `Execute the ${wf.name} workflow`,
      round: 1,
      maxRounds: 3,
      totalTokens: 15000 + Math.floor(Math.random() * 10000),
      visitCounts: { [wf.currentState]: 1 },
    },
    gate: gate ?? undefined,
    workspacePath: `/tmp/ironcurtain-workflow/${wf.workflowId}`,
    hasReadme: README_WORKFLOW_NAMES.has(wf.name),
  };
}

// ---------------------------------------------------------------------------
// Past-run + message-log fixtures (F7)
//
// These fixtures back the widened `workflows.listResumable` (covering all five
// `PastRunPhase` values) and the new `workflows.messageLog` RPC (covering all
// eight `MessageLogEntry` variants) so the e2e suite renders every variant
// without depending on a real workflow run.
// ---------------------------------------------------------------------------

interface MockLatestVerdict {
  readonly stateId: string;
  readonly verdict: string;
  readonly confidence?: number;
}

interface MockPastRun {
  readonly workflowId: string;
  readonly name: string;
  readonly phase: 'completed' | 'failed' | 'aborted' | 'waiting_human' | 'interrupted';
  readonly currentState: string;
  readonly lastState: string;
  readonly taskDescription: string;
  readonly round: number;
  readonly maxRounds: number;
  readonly totalTokens: number;
  readonly latestVerdict?: MockLatestVerdict;
  readonly error?: string;
  readonly timestamp: string;
  readonly durationMs?: number;
  readonly workspacePath?: string;
}

function buildPastRunFixtures(): MockPastRun[] {
  return [
    {
      workflowId: 'wf-past-completed',
      name: 'design-and-code',
      phase: 'completed',
      currentState: 'completed',
      lastState: 'completed',
      taskDescription: 'Implement circle of fifths visualization component with SVG',
      round: 2,
      maxRounds: 3,
      totalTokens: 48200,
      latestVerdict: { stateId: 'design_review', verdict: 'approved', confidence: 0.94 },
      timestamp: new Date(Date.now() - 3600_000).toISOString(),
      durationMs: 720_000,
      workspacePath: '/home/user/projects/music-app',
    },
    {
      workflowId: 'wf-past-failed',
      name: 'vuln-discovery',
      phase: 'failed',
      currentState: 'analyze',
      lastState: 'analyze',
      taskDescription: 'Audit auth middleware for CVE-2024-XXXX exposure',
      round: 1,
      maxRounds: 4,
      totalTokens: 12300,
      error: 'Provider returned 429 Too Many Requests after 3 retries; aborting run.',
      timestamp: new Date(Date.now() - 7200_000).toISOString(),
      durationMs: 95_000,
      workspacePath: '/home/user/projects/auth-service',
    },
    {
      workflowId: 'wf-past-aborted',
      name: 'code-review',
      phase: 'aborted',
      currentState: 'aborted',
      lastState: 'plan_review',
      taskDescription: 'Refactor session manager into a pure module',
      round: 1,
      maxRounds: 2,
      totalTokens: 4100,
      error: 'Workflow aborted by user at plan_review gate.',
      timestamp: new Date(Date.now() - 10800_000).toISOString(),
      durationMs: 38_000,
      workspacePath: '/home/user/projects/session-refactor',
    },
    {
      workflowId: 'wf-past-waiting',
      name: 'design-and-code',
      phase: 'waiting_human',
      currentState: 'plan_review',
      lastState: 'plan_review',
      taskDescription: 'Add SAML SSO to the admin console',
      round: 1,
      maxRounds: 3,
      totalTokens: 18900,
      latestVerdict: { stateId: 'plan', verdict: 'success', confidence: 0.81 },
      timestamp: new Date(Date.now() - 86400_000).toISOString(),
      workspacePath: '/home/user/projects/admin-console',
    },
    {
      workflowId: 'wf-past-interrupted',
      name: 'vuln-discovery',
      phase: 'interrupted',
      currentState: 'fuzz',
      lastState: 'fuzz',
      taskDescription: 'Fuzz the new JSON-RPC dispatch surface',
      round: 2,
      maxRounds: 5,
      totalTokens: 33600,
      error: 'Daemon restarted while workflow was active; checkpoint left without finalStatus.',
      timestamp: new Date(Date.now() - 172800_000).toISOString(),
      workspacePath: '/home/user/projects/jsonrpc-fuzz',
    },
    // Legacy / pre-B3b completed run: checkpoint.json was deleted on completion,
    // so the discovery scan synthesizes the row from messages.jsonl + the workflow
    // definition. No round/verdict/workspace metadata survives.
    {
      workflowId: 'wf-past-completed-legacy',
      name: 'design-and-code',
      phase: 'completed',
      currentState: 'completed',
      lastState: 'completed',
      taskDescription: 'Add a /healthz endpoint to the orchestrator HTTP server',
      round: 0,
      maxRounds: 0,
      totalTokens: 0,
      timestamp: new Date(Date.now() - 5 * 86400_000).toISOString(),
    },
    // Post-B3b completed run: checkpoint retained on disk with full finalStatus
    // metadata, so every numeric/verdict/workspace field is populated.
    {
      workflowId: 'wf-past-completed-checkpointed',
      name: 'design-and-code',
      phase: 'completed',
      currentState: 'completed',
      lastState: 'completed',
      taskDescription: 'Wire the checkpoint retention path through the past-runs UI',
      round: 3,
      maxRounds: 4,
      totalTokens: 56_300,
      latestVerdict: { stateId: 'design_review', verdict: 'approved', confidence: 0.97 },
      timestamp: new Date(Date.now() - 1800_000).toISOString(),
      durationMs: 540_000,
      workspacePath: '/home/user/projects/checkpoint-retention',
    },
    // Hidden smoke-test run: present on disk but suppressed from the UI because
    // its workflow is marked `hidden: true`. The listResumable handler filters
    // it out (mirroring the daemon), so it should never reach the past-runs table.
    {
      workflowId: 'wf-past-smoke-hidden',
      name: 'deterministic-verdict-smoke',
      phase: 'completed',
      currentState: 'completed',
      lastState: 'completed',
      taskDescription: 'TESTING ONLY - deterministic verdict smoke run',
      round: 1,
      maxRounds: 1,
      totalTokens: 1200,
      timestamp: new Date(Date.now() - 600_000).toISOString(),
      durationMs: 15_000,
      workspacePath: '/tmp/smoke',
    },
  ];
}

function buildMessageLogFixtures(workflowId: string): Array<Record<string, unknown> & { ts: string }> {
  // Spaced 30s apart; written newest-last in source so sorting is exercised.
  const base = Date.now() - 600_000;
  const ts = (offsetSeconds: number): string => new Date(base + offsetSeconds * 1000).toISOString();

  return [
    {
      type: 'state_transition',
      ts: ts(0),
      workflowId,
      state: 'plan',
      from: 'start',
      event: 'auto',
    },
    {
      type: 'agent_sent',
      ts: ts(30),
      workflowId,
      state: 'plan',
      role: 'planner',
      message:
        '# Task\n\nDecompose the request into ordered implementation steps. Reply with a `STATUS: success` block when the plan is ready for review.',
    },
    {
      type: 'agent_received',
      ts: ts(90),
      workflowId,
      state: 'plan',
      role: 'planner',
      message:
        '## Plan\n\n1. Read the existing module\n2. Sketch the new interface\n3. Implement and test\n\n```status\nverdict: success\nconfidence: 0.82\n```',
      verdict: 'success',
      confidence: '0.82',
    },
    {
      type: 'agent_retry',
      ts: ts(120),
      workflowId,
      state: 'implement',
      role: 'coder',
      reason: 'missing_status_block',
      details: 'Agent reply did not contain a STATUS block; resending with a stronger reminder.',
      retryMessage:
        'Reminder: every reply must end with a fenced ```status``` block containing `verdict:` and `confidence:`. Please redo your previous response.',
    },
    {
      type: 'gate_raised',
      ts: ts(180),
      workflowId,
      state: 'plan_review',
      acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
    },
    {
      type: 'gate_resolved',
      ts: ts(240),
      workflowId,
      state: 'plan_review',
      event: 'APPROVE',
      prompt: 'Looks good — proceed with implementation but keep the new module under 200 lines.',
    },
    {
      type: 'quota_exhausted',
      ts: ts(300),
      workflowId,
      state: 'implement',
      role: 'coder',
      resetAt: new Date(base + 600_000).toISOString(),
      rawMessage: '429 Too Many Requests: anthropic-ratelimit-tokens-reset=2026-04-23T17:30:00Z',
    },
    {
      type: 'error',
      ts: ts(360),
      workflowId,
      state: 'review',
      error: 'Reviewer agent crashed with non-zero exit code 137 (out of memory).',
      context: 'state=review, attempt=2, lastTool=filesystem__read_file',
    },
  ];
}

// Mutable copy of canned jobs so enable/disable/remove are stateful
const jobs = structuredClone(CANNED_JOBS);

/** Reset all mutable state for test isolation. */
function resetState(opts?: ResetOptions): void {
  stopAllPtyFrames();
  sessions.clear();
  escalations.clear();
  nextLabel = 1;
  eventSeq = 0;
  jobs.length = 0;
  jobs.push(...structuredClone(CANNED_JOBS));
  initWorkflows();
  clearCompileState();
  // Restore the model-provider registry so a set-mutating e2e starts fresh.
  modelProviders = structuredClone(ORIGINAL_MODEL_PROVIDERS);
  // clearCompileState resets allowPolicyMutation to true (the default); honor a
  // per-test override AFTER it so a flag-OFF e2e (controls hidden) is real.
  if (opts?.allowPolicyMutation !== undefined) {
    allowPolicyMutation = opts.allowPolicyMutation;
  }
  if (replayController) {
    replayController.abort();
    replayController = null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emit(ws: WebSocket, event: string, payload: unknown): void {
  const frame: EventFrame = { event, payload, seq: ++eventSeq };
  try {
    ws.send(JSON.stringify(frame));
  } catch {
    // Socket already closed; ignore
  }
}

function broadcast(event: string, payload: unknown): void {
  for (const ws of clients) {
    emit(ws, event, payload);
  }
}

function buildBudgetDto(session: MockSession) {
  return {
    totalTokens: session.totalTokens,
    stepCount: session.stepCount,
    elapsedSeconds: Math.floor((Date.now() - new Date(session.createdAt).getTime()) / 1000),
    estimatedCostUsd: session.estimatedCostUsd,
    tokenTrackingAvailable: true,
    limits: {
      maxTotalTokens: 1_000_000,
      maxSteps: 200,
      maxSessionSeconds: 1800,
      maxEstimatedCostUsd: 5.0,
    },
  };
}

function buildZeroBudgetDto() {
  return {
    totalTokens: 0,
    stepCount: 0,
    elapsedSeconds: 0,
    estimatedCostUsd: 0,
    tokenTrackingAvailable: false,
    limits: { maxTotalTokens: null, maxSteps: null, maxSessionSeconds: null, maxEstimatedCostUsd: null },
  };
}

function buildSessionDto(session: MockSession) {
  // A web-pty (terminal) session has zeroed budget, turnCount 0, no token
  // tracking, and an optional lastAttachedAt — mirrors toPtySessionDto.
  if (session.isPty) {
    return {
      label: session.label,
      source: { kind: 'web-pty' as const, ...(session.persona ? { persona: session.persona } : {}) },
      status: session.status,
      turnCount: 0,
      createdAt: session.createdAt,
      hasPendingEscalation: [...escalations.values()].some((e) => e.sessionLabel === session.label),
      messageInFlight: false,
      budget: buildZeroBudgetDto(),
      ...(session.persona ? { persona: session.persona } : {}),
      ...(session.lastAttachedAt ? { lastAttachedAt: session.lastAttachedAt } : {}),
    };
  }
  return {
    label: session.label,
    source: { kind: 'web' as const },
    status: session.status,
    turnCount: session.turnCount,
    createdAt: session.createdAt,
    hasPendingEscalation: [...escalations.values()].some((e) => e.sessionLabel === session.label),
    messageInFlight: session.status === 'processing',
    budget: buildBudgetDto(session),
    ...(session.persona ? { persona: session.persona } : {}),
  };
}

function buildStatusDto() {
  return {
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    jobs: { total: jobs.length, enabled: jobs.filter((j) => j.job.enabled).length, running: 0 },
    signalConnected: false,
    webUiListening: true,
    activeSessions: sessions.size,
    nextFireTime: jobs[0]?.nextRun ?? null,
    // Phase 1c: drives whether the UI shows persona-mutation controls. Default
    // true so the e2e happy paths work; a per-test POST /__reset override can
    // flip it OFF to exercise the controls-hidden path.
    allowPolicyMutation,
    // Surface the process-global mode so the UI shows the web-pty launch flow.
    sessionMode: 'container',
  };
}

function buildEscalationDto(esc: MockEscalation) {
  const session = sessions.get(esc.sessionLabel);
  const kind = session?.isPty ? ('web-pty' as const) : ('web' as const);
  return {
    ...esc,
    sessionSource: { kind },
  };
}

/**
 * Raise the canned "write to protected system path" escalation for a session and
 * broadcast it. Shared by the turn simulation and both PTY input paths (raw
 * keystrokes and trusted prompt) so the "escalate" trigger stays identical.
 */
function raiseWriteEscalation(label: number): void {
  const escalationId = `esc-${Date.now()}`;
  const esc: MockEscalation = {
    escalationId,
    sessionLabel: label,
    toolName: 'filesystem__write_file',
    serverName: 'filesystem',
    arguments: { path: '/etc/hosts', content: 'malicious content' },
    reason: 'Write to protected system path',
    whitelistCandidates: [
      { description: 'Allow filesystem.write_file within /etc/' },
      { description: 'Allow filesystem.write_file for this exact path: /etc/hosts' },
    ],
    receivedAt: new Date().toISOString(),
  };
  escalations.set(escalationId, esc);
  broadcast('escalation.created', buildEscalationDto(esc));
}

// ---------------------------------------------------------------------------
// Simulated turn sequence
// ---------------------------------------------------------------------------

async function simulateTurn(ws: WebSocket, label: number, text: string): Promise<void> {
  const session = sessions.get(label);
  if (!session) return;

  session.status = 'processing';
  session.turnCount++;
  const turnNumber = session.turnCount;

  // Check for escalation keyword
  if (text.toLowerCase().includes('escalate')) {
    emit(ws, 'session.thinking', { label, turnNumber });
    emit(ws, 'session.updated', buildSessionDto(session));

    await delay(800);

    emit(ws, 'session.tool_call', {
      label,
      toolName: 'filesystem__write_file',
      preview: 'Writing /etc/hosts',
    });

    await delay(600);

    raiseWriteEscalation(label);
    // Session stays in processing until escalation is resolved
    return;
  }

  // Normal turn sequence
  emit(ws, 'session.thinking', { label, turnNumber });
  emit(ws, 'session.updated', buildSessionDto(session));

  await delay(800);

  emit(ws, 'session.tool_call', {
    label,
    toolName: 'filesystem__read_file',
    preview: 'Reading ./package.json',
  });

  await delay(600);

  emit(ws, 'session.tool_call', {
    label,
    toolName: 'filesystem__write_file',
    preview: 'Writing ./output.txt',
  });

  await delay(1200);

  // Final output
  const response = CANNED_RESPONSES[turnNumber % CANNED_RESPONSES.length];
  session.totalTokens += 3500 + Math.floor(Math.random() * 2000);
  session.stepCount += 2 + Math.floor(Math.random() * 3);
  session.estimatedCostUsd += 0.01 + Math.random() * 0.04;
  session.status = 'ready';

  emit(ws, 'session.output', { label, text: response, turnNumber });
  emit(ws, 'session.budget_update', { label, budget: buildBudgetDto(session) });
  emit(ws, 'session.updated', buildSessionDto(session));
}

// ---------------------------------------------------------------------------
// Simulated streamed persona compile
// ---------------------------------------------------------------------------

/**
 * Drive a streamed compile: started -> progress(x2 canned phases) -> done.
 * The terminal record is written into `recentCompiles` and removed from
 * `activeCompiles` at/just-before the `done` broadcast, so a getCompile or a
 * reconnect-time listCompiles issued after completion still returns it.
 */
function simulateCompile(op: MockCompileOperation): void {
  // started
  op.phase = 'started';
  broadcast('persona.compile.started', { name: op.name, operationId: op.operationId, actor: op.actor });

  // progress #1
  compileTimers.push(
    setTimeout(() => {
      const live = activeCompiles.get(op.operationId);
      if (!live) return;
      live.phase = 'running';
      live.serverProgress = { server: 'filesystem', compilationPhase: 'scenarios', detail: 'generating scenarios' };
      broadcast('persona.compile.progress', {
        name: live.name,
        operationId: live.operationId,
        serverName: 'filesystem',
        phase: 'scenarios',
        detail: 'generating scenarios',
      });
    }, 200),
  );

  // progress #2
  compileTimers.push(
    setTimeout(() => {
      const live = activeCompiles.get(op.operationId);
      if (!live) return;
      live.serverProgress = { server: 'git', compilationPhase: 'verifying' };
      broadcast('persona.compile.progress', {
        name: live.name,
        operationId: live.operationId,
        serverName: 'git',
        phase: 'verifying',
      });
    }, 400),
  );

  // done -- move active -> recent, then broadcast.
  compileTimers.push(
    setTimeout(() => {
      const live = activeCompiles.get(op.operationId);
      if (!live) return;
      const ruleCount = 10 + Math.floor(Math.random() * 10);
      live.phase = 'done';
      live.endedAt = new Date().toISOString();
      const pd = CANNED_PERSONA_DETAILS[live.name];
      // ruleDelta is present only when a previous compiled policy existed (i.e.
      // this is a recompile); absent on a first compile.
      const hadPriorPolicy = pd?.hasPolicy === true;
      const ruleDelta: MockRuleDelta | undefined = hadPriorPolicy
        ? {
            added: 2,
            loosened: 1,
            removed: 0,
            broadenedDomains: [],
            outOfWorkspacePaths: [],
          }
        : undefined;
      live.result = { success: true, ruleCount, ...(ruleDelta ? { ruleDelta } : {}) };
      // Critical-section analogue: record into recent, drop from active BEFORE
      // emitting done, so a getCompile/listCompiles issued immediately after the
      // event sees a real terminal record.
      activeCompiles.delete(op.operationId);
      recordRecentCompile(live);
      // Flip the persona's compiled flag so the list badge updates on refresh.
      const persona = CANNED_PERSONAS.find((p) => p.name === live.name);
      if (persona) persona.compiled = true;
      if (pd) {
        pd.hasPolicy = true;
        pd.policyRuleCount = ruleCount;
      }
      broadcast('persona.compile.done', {
        name: live.name,
        operationId: live.operationId,
        result: { success: true, ruleCount, ...(ruleDelta ? { ruleDelta } : {}) },
      });
    }, 600),
  );
}

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

function handleMethod(ws: WebSocket, method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'status':
      return buildStatusDto();

    case 'sessions.list':
      return [...sessions.values()].map(buildSessionDto);

    case 'sessions.create': {
      const label = nextLabel++;
      const session: MockSession = {
        label,
        turnCount: 0,
        createdAt: new Date().toISOString(),
        status: 'ready',
        persona: (params.persona as string) ?? undefined,
        totalTokens: 0,
        stepCount: 0,
        estimatedCostUsd: 0,
        isPty: true,
      };
      sessions.set(label, session);
      broadcast('session.created', buildSessionDto(session));
      return { label };
    }

    // -----------------------------------------------------------------------
    // PTY terminal streaming (container mode). attach replays a snapshot + starts
    // a fake-TUI frame timer; input echoes back (and routes "escalate" to the
    // overlay); resize is a noop ack; detach stops the frames.
    // -----------------------------------------------------------------------

    case 'sessions.ptyAttach': {
      const label = params.label as number;
      const attachSession = sessions.get(label);
      if (!attachSession) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      attachSession.lastAttachedAt = new Date().toISOString();
      // One-shot full-screen replay to just the attaching client, emitted inline
      // the instant we receive ptyAttach (a fast daemon serializes+sends the same
      // way). This can beat the client's terminal-mount effect, so TerminalConsole
      // buffers a replay that arrives before its xterm Terminal exists and flushes
      // it on open — the snapshot is never dropped. The e2e exercises exactly this.
      emit(ws, 'session.pty_replay', { label, snapshot: b64(PTY_BANNER) });
      broadcast('session.updated', buildSessionDto(attachSession));
      startPtyFrames(label);
      return { attached: true };
    }

    case 'sessions.ptyDetach': {
      const label = params.label as number;
      stopPtyFrames(label);
      return { detached: true };
    }

    case 'sessions.ptyInput': {
      const label = params.label as number;
      const dataB64 = params.data as string;
      const inputSession = sessions.get(label);
      if (!inputSession) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      const text = Buffer.from(dataB64, 'base64').toString('utf-8');
      // Route "escalate" to a structured escalation so the overlay is demoable.
      if (text.toLowerCase().includes('escalate')) raiseWriteEscalation(label);
      // Echo the keystrokes back so typed characters appear at the cursor.
      broadcast('session.pty_output', { label, data: dataB64 });
      return { accepted: true };
    }

    case 'sessions.ptyResize': {
      // Last-writer-wins; the mock has no real PTY to resize.
      return { resized: true };
    }

    case 'sessions.ptyPrompt': {
      // Trusted message: PLAIN text (not base64). The daemon records it as
      // trusted user-context (authorizing auto-approval) and injects it into the
      // child PTY. The mock injects an observable echo so the round-trip is
      // assertable, and reuses the "escalate" trigger path.
      const label = params.label as number;
      const text = params.text as string;
      const promptSession = sessions.get(label);
      if (!promptSession) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      if (text.toLowerCase().includes('escalate')) raiseWriteEscalation(label);
      broadcast('session.pty_output', { label, data: b64(`\r\n> ${text}\r\n`) });
      return { accepted: true };
    }

    case 'sessions.get': {
      const label = params.label as number;
      const session = sessions.get(label);
      if (!session) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      return {
        ...buildSessionDto(session),
        history: session.turnCount > 0 ? CANNED_HISTORY.slice(0, session.turnCount) : [],
        diagnosticLog: session.turnCount > 0 ? CANNED_DIAGNOSTICS : [],
      };
    }

    case 'sessions.send': {
      const label = params.label as number;
      const text = params.text as string;
      const session = sessions.get(label);
      if (!session) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      // Fire-and-forget the async simulation
      simulateTurn(ws, label, text).catch(() => {});
      return { accepted: true };
    }

    case 'sessions.end': {
      const label = params.label as number;
      stopPtyFrames(label);
      sessions.delete(label);
      // Clean up any escalations belonging to this session
      for (const [id, esc] of escalations) {
        if (esc.sessionLabel === label) escalations.delete(id);
      }
      broadcast('session.ended', { label, reason: 'user_ended' });
      return undefined;
    }

    case 'sessions.budget': {
      const label = params.label as number;
      const session = sessions.get(label);
      if (!session) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      return buildBudgetDto(session);
    }

    case 'sessions.history': {
      const label = params.label as number;
      const histSession = sessions.get(label);
      if (!histSession) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      return histSession.turnCount > 0 ? CANNED_HISTORY.slice(0, histSession.turnCount) : [];
    }

    case 'sessions.diagnostics': {
      const label = params.label as number;
      const diagSession = sessions.get(label);
      if (!diagSession) return errorResult('SESSION_NOT_FOUND', `Session #${label} not found`);
      return diagSession.turnCount > 0 ? CANNED_DIAGNOSTICS : [];
    }

    case 'escalations.list':
      return [...escalations.values()].map(buildEscalationDto);

    case 'escalations.resolve': {
      const escalationId = params.escalationId as string;
      const decision = params.decision as string;
      const esc = escalations.get(escalationId);
      if (!esc) return errorResult('ESCALATION_NOT_FOUND', `Escalation ${escalationId} not found`);
      escalations.delete(escalationId);
      broadcast('escalation.resolved', { escalationId, decision });

      // Resume the session that was waiting on this escalation
      const session = sessions.get(esc.sessionLabel);
      if (session) {
        session.status = 'ready';
        broadcast('session.updated', buildSessionDto(session));
      }
      return undefined;
    }

    case 'jobs.list':
      return jobs;

    case 'jobs.run': {
      const jobId = params.jobId as string;
      const runningJob = jobs.find((j) => j.job.id === jobId);
      if (runningJob) runningJob.isRunning = true;
      broadcast('job.started', { jobId, sessionLabel: 0 });
      setTimeout(() => {
        if (runningJob) runningJob.isRunning = false;
        broadcast('job.completed', {
          jobId,
          record: {
            startedAt: new Date(Date.now() - 3000).toISOString(),
            completedAt: new Date().toISOString(),
            outcome: { kind: 'success' },
            budget: { totalTokens: 15000, stepCount: 8, elapsedSeconds: 3, estimatedCostUsd: 0.05 },
            summary: 'Job completed successfully.',
          },
        });
      }, 3000);
      return { accepted: true, jobId };
    }

    case 'jobs.enable': {
      const job = jobs.find((j) => j.job.id === params.jobId);
      if (job) job.job.enabled = true;
      broadcast('job.list_changed', {});
      return undefined;
    }

    case 'jobs.disable': {
      const job = jobs.find((j) => j.job.id === params.jobId);
      if (job) job.job.enabled = false;
      broadcast('job.list_changed', {});
      return undefined;
    }

    case 'jobs.remove': {
      const idx = jobs.findIndex((j) => j.job.id === params.jobId);
      if (idx !== -1) jobs.splice(idx, 1);
      broadcast('job.list_changed', {});
      return undefined;
    }

    case 'jobs.recompile':
    case 'jobs.reload':
      broadcast('job.list_changed', {});
      return undefined;

    case 'jobs.logs':
      return CANNED_RUN_RECORDS;

    case 'personas.list':
      return CANNED_PERSONAS;

    case 'personas.get': {
      const pName = params.name as string;
      const pDetail = CANNED_PERSONA_DETAILS[pName];
      if (!pDetail) return errorResult('PERSONA_NOT_FOUND', `Persona "${pName}" not found`);
      return pDetail;
    }

    case 'personas.compileStream': {
      const pName = params.name as string;
      if (typeof pName !== 'string' || pName.length === 0) {
        return errorResult('INVALID_PARAMS', 'name is required');
      }
      // Security gate (1b): default-allow in the mock; flag-OFF is a 1c concern.
      if (!allowPolicyMutation) {
        return errorResult('POLICY_MUTATION_FORBIDDEN', 'Policy mutation is not permitted on this daemon');
      }
      if (!CANNED_PERSONA_DETAILS[pName]) return errorResult('PERSONA_NOT_FOUND', `Persona "${pName}" not found`);
      // Simulate the credentials-missing preflight for a sentinel persona name so
      // the e2e suite can render the typed affordance without flipping the flag.
      if (pName === 'no-creds') {
        return errorResult('CREDENTIALS_MISSING', 'Required model credentials are missing');
      }
      // Reject a second concurrent compile for the same persona.
      for (const op of activeCompiles.values()) {
        if (op.name === pName) {
          return errorResult('COMPILE_IN_PROGRESS', `A compile is already running for "${pName}"`);
        }
      }
      const operationId = mintOperationId();
      const op: MockCompileOperation = {
        operationId,
        name: pName,
        phase: 'started',
        startedAt: new Date().toISOString(),
        actor: 'web:mock',
      };
      activeCompiles.set(operationId, op);
      // The `slow-compile` sentinel emits started + one progress event but never
      // reaches a terminal phase, so it stays in `active` -- letting the e2e
      // suite reconnect and verify the in-flight card rehydrates via listCompiles.
      if (pName === 'slow-compile') {
        broadcast('persona.compile.started', { name: op.name, operationId, actor: op.actor });
        compileTimers.push(
          setTimeout(() => {
            const live = activeCompiles.get(operationId);
            if (!live) return;
            live.phase = 'running';
            live.serverProgress = {
              server: 'filesystem',
              compilationPhase: 'scenarios',
              detail: 'generating scenarios',
            };
            broadcast('persona.compile.progress', {
              name: live.name,
              operationId,
              serverName: 'filesystem',
              phase: 'scenarios',
              detail: 'generating scenarios',
            });
          }, 150),
        );
      } else if (pName === 'fail-compile') {
        broadcast('persona.compile.started', { name: op.name, operationId, actor: op.actor });
        compileTimers.push(
          setTimeout(() => {
            const live = activeCompiles.get(operationId);
            if (!live) return;
            live.phase = 'failed';
            live.endedAt = new Date().toISOString();
            live.error = { code: 'COMPILE_FAILED', message: 'Scenario verification did not converge' };
            activeCompiles.delete(operationId);
            recordRecentCompile(live);
            broadcast('persona.compile.failed', {
              name: live.name,
              operationId,
              code: 'COMPILE_FAILED',
              error: 'Scenario verification did not converge',
            });
          }, 300),
        );
      } else {
        simulateCompile(op);
      }
      return { accepted: true, name: pName, operationId };
    }

    case 'personas.getCompile': {
      const operationId = params.operationId as string;
      if (typeof operationId !== 'string' || operationId.length === 0) {
        return errorResult('INVALID_PARAMS', 'operationId is required');
      }
      const op = activeCompiles.get(operationId) ?? recentCompiles.get(operationId);
      if (!op) return errorResult('COMPILE_NOT_FOUND', `Compile operation ${operationId} not found`);
      return op;
    }

    case 'personas.listCompiles': {
      return {
        active: [...activeCompiles.values()],
        recent: [...recentCompiles.values()],
        queueDepth: 0,
      };
    }

    // -----------------------------------------------------------------------
    // Phase 1c persona CRUD. All gated on allowPolicyMutation; the gate fires
    // BEFORE any other validation (mirrors requirePolicyMutation in the daemon).
    // Each mutation broadcasts personas.changed.
    // -----------------------------------------------------------------------

    case 'personas.create': {
      const gate = requireMutation();
      if (gate) return gate;
      const cName = params.name as string;
      const cDesc = params.description as string;
      if (typeof cName !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(cName) || cName.length > 63) {
        return errorResult('INVALID_PARAMS', `Invalid persona name: ${cName}`);
      }
      if (typeof cDesc !== 'string' || cDesc.trim().length === 0) {
        return errorResult('INVALID_PARAMS', 'description is required');
      }
      if (CANNED_PERSONA_DETAILS[cName]) {
        return errorResult('PERSONA_EXISTS', `Persona "${cName}" already exists`);
      }
      const cServers = Array.isArray(params.servers) ? (params.servers as string[]) : undefined;
      const cMemory = params.memoryEnabled === undefined ? true : params.memoryEnabled === true;
      const cConstitution = typeof params.constitution === 'string' ? params.constitution : '';
      const newDetail: MockPersonaDetail = {
        name: cName,
        description: cDesc.trim(),
        createdAt: new Date().toISOString(),
        constitution: cConstitution,
        ...(cServers && cServers.length > 0 ? { servers: cServers } : {}),
        hasPolicy: false,
        memory: cMemory,
        allowBroadPolicy: false,
      };
      CANNED_PERSONA_DETAILS[cName] = newDetail;
      CANNED_PERSONAS.push({ name: cName, description: cDesc.trim(), compiled: false, memory: cMemory });
      broadcast('personas.changed', {});
      return newDetail;
    }

    case 'personas.editConstitution': {
      const gate = requireMutation();
      if (gate) return gate;
      const eName = params.name as string;
      const eConstitution = params.constitution as string;
      const ed = CANNED_PERSONA_DETAILS[eName];
      if (!ed) return errorResult('PERSONA_NOT_FOUND', `Persona "${eName}" not found`);
      ed.constitution = typeof eConstitution === 'string' ? eConstitution : '';
      broadcast('personas.changed', {});
      // stale is true iff the persona had a compiled policy that no longer
      // matches the (now-changed) constitution.
      return { stale: ed.hasPolicy };
    }

    case 'personas.setMemory': {
      const gate = requireMutation();
      if (gate) return gate;
      const mName = params.name as string;
      const md = CANNED_PERSONA_DETAILS[mName];
      if (!md) return errorResult('PERSONA_NOT_FOUND', `Persona "${mName}" not found`);
      md.memory = params.enabled === true;
      const listItem = CANNED_PERSONAS.find((p) => p.name === mName);
      if (listItem) listItem.memory = md.memory;
      broadcast('personas.changed', {});
      return md;
    }

    case 'personas.setBroadPolicyOptIn': {
      const gate = requireMutation();
      if (gate) return gate;
      const bName = params.name as string;
      const bd = CANNED_PERSONA_DETAILS[bName];
      if (!bd) return errorResult('PERSONA_NOT_FOUND', `Persona "${bName}" not found`);
      bd.allowBroadPolicy = params.enabled === true;
      broadcast('personas.changed', {});
      return bd;
    }

    case 'personas.delete': {
      const gate = requireMutation();
      if (gate) return gate;
      const dName = params.name as string;
      if (params.confirmed !== true) {
        return errorResult('INVALID_PARAMS', 'confirmed must be true');
      }
      if (!CANNED_PERSONA_DETAILS[dName]) {
        return errorResult('PERSONA_NOT_FOUND', `Persona "${dName}" not found`);
      }
      // Soft (default) and hard (force) both remove the persona from the listed
      // set in the mock; the real daemon distinguishes trash vs rmSync but the
      // observable effect over the wire (gone from list) is the same.
      delete CANNED_PERSONA_DETAILS[dName];
      CANNED_PERSONAS = CANNED_PERSONAS.filter((p) => p.name !== dName);
      broadcast('personas.changed', {});
      return { deleted: true };
    }

    // -----------------------------------------------------------------------
    // Config (modelProviders). Read is ungated; the write is gated on
    // allowPolicyMutation and applies the M5/F7/F10 contract, then broadcasts
    // config.changed (mirrors config-dispatch.ts).
    // -----------------------------------------------------------------------

    case 'config.getModelProviders':
      return buildModelProvidersDto();

    case 'config.setModelProviders': {
      const gate = requireMutation();
      if (gate) return gate;
      const applied = applySetModelProviders(params);
      if (applied) return applied;
      broadcast('config.changed', {});
      return buildModelProvidersDto();
    }

    // Ungated read of the OpenRouter catalog. Source is env-toggled (see
    // MOCK_OPENROUTER_SOURCE near MOCK_SLUGS) so both validation modes are
    // reachable offline; defaults to 'live' (hard-block path).
    case 'config.listOpenrouterModels':
      return { models: MOCK_SLUGS, source: resolveMockOpenrouterSource() };

    // Workflow methods
    case 'workflows.listDefinitions':
      // Mirrors the daemon: hidden (smoke/fixture) workflows are never returned
      // here, and each entry carries `hasReadme`.
      return [
        {
          name: 'design-and-code',
          description: 'Plan -> Design -> Implement -> Review workflow',
          path: '/opt/ironcurtain/workflows/design-and-code/workflow.yaml',
          source: 'bundled',
          hasReadme: README_WORKFLOW_NAMES.has('design-and-code'),
        },
        {
          name: 'code-review',
          description: 'Automated code review with multiple reviewers',
          path: '/opt/ironcurtain/workflows/code-review/workflow.yaml',
          source: 'bundled',
          hasReadme: README_WORKFLOW_NAMES.has('code-review'),
        },
        {
          name: 'my-custom-flow',
          description: 'Custom workflow for internal tooling',
          path: '/home/user/.ironcurtain/workflows/my-custom-flow/workflow.yaml',
          source: 'user',
          hasReadme: README_WORKFLOW_NAMES.has('my-custom-flow'),
        },
      ];

    case 'workflows.list': {
      if (replayConfig) {
        return replayController ? [replayController.getStatus()] : [];
      }
      // Suppress hidden workflows' runs, mirroring the daemon.
      return [...workflows.values()].filter((wf) => !HIDDEN_WORKFLOW_NAMES.has(wf.name));
    }

    case 'workflows.get': {
      if (replayConfig) {
        if (!replayController) return errorResult('WORKFLOW_NOT_FOUND', 'No active replay');
        return replayController.getDetail();
      }
      const wfId = params.workflowId as string;
      const wf = workflows.get(wfId);
      if (!wf) return errorResult('WORKFLOW_NOT_FOUND', `Workflow ${wfId} not found`);
      const gate = [...workflowGates.values()].find((g) => g.workflowId === wfId);
      return buildWorkflowDetailDto(wf, gate);
    }

    case 'workflows.start': {
      if (replayConfig && replayPlan) {
        if (replayController?.isActive()) {
          return errorResult('INVALID_PARAMS', 'Replay already in progress');
        }
        replayController = createReplayController(replayPlan, broadcast, replayConfig.speedup);
        replayController.start();
        return { workflowId: replayPlan.workflowId };
      }
      const newId = `wf-mock-${Date.now()}`;
      const newWf: MockWorkflow = {
        workflowId: newId,
        name:
          String(params.definitionPath)
            .split('/')
            .pop()
            ?.replace(/\.(json|ya?ml)$/, '') ?? 'workflow',
        phase: 'running',
        currentState: 'plan',
        startedAt: new Date().toISOString(),
      };
      workflows.set(newId, newWf);
      broadcast('workflow.started', {
        workflowId: newId,
        name: newWf.name,
        taskDescription: String(params.taskDescription ?? ''),
      });
      const planSessionId = `${newId}-plan-${Date.now()}`;
      broadcast('workflow.agent_started', {
        workflowId: newId,
        stateId: 'plan',
        persona: 'planner',
        sessionId: planSessionId,
      });
      broadcast('workflow.state_entered', { workflowId: newId, state: 'plan' });

      trackTimer(
        newId,
        setTimeout(() => {
          const wf = workflows.get(newId);
          if (wf && wf.phase === 'running') {
            broadcast('workflow.agent_completed', {
              workflowId: newId,
              stateId: 'plan',
              verdict: 'success',
              confidence: '0.87',
            });
            broadcast('workflow.agent_session_ended', makeAgentSessionEndedPayload(newId, 'plan', planSessionId));
            wf.currentState = 'plan_review';
            wf.phase = 'waiting_human';
            const gateId = `${newId}-plan_review`;
            const gate: MockGate = {
              gateId,
              workflowId: newId,
              stateName: 'plan_review',
              acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'REPLAN', 'ABORT'],
              presentedArtifacts: ['plan.md'],
              summary: 'The planner has produced an implementation plan. Please review and approve.',
            };
            workflowGates.set(gateId, gate);
            broadcast('workflow.state_entered', { workflowId: newId, state: 'plan_review' });
            broadcast('workflow.gate_raised', {
              workflowId: newId,
              gate: {
                gateId,
                workflowId: newId,
                stateName: gate.stateName,
                acceptedEvents: gate.acceptedEvents,
                presentedArtifacts: gate.presentedArtifacts,
                summary: gate.summary,
              },
            });
          }
        }, 4000),
      );

      return { workflowId: newId };
    }

    case 'workflows.abort': {
      if (replayConfig && replayController) {
        replayController.abort();
        replayController = null;
        return undefined;
      }
      const abortId = params.workflowId as string;
      const abortWf = workflows.get(abortId);
      if (!abortWf) return errorResult('WORKFLOW_NOT_FOUND', `Workflow ${abortId} not found`);
      abortWf.phase = 'aborted';
      abortWf.currentState = 'aborted';
      clearWorkflowTimers(abortId);
      for (const [gateId, gate] of workflowGates) {
        if (gate.workflowId === abortId) workflowGates.delete(gateId);
      }
      broadcast('workflow.failed', { workflowId: abortId, error: 'Workflow aborted by user' });
      return undefined;
    }

    case 'workflows.resolveGate': {
      if (replayConfig && replayController) {
        const rEvent = params.event as string;
        const rPrompt = params.prompt as string | undefined;
        replayController.resolveGate(rEvent, rPrompt);
        return undefined;
      }
      const resolveWfId = params.workflowId as string;
      const resolveEvent = params.event as string;
      const resolveWf = workflows.get(resolveWfId);
      if (!resolveWf) return errorResult('WORKFLOW_NOT_FOUND', `Workflow ${resolveWfId} not found`);
      if (resolveWf.phase !== 'waiting_human') {
        return errorResult('WORKFLOW_NOT_AT_GATE', `Workflow ${resolveWfId} is not waiting at a gate`);
      }
      // Dismiss gate and resume
      for (const [gateId, gate] of workflowGates) {
        if (gate.workflowId === resolveWfId) {
          workflowGates.delete(gateId);
          broadcast('workflow.gate_dismissed', { workflowId: resolveWfId, gateId });
        }
      }

      if (resolveEvent === 'ABORT') {
        resolveWf.phase = 'aborted';
        resolveWf.currentState = 'aborted';
        broadcast('workflow.failed', { workflowId: resolveWfId, error: 'Workflow aborted by user' });
      } else {
        const nextState = resolveEvent === 'FORCE_REVISION' ? 'plan' : 'implement';
        resolveWf.phase = 'running';
        resolveWf.currentState = nextState;
        const nextPersona = nextState === 'plan' ? 'planner' : 'coder';
        const nextSessionId = `${resolveWfId}-${nextState}-${Date.now()}`;
        broadcast('workflow.agent_started', {
          workflowId: resolveWfId,
          stateId: nextState,
          persona: nextPersona,
          sessionId: nextSessionId,
        });
        broadcast('workflow.state_entered', { workflowId: resolveWfId, state: nextState });

        trackTimer(
          resolveWfId,
          setTimeout(() => {
            const wf = workflows.get(resolveWfId);
            if (wf && wf.phase === 'running') {
              broadcast('workflow.agent_completed', {
                workflowId: resolveWfId,
                stateId: nextState,
                verdict: 'success',
                confidence: '0.79',
              });
              broadcast(
                'workflow.agent_session_ended',
                makeAgentSessionEndedPayload(resolveWfId, nextState, nextSessionId),
              );
              if (nextState === 'implement') {
                wf.currentState = 'review';
                broadcast('workflow.state_entered', { workflowId: resolveWfId, state: 'review' });
              }
            }
          }, 3000),
        );
      }
      return undefined;
    }

    case 'workflows.listResumable': {
      if (replayConfig) return [];
      // Suppress hidden workflows' past runs, mirroring the daemon.
      return buildPastRunFixtures().filter((r) => !HIDDEN_WORKFLOW_NAMES.has(r.name));
    }

    case 'workflows.messageLog': {
      const wfId = params.workflowId as string | undefined;
      if (typeof wfId !== 'string' || wfId.length === 0) {
        return errorResult('INVALID_PARAMS', 'workflowId is required');
      }
      const before = typeof params.before === 'string' ? params.before : undefined;
      const limitParam = params.limit;
      const limit =
        typeof limitParam === 'number' && Number.isFinite(limitParam) && limitParam > 0
          ? Math.min(Math.floor(limitParam), 2000)
          : 200;
      const all = buildMessageLogFixtures(wfId);
      const filtered = before === undefined ? all : all.filter((e) => e.ts < before);
      // Newest-first
      filtered.sort((a, b) => (a.ts === b.ts ? 0 : a.ts < b.ts ? 1 : -1));
      const entries = filtered.slice(0, limit);
      let hasMore = false;
      if (entries.length === limit) {
        const cursor = entries[entries.length - 1].ts;
        hasMore = filtered.some((e) => e.ts < cursor);
      }
      return { entries, hasMore };
    }

    case 'workflows.readme': {
      const definitionPath = typeof params.definitionPath === 'string' ? params.definitionPath : undefined;
      const wfId = typeof params.workflowId === 'string' ? params.workflowId : undefined;
      // Match the daemon's Zod refine: exactly one address form (not zero, not both).
      if ((definitionPath ? 1 : 0) + (wfId ? 1 : 0) !== 1) {
        return errorResult('INVALID_PARAMS', 'Provide exactly one of definitionPath or workflowId');
      }
      // Resolve the workflow name from whichever address form was provided.
      let name: string | undefined;
      if (definitionPath) {
        // Mock manifest paths look like `.../<name>/workflow.yaml`.
        name = definitionPath.match(/\/([^/]+)\/workflow\.ya?ml$/)?.[1];
      } else if (wfId) {
        name = workflows.get(wfId)?.name ?? buildPastRunFixtures().find((r) => r.workflowId === wfId)?.name;
      }
      if (name && README_WORKFLOW_NAMES.has(name)) {
        return { content: MOCK_README };
      }
      return errorResult('README_NOT_FOUND', `No README for ${name ?? 'workflow'}`);
    }

    case 'workflows.import':
      return { workflowId: 'wf-imported-001' };

    case 'workflows.resume':
      return { accepted: true, workflowId: params.workflowId as string };

    case 'workflows.inspect':
      return { accepted: true };

    case 'workflows.fileTree': {
      const relPath = (params.path as string) ?? '';
      if (relPath === 'src') return CANNED_FILE_TREE_SRC;
      if (relPath === '.workflow') return CANNED_FILE_TREE_WORKFLOW;
      if (relPath === '') return CANNED_FILE_TREE;
      // Sub-paths return empty
      return { entries: [] };
    }

    case 'workflows.fileContent': {
      const filePath = params.path as string;
      const fc = CANNED_FILE_CONTENTS[filePath];
      if (!fc) return errorResult('INVALID_PARAMS', `File not found: ${filePath}`);
      return fc;
    }

    case 'workflows.artifacts': {
      const artName = params.artifactName as string;
      const art = CANNED_ARTIFACTS[artName];
      if (!art) return errorResult('ARTIFACT_NOT_FOUND', `Artifact "${artName}" not found`);
      return art;
    }

    case '__reset': {
      resetState();
      return undefined;
    }

    default:
      return errorResult('METHOD_NOT_FOUND', `Unknown method: ${method}`);
  }
}

/** Sentinel used to distinguish RPC errors from normal return values. */
type RpcErrorResult = { __rpcError: true; code: string; message: string };

function errorResult(code: string, message: string): RpcErrorResult {
  return { __rpcError: true, code, message };
}

/**
 * Kill-switch gate shared by all Phase 1c persona-mutation methods. Returns an
 * RpcError when the mock's `allowPolicyMutation` flag is OFF (set via the
 * POST /__reset override), else undefined. Mirrors requirePolicyMutation in the
 * daemon dispatch: the gate fires BEFORE any other validation.
 */
function requireMutation(): RpcErrorResult | undefined {
  if (!allowPolicyMutation) {
    return errorResult('POLICY_MUTATION_FORBIDDEN', 'Policy mutation is not enabled on this daemon');
  }
  return undefined;
}

function isRpcError(value: unknown): value is RpcErrorResult {
  return typeof value === 'object' && value !== null && '__rpcError' in value;
}

// ---------------------------------------------------------------------------
// WebSocket + HTTP server (shared port for WS upgrade and /ws/auth preflight)
// ---------------------------------------------------------------------------

/**
 * Simulate the daemon's bearer-token check. Real daemon uses a 32-byte
 * random token; here we just compare to the well-known mock token so
 * E2E tests can exercise the bad-token path.
 */
function isMockTokenValid(token: string | null): boolean {
  return token === MOCK_TOKEN;
}

const wsHttpServer = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/ws/auth') {
    const token = url.searchParams.get('token');
    // CORS is not needed in production (Vite proxies same-origin), but
    // is convenient when a test hits this endpoint directly from another
    // origin. Keep it permissive for the mock only.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (isMockTokenValid(token)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{"ok":false,"error":"invalid_token"}');
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ noServer: true });

wsHttpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  const token = url.searchParams.get('token');
  if (!isMockTokenValid(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wsHttpServer.listen(PORT);

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`  Client connected (${clients.size} total)`);

  // In replay mode, auto-start the replay when the first client connects
  // so the user immediately sees a running workflow without needing to
  // fill out the Start Workflow form.
  if (replayConfig && replayPlan && !replayController) {
    replayController = createReplayController(replayPlan, broadcast, replayConfig.speedup);
    replayController.start();
    console.log('  Replay auto-started on first client connection');
  }

  ws.on('message', (raw) => {
    let frame: RequestFrame;
    try {
      frame = JSON.parse(raw.toString()) as RequestFrame;
    } catch {
      return;
    }

    const result = handleMethod(ws, frame.method, frame.params ?? {});

    let response: ResponseFrame;
    if (isRpcError(result)) {
      response = { id: frame.id, ok: false, error: { code: result.code, message: result.message } };
    } else {
      response = { id: frame.id, ok: true, ...(result !== undefined ? { payload: result } : {}) };
    }

    ws.send(JSON.stringify(response));
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`  Client disconnected (${clients.size} total)`);
  });
});

// HTTP server for test-only endpoints (e.g., state reset, workflow event injection)
const RESET_PORT = parseInt(process.env.RESET_PORT ?? '7401', 10);
const httpServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__reset') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      let opts: ResetOptions | undefined;
      if (body.trim().length > 0) {
        try {
          opts = JSON.parse(body) as ResetOptions;
        } catch {
          opts = undefined;
        }
      }
      resetState(opts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  } else if (req.method === 'POST' && req.url === '/__workflow-event') {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const { event, payload } = JSON.parse(body) as { event: string; payload: unknown };
        broadcast(event, payload);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(404);
    res.end();
  }
});
httpServer.listen(RESET_PORT);

// Periodic status broadcast
setInterval(() => {
  broadcast('daemon.status', buildStatusDto());
}, 10_000);

if (replayConfig && replayPlan) {
  const jsonlName = replayConfig.jsonlPath.split('/').pop();
  console.log(`
  Mock WS server listening on port ${PORT}
  Replay mode: ${jsonlName} (${replayPlan.entries.length} entries, speedup: ${replayConfig.speedup}x)

  Open the web UI with this URL:
    http://localhost:5173/?token=${MOCK_TOKEN}
`);
} else {
  console.log(`
  Mock WebSocket server listening on ws://127.0.0.1:${PORT}

  Open the web UI with this URL:
    http://localhost:5173/?token=${MOCK_TOKEN}

  Two-terminal workflow:
    Terminal 1: cd packages/web-ui && npm run mock-server
    Terminal 2: cd packages/web-ui && npm run dev

  Session mode: container (web-pty terminals)
`);
}
