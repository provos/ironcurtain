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
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { parseArgs } from 'util';
import { loadReplayPlan, createReplayController, type ReplayController, type ReplayPlan } from './replay-engine.js';
import {
  createScenarioRunner,
  loadCorpusFromText,
  validateScenario,
  type Scenario,
  type ScenarioRunner,
} from './scenario-runner.js';

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
  if (values.definition) {
    definitionPath = resolve(values.definition);
  }

  // Speedup factor
  const speedup = Math.max(1, parseInt(values.speedup ?? '50', 10) || 50);

  return { jsonlPath, definitionPath, speedup };
}

const replayConfig = parseReplayArgs();
const replayPlan: ReplayPlan | null = replayConfig
  ? loadReplayPlan(replayConfig.jsonlPath, replayConfig.definitionPath)
  : null;
let replayController: ReplayController | null = null;

// ---------------------------------------------------------------------------
// Scenario mode CLI parsing
// ---------------------------------------------------------------------------

interface ScenarioServerConfig {
  readonly defaultScenarioName: string;
}

function parseScenarioArgs(): ScenarioServerConfig {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: 'default' },
    },
    allowPositionals: true,
    strict: false,
  });
  const name = typeof values.scenario === 'string' && values.scenario.length > 0 ? values.scenario : 'default';
  return { defaultScenarioName: name };
}

const scenarioConfig = parseScenarioArgs();

/**
 * Load scenarios + corpus eagerly so malformed JSON surfaces at server start,
 * not on first client connection. A missing requested scenario falls back to
 * `default` with a logged warning; a missing `default` is a hard error.
 */
const SCENARIOS_DIR = resolve(__scriptDir, 'scenarios');
const FIXTURES_DIR = resolve(__scriptDir, 'fixtures');
const scenarioCache = new Map<string, Scenario>();

function loadScenarioByName(name: string): Scenario | null {
  if (scenarioCache.has(name)) return scenarioCache.get(name)!;
  const path = resolve(SCENARIOS_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    const scenario = validateScenario(raw);
    scenarioCache.set(name, scenario);
    return scenario;
  } catch (err) {
    console.warn(`  Failed to load scenario "${name}": ${(err as Error).message}`);
    return null;
  }
}

function loadCorpusByName(name: string): ReturnType<typeof loadCorpusFromText> {
  const path = resolve(FIXTURES_DIR, `mock-stream-corpus.txt`);
  // The scenario's `corpus` field is currently decorative; we ship a single
  // corpus file. Kept as an explicit parameter to future-proof multi-corpus.
  void name;
  return loadCorpusFromText(readFileSync(path, 'utf-8'));
}

const corpusSingleton = loadCorpusByName('default');

// Per-client scenario runners. Started on `sessions.subscribeAllTokenStreams`
// so E2E tests (which never subscribe) see the existing canned behavior.
const clientRunners = new WeakMap<WebSocket, ScenarioRunner>();

interface ClientScenarioOptions {
  readonly scenarioName: string;
  readonly speedMultiplier: number;
  readonly loop: boolean;
}

const clientScenarioOptions = new WeakMap<WebSocket, ClientScenarioOptions>();

function parseScenarioQueryParams(url: URL): ClientScenarioOptions {
  const rawName = url.searchParams.get('scenario');
  const rawSpeed = url.searchParams.get('speed');
  const rawLoop = url.searchParams.get('loop');
  const scenarioName = rawName && rawName.length > 0 ? rawName : scenarioConfig.defaultScenarioName;
  const speedMultiplier = rawSpeed ? Math.max(0.01, parseFloat(rawSpeed)) || 1 : 1;
  const loop = rawLoop === 'true' || rawLoop === '1';
  return { scenarioName, speedMultiplier, loop };
}

function startScenarioRunnerForClient(ws: WebSocket): void {
  // Idempotent: a client that subscribes twice keeps its existing runner.
  if (clientRunners.has(ws)) return;

  const opts = clientScenarioOptions.get(ws) ?? {
    scenarioName: scenarioConfig.defaultScenarioName,
    speedMultiplier: 1,
    loop: false,
  };

  let scenario = loadScenarioByName(opts.scenarioName);
  if (!scenario && opts.scenarioName !== 'default') {
    console.warn(`  Scenario "${opts.scenarioName}" not found; falling back to "default"`);
    scenario = loadScenarioByName('default');
  }
  if (!scenario) {
    console.error('  No default scenario available; synthetic events disabled for this client');
    return;
  }

  const runner = createScenarioRunner(scenario, corpusSingleton, {
    speedMultiplier: opts.speedMultiplier,
    loop: opts.loop,
  });
  runner.start((event, payload) => emit(ws, event, payload));
  clientRunners.set(ws, runner);
}

function stopScenarioRunnerForClient(ws: WebSocket): void {
  const runner = clientRunners.get(ws);
  if (runner) {
    runner.stop();
    clientRunners.delete(ws);
  }
}

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

