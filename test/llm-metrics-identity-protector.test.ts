import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { getLlmMetricsEventBus } from '../src/llm-metrics/event-bus.js';
import { createPersistenceIdentityProtector } from '../src/llm-metrics/identity-protector.js';
import { acquireLlmMetricsRuntime, type LlmMetricsRuntimeLease } from '../src/llm-metrics/runtime.js';
import type { LlmExchangeCompleted } from '../src/llm-metrics/types.js';

const execFileAsync = promisify(execFile);
const BASE_TIME = Date.parse('2026-08-15T12:00:00.000Z');

const RAW = {
  conversation: 'conversation-CONVERSATION_CANARY',
  profile: 'profile-PROFILE_CANARY',
  persona: 'persona-PERSONA_CANARY',
  state: 'state-STATE_CANARY',
  agent: 'agent-AGENT_CANARY',
  privateRoute: 'private-host-ROUTE_CANARY.internal',
  unsafeModel: 'unsafe model MODEL_CANARY',
  unsafeProvider: 'provider#PROVIDER_CANARY',
} as const;

function exchange(): LlmExchangeCompleted {
  return {
    schemaVersion: 1,
    exchangeId: 'exchange-generated-1',
    attribution: {
      sessionId: 'session-generated-1',
      agentConversationId: RAW.conversation,
      turnId: 'turn-generated-1',
      bundleId: 'bundle-generated-1',
      workflowRunId: 'workflow-generated-1',
      stateId: RAW.state,
      personaId: RAW.persona,
      agentId: RAW.agent,
      quality: 'exact',
    },
    route: {
      logicalProvider: RAW.unsafeProvider,
      providerProfileId: RAW.profile,
      protocol: 'openai-responses',
      gatewayKind: 'opaque',
      clientRouteId: 'api.openai.com',
      upstreamRouteId: RAW.privateRoute,
    },
    identity: {
      requestedModel: { value: RAW.unsafeModel, source: 'request' },
      forwardedModel: { value: 'public-model-1', source: 'forwarded_request' },
      responseModel: { value: 'public-model-1', source: 'protocol_response' },
      servedModel: { value: 'public-model-1', source: 'router_metadata' },
      servedProvider: { value: 'Public Provider', source: 'router_metadata' },
    },
    responseMetadata: {
      providerRequestId: 'request-generated-1',
      providerResponseId: 'response-generated-1',
      gatewayGenerationId: 'generation-generated-1',
      actualServiceTier: 'standard',
    },
    request: {
      requestedModel: RAW.unsafeModel,
      streaming: true,
      requestedServiceTier: null,
      reasoningMode: 'disabled',
      reasoningEffort: null,
      thinkingBudgetTokens: null,
      speedMode: null,
      qualityFlags: [],
    },
    outcome: {
      termination: 'stop',
      providerStopReason: 'completed',
      responseStatus: 200,
      refusal: false,
      refusalCategory: null,
      refusalSource: 'not_reported',
    },
    usage: {
      inputTokensReported: 10,
      inputTokensTotal: 10,
      inputTokensAccuracy: 'reported_exact',
      inputTokensUncached: 10,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      toolUseInputTokens: null,
      outputTokensReported: 5,
      outputTokenSemantics: 'no_thinking_breakdown',
      outputTokensTotal: 5,
      outputTokensAccuracy: 'reported_exact',
      thinkingTokens: null,
      thinkingTokensAccuracy: 'unknown',
      nonThinkingOutputTokens: 5,
      nonThinkingOutputTokensAccuracy: 'reported_exact',
      providerTotalTokens: 15,
      canonicalTotalTokens: 15,
      costUsd: null,
      usageSource: 'test',
      usageCompleteness: 'complete',
      usageSemanticsVersion: 1,
      qualityFlags: [],
    },
    timing: {
      requestReceivedAt: new Date(BASE_TIME).toISOString(),
      requestBodyCompleteOffsetMs: 1,
      responseHeadersOffsetMs: 2,
      firstUpstreamBodyByteOffsetMs: 2.5,
      firstProtocolEventOffsetMs: 3,
      firstReasoningEventOffsetMs: null,
      lastReasoningEventOffsetMs: null,
      firstOutputEventOffsetMs: 3,
      lastOutputEventOffsetMs: 4,
      protocolTerminalOffsetMs: 4,
      upstreamResponseEndOffsetMs: 5,
      clientDeliveryEndOffsetMs: 5,
      clientAborted: false,
    },
    transportAttempts: [],
    gatewayRouteAttempts: [
      {
        ordinal: 0,
        provider: RAW.unsafeProvider,
        model: RAW.unsafeModel,
        status: 200,
        selected: true,
        source: 'router_metadata',
      },
    ],
    qualityFlags: [],
  };
}