const CANNED_PERSONAS = [
  { name: 'default', description: 'General-purpose assistant with standard policy', compiled: true },
  { name: 'researcher', description: 'Read-only access focused on code analysis', compiled: true },
  { name: 'devops', description: 'Infrastructure and deployment operations', compiled: false },
];

const CANNED_PERSONA_DETAILS: Record<string, unknown> = {
  default: {
    name: 'default',
    description: 'General-purpose assistant with standard policy',
    createdAt: new Date(Date.now() - 30 * 86400_000).toISOString(),
    constitution:
      '# Default Persona\n\n## Principles\n\n- Allow read operations on all files\n- Escalate write operations to protected paths\n- Allow git read operations\n- Escalate destructive git operations\n',
    servers: ['filesystem', 'git'],
    hasPolicy: true,
    policyRuleCount: 12,
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
  },
  devops: {
    name: 'devops',
    description: 'Infrastructure and deployment operations',
    createdAt: new Date(Date.now() - 7 * 86400_000).toISOString(),
    constitution:
      '# DevOps Persona\n\n## Principles\n\n- Allow Docker operations\n- Allow deployment scripts\n- Escalate infrastructure changes\n',
    servers: ['filesystem', 'git', 'github'],
    hasPolicy: false,
  },
};

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
    // Must match a node id in CODE_REVIEW_GRAPH (`analyze`, `report_review`,
    // `completed`); using a design-and-code state here left the mock workflow
    // with no active node highlight and was the forcing function for Fix #2.
    currentState: 'report_review',
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
  // Add a gate for the waiting workflow. stateName matches the CODE_REVIEW_GRAPH
  // human_gate node so the graph's active-node highlight resolves correctly.
  const gateId = 'wf-mock-002-report_review';
  workflowGates.set(gateId, {
    gateId,
    workflowId: 'wf-mock-002',
    stateName: 'report_review',
    acceptedEvents: ['APPROVE', 'FORCE_REVISION', 'ABORT'],
    presentedArtifacts: ['report'],
    summary: 'Waiting for human review at report_review',
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
  };
}

// Mutable copy of canned jobs so enable/disable/remove are stateful
const jobs = structuredClone(CANNED_JOBS);

/** Reset all mutable state for test isolation. */
function resetState(): void {
  sessions.clear();
  escalations.clear();
  nextLabel = 1;
  eventSeq = 0;
  jobs.length = 0;
  jobs.push(...structuredClone(CANNED_JOBS));
  initWorkflows();
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

function buildSessionDto(session: MockSession) {
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
  };
}

function buildEscalationDto(esc: MockEscalation) {
  return {
    ...esc,
    sessionSource: { kind: 'web' as const },
  };
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
      };
      sessions.set(label, session);
      broadcast('session.created', buildSessionDto(session));
      return { label };
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

    case 'personas.compile': {
      const pName = params.name as string;
      if (!CANNED_PERSONA_DETAILS[pName]) return errorResult('PERSONA_NOT_FOUND', `Persona "${pName}" not found`);
      // Simulate compilation success
      return { success: true, ruleCount: 10 + Math.floor(Math.random() * 10) };
    }

    // Workflow methods
    case 'workflows.listDefinitions':
      return [
        {
          name: 'design-and-code',
          description: 'Plan -> Design -> Implement -> Review workflow',
          path: '/opt/ironcurtain/workflows/design-and-code.yaml',
          source: 'bundled',
        },
        {
          name: 'code-review',
          description: 'Automated code review with multiple reviewers',
          path: '/opt/ironcurtain/workflows/code-review.yaml',
          source: 'bundled',
        },
        {
          name: 'my-custom-flow',
          description: 'Custom workflow for internal tooling',
          path: '/home/user/.ironcurtain/workflows/my-custom-flow.yaml',
          source: 'user',
        },
      ];

    case 'workflows.list': {
      if (replayConfig) {
        return replayController ? [replayController.getStatus()] : [];
      }
      return [...workflows.values()];
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
              notes: 'drafted a 4-step implementation plan covering data model, API, UI, and tests',
            });
            broadcast('workflow.agent_session_ended', {
              workflowId: newId,
              stateId: 'plan',
              sessionId: planSessionId,
            });
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
        // Graph-aware next-state lookup so both wf-mock-001 (design-and-code)
        // and wf-mock-002 (code-review) transition into valid node ids.
        // Prior behaviour hardcoded `plan`/`implement`, which broke the
        // code-review graph's active-node highlight after a gate resolve.
        const isDesign = resolveWf.name.includes('design');
        let nextState: string;
        let nextPersona: string;
        let followupState: string | null = null;
        let completionNotes = '';
        if (isDesign) {
          nextState = resolveEvent === 'FORCE_REVISION' ? 'plan' : 'implement';
          nextPersona = nextState === 'plan' ? 'planner' : 'coder';
          completionNotes =
            nextState === 'plan'
              ? 'revised plan incorporating reviewer feedback on error handling'
              : 'implemented all modules with full test coverage';
          if (nextState === 'implement') {
            followupState = 'review';
          }
        } else {
          // code-review: APPROVE → completed terminal; FORCE_REVISION → re-run analyze.
          nextState = resolveEvent === 'FORCE_REVISION' ? 'analyze' : 'completed';
          nextPersona = 'reviewer';
          completionNotes =
            nextState === 'analyze'
              ? 're-analyzed the codebase incorporating reviewer feedback'
              : 'code review completed successfully';
        }
        resolveWf.phase = 'running';
        resolveWf.currentState = nextState;
        // Terminal nodes (e.g. `completed`) emit state_entered but no agent_started,
        // since no persona runs in a terminal.
        const nextSessionId =
          nextState !== 'completed' && nextState !== 'aborted' ? `${resolveWfId}-${nextState}-${Date.now()}` : null;
        if (nextSessionId !== null) {
          broadcast('workflow.agent_started', {
            workflowId: resolveWfId,
            stateId: nextState,
            persona: nextPersona,
            sessionId: nextSessionId,
          });
        }
        broadcast('workflow.state_entered', { workflowId: resolveWfId, state: nextState });

        if (nextState === 'completed') {
          resolveWf.phase = 'completed';
          return undefined;
        }

        trackTimer(
          resolveWfId,
          setTimeout(() => {
            const wf = workflows.get(resolveWfId);
            if (wf && wf.phase === 'running') {
              broadcast('workflow.agent_completed', {
                workflowId: resolveWfId,
                stateId: nextState,
                verdict: 'success',
                notes: completionNotes,
              });
              if (nextSessionId !== null) {
                broadcast('workflow.agent_session_ended', {
                  workflowId: resolveWfId,
                  stateId: nextState,
                  sessionId: nextSessionId,
                });
              }
              if (followupState) {
                wf.currentState = followupState;
                broadcast('workflow.state_entered', { workflowId: resolveWfId, state: followupState });
              }
            }
          }, 3000),
        );
      }
      return undefined;
    }

    case 'workflows.listResumable': {
      if (replayConfig) return [];
      return [
        {
          workflowId: 'wf-resumable-001',
          lastState: 'plan_review',
          timestamp: new Date(Date.now() - 3600_000).toISOString(),
          taskDescription: 'Implement circle of fifths visualization component with SVG',
          workspacePath: '/home/user/projects/music-app',
        },
        {
          workflowId: 'wf-resumable-002',
          lastState: 'code_review',
          timestamp: new Date(Date.now() - 86400_000).toISOString(),
          taskDescription: 'Add unit tests for authentication middleware',
        },
      ];
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

    case 'sessions.subscribeAllTokenStreams': {
      // Start this client's scenario runner on first subscribe. Unsubscribed
      // clients -- notably E2E tests that never subscribe -- see no scenario
      // events and continue to use the canned workflow emissions.
      startScenarioRunnerForClient(ws);
      return { subscribed: true };
    }

    case 'sessions.unsubscribeAllTokenStreams':
      stopScenarioRunnerForClient(ws);
      return { unsubscribed: true };

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
    // Stash the parsed scenario opts before the 'connection' handler fires
    // so an early subscribe from the client sees the correct configuration.
    clientScenarioOptions.set(ws, parseScenarioQueryParams(url));
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
    stopScenarioRunnerForClient(ws);
    clients.delete(ws);
    console.log(`  Client disconnected (${clients.size} total)`);
  });
});

// HTTP server for test-only endpoints (e.g., state reset, workflow event injection)
const RESET_PORT = parseInt(process.env.RESET_PORT ?? '7401', 10);
const httpServer = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/__reset') {
    resetState();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
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

// Periodic status broadcast. Cadence matches the real daemon
// (src/web-ui/web-ui-server.ts:153) so the mock stays protocol-faithful.
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
  const scenarioLoaded = loadScenarioByName(scenarioConfig.defaultScenarioName);
  const scenarioLabel = scenarioLoaded
    ? `"${scenarioConfig.defaultScenarioName}" (${scenarioLoaded.description})`
    : `"${scenarioConfig.defaultScenarioName}" (NOT FOUND -- falling back to "default" per-client)`;
  console.log(`
  Mock WebSocket server listening on ws://127.0.0.1:${PORT}
  Default scenario: ${scenarioLabel}

  Open the web UI with this URL:
    http://localhost:5173/?token=${MOCK_TOKEN}

  Override per client with query params:
    ?scenario=rapid-transitions
    ?scenario=long-state&speed=4
    ?scenario=default&loop=true

  Two-terminal workflow:
    Terminal 1: cd packages/web-ui && npm run mock-server [-- --scenario <name>]
    Terminal 2: cd packages/web-ui && npm run dev
`);
}