describe('statistics persistence identity protection', () => {
  const directories: string[] = [];
  const leases: LlmMetricsRuntimeLease[] = [];

  async function temporaryDirectory(prefix = 'ironcurtain-identity-'): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    directories.push(directory);
    return directory;
  }

  afterEach(async () => {
    await Promise.all(leases.splice(0).map((lease) => lease.release()));
    for (const directory of directories.splice(0)) {
      if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
    }
  });

  it('creates one stable 256-bit key with private directory and file permissions', async () => {
    const statisticsDirectory = join(await temporaryDirectory(), 'statistics');
    const first = createPersistenceIdentityProtector(statisticsDirectory);
    const second = createPersistenceIdentityProtector(statisticsDirectory);

    expect(first.protectLabel('profile', 'same-label')).toBe(second.protectLabel('profile', 'same-label'));
    expect(first.protectLabel('profile', 'same-label')).not.toBe(first.protectLabel('persona', 'same-label'));
    expect(first.protectLabel('profile', 'same-label')).toMatch(/^hmac:[a-f0-9]{32}$/);
    expect(statSync(statisticsDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(statisticsDirectory, 'identity.key')).mode & 0o777).toBe(0o600);
    expect(statSync(join(statisticsDirectory, 'identity.key')).size).toBe(32);
  });

  it('publishes exactly one complete key under concurrent multi-process creation', async () => {
    const statisticsDirectory = join(await temporaryDirectory(), 'statistics');
    const moduleUrl = pathToFileURL(resolve('src/llm-metrics/identity-protector.ts')).href;
    const program = [
      `import { createPersistenceIdentityProtector } from ${JSON.stringify(moduleUrl)};`,
      `const protector = createPersistenceIdentityProtector(process.argv[1]);`,
      `process.stdout.write(protector.protectLabel('profile', 'race-label'));`,
    ].join('\n');

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        execFileAsync(process.execPath, [
          '--import',
          'tsx',
          '--input-type=module',
          '--eval',
          program,
          statisticsDirectory,
        ]),
      ),
    );
    expect(new Set(results.map(({ stdout }) => stdout))).toHaveLength(1);
    expect(results[0]?.stdout).toMatch(/^hmac:[a-f0-9]{32}$/);
    expect(statSync(join(statisticsDirectory, 'identity.key')).size).toBe(32);
    expect(statSync(join(statisticsDirectory, 'identity.key')).mode & 0o777).toBe(0o600);
    expect(readdirSync(statisticsDirectory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  }, 20_000);

  it('protects only the durable copy while preserving generated IDs and recognized public origins', async () => {
    const root = await temporaryDirectory('ironcurtain-identity-database-');
    const statisticsDirectory = join(root, 'statistics');
    const databasePath = join(statisticsDirectory, 'llm-usage.sqlite3');
    const lease = await acquireLlmMetricsRuntime(databasePath);
    leases.push(lease);
    let liveExchange: LlmExchangeCompleted | undefined;
    const unsubscribe = getLlmMetricsEventBus().subscribe((event) => {
      liveExchange = event;
    });
    const original = exchange();
    try {
      getLlmMetricsEventBus().publish(original);
      await lease.repository.flush();

      expect(liveExchange).toBe(original);
      expect(original.attribution.personaId).toBe(RAW.persona);
      const rows = await lease.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        exchangeId: 'exchange-generated-1',
        sessionId: 'session-generated-1',
        turnId: 'turn-generated-1',
        bundleId: 'bundle-generated-1',
        workflowRunId: 'workflow-generated-1',
        clientRouteId: 'api.openai.com',
        forwardedModel: 'public-model-1',
        responseModel: 'public-model-1',
        servedProvider: 'Public Provider',
      });
      expect(rows[0]?.agentConversationId).toMatch(/^hmac:/);
      expect(rows[0]?.stateId).toMatch(/^hmac:/);
      expect(rows[0]?.personaId).toMatch(/^hmac:/);
      expect(rows[0]?.agent).toMatch(/^hmac:/);
      expect(rows[0]?.providerProfile).toMatch(/^hmac:/);
      expect(rows[0]?.logicalProvider).toMatch(/^hmac:/);
      expect(rows[0]?.upstreamRouteId).toMatch(/^hmac:/);
      expect(rows[0]?.requestedModel).toMatch(/^hmac:/);

      const databaseFiles = readdirSync(statisticsDirectory).filter((name) => name.startsWith('llm-usage.sqlite3'));
      for (const filename of databaseFiles) {
        const bytes = readFileSync(join(statisticsDirectory, filename));
        for (const canary of Object.values(RAW)) expect(bytes.includes(Buffer.from(canary))).toBe(false);
      }
    } finally {
      unsubscribe();
    }
  });

  it('HMACs private routes and canonicalizes recognized HTTPS public origins without mutating input', async () => {
    const protector = createPersistenceIdentityProtector(join(await temporaryDirectory(), 'statistics'));
    const original = exchange();
    const privateClient = {
      ...original,
      route: {
        ...original.route,
        clientRouteId: RAW.privateRoute,
        upstreamRouteId: 'https://api.openai.com:443/',
      },
    };
    const protectedExchange = protector.protectExchange(privateClient);
    expect(protectedExchange.route.clientRouteId).toMatch(/^hmac:/);
    expect(protectedExchange.route.upstreamRouteId).toBe('api.openai.com');
    expect(privateClient.route.clientRouteId).toBe(RAW.privateRoute);
    expect(JSON.stringify(protectedExchange)).not.toContain('ROUTE_CANARY');
  });
});
