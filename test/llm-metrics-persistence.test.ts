import { readFileSync, rmSync, statSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, it } from 'vitest';

import { LlmStatisticsQueryService } from '../src/llm-metrics/query-service.js';
import { SqliteLlmMetricsRepository } from '../src/llm-metrics/persistence/sqlite-repository.js';
import type { LlmExchangeCompleted } from '../src/llm-metrics/types.js';

const BASE_TIME = Date.parse('2026-08-15T12:00:00.000Z');

function exchange(
  exchangeId: string,
  overrides: {
    readonly startedAtMs?: number;
    readonly sessionId?: string;
    readonly logicalProvider?: string;
    readonly servedModel?: string | null;
    readonly refusal?: boolean | null;
    readonly outcome?: LlmExchangeCompleted['outcome']['termination'];
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
    readonly thinkingTokens?: number | null;
    readonly nonThinkingOutputTokens?: number | null;
    readonly completeness?: LlmExchangeCompleted['usage']['usageCompleteness'];
    readonly clientDeliveryEndOffsetMs?: number | null;
    readonly clientAborted?: boolean;
  } = {},
): LlmExchangeCompleted {
  const inputTokens = overrides.inputTokens === undefined ? 100 : overrides.inputTokens;
  const outputTokens = overrides.outputTokens === undefined ? 40 : overrides.outputTokens;
  return {
    schemaVersion: 1,
    exchangeId,
    attribution: {
      sessionId: overrides.sessionId ?? 'session-1',
      agentConversationId: 'conversation-1',
      turnId: 'turn-1',
      bundleId: 'bundle-1',
      workflowRunId: 'workflow-1',
      stateId: 'state-1',
      personaId: 'persona-1',
      agentId: 'agent-1',
      quality: 'exact',
    },
    route: {
      logicalProvider: overrides.logicalProvider ?? 'openrouter',
      providerProfileId: 'profile-1',
      protocol: 'openai-responses',
      gatewayKind: 'openrouter',
      clientRouteId: 'route-client-1',
      upstreamRouteId: 'route-upstream-1',
    },
    identity: {
      requestedModel: { value: 'requested-model', source: 'request' },
      forwardedModel: { value: 'forwarded-model', source: 'forwarded_request' },
      responseModel: { value: 'response-model', source: 'protocol_response' },
      servedModel: {
        value: overrides.servedModel === undefined ? 'served-model' : overrides.servedModel,
        source: overrides.servedModel === null ? 'not_exposed' : 'router_metadata',
      },
      servedProvider: { value: 'served-provider', source: 'router_metadata' },
    },
    responseMetadata: {
      providerRequestId: 'request-1',
      providerResponseId: 'response-1',
      gatewayGenerationId: 'generation-1',
      actualServiceTier: 'priority',
    },
    request: {
      requestedModel: 'requested-model',
      streaming: true,
      requestedServiceTier: 'priority',
      reasoningMode: 'effort',
      reasoningEffort: 'high',
      thinkingBudgetTokens: null,
      speedMode: 'fast',
      qualityFlags: [],
    },
    outcome: {
      termination: overrides.outcome ?? (overrides.refusal === true ? 'refusal' : 'stop'),
      providerStopReason: overrides.refusal === true ? 'refusal' : 'completed',
      responseStatus: 200,
      refusal: overrides.refusal === undefined ? false : overrides.refusal,
      refusalCategory: overrides.refusal === true ? 'policy' : null,
      refusalSource: overrides.refusal === true ? 'content_item' : 'not_reported',
    },
    usage: {
      inputTokensReported: inputTokens,
      inputTokensTotal: inputTokens,
      inputTokensAccuracy: inputTokens === null ? 'unknown' : 'reported_exact',
      inputTokensUncached: inputTokens === null ? null : inputTokens - 20,
      cacheReadInputTokens: inputTokens === null ? null : 20,
      cacheWriteInputTokens: 0,
      toolUseInputTokens: 0,
      outputTokensReported: outputTokens,
      outputTokenSemantics: 'includes_thinking',
      outputTokensTotal: outputTokens,
      outputTokensAccuracy: outputTokens === null ? 'unknown' : 'reported_exact',
      thinkingTokens: overrides.thinkingTokens === undefined ? 10 : overrides.thinkingTokens,
      thinkingTokensAccuracy: overrides.thinkingTokens === null ? 'unknown' : 'reported_exact',
      nonThinkingOutputTokens: overrides.nonThinkingOutputTokens === undefined ? 30 : overrides.nonThinkingOutputTokens,
      nonThinkingOutputTokensAccuracy: overrides.nonThinkingOutputTokens === null ? 'unknown' : 'derived_exact',
      providerTotalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
      canonicalTotalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
      costUsd: inputTokens === null ? null : 0.001,
      usageSource: 'terminal-event',
      usageCompleteness: overrides.completeness ?? 'complete',
      usageSemanticsVersion: 1,
      qualityFlags: [],
    },
    timing: {
      requestReceivedAt: new Date(overrides.startedAtMs ?? BASE_TIME).toISOString(),
      requestBodyCompleteOffsetMs: 2,
      responseHeadersOffsetMs: 10,
      firstUpstreamBodyByteOffsetMs: 11,
      firstProtocolEventOffsetMs: 20,
      firstReasoningEventOffsetMs: 25,
      lastReasoningEventOffsetMs: 40,
      firstOutputEventOffsetMs: 50,
      lastOutputEventOffsetMs: 150,
      protocolTerminalOffsetMs: 160,
      upstreamResponseEndOffsetMs: 170,
      clientDeliveryEndOffsetMs:
        overrides.clientDeliveryEndOffsetMs === undefined ? 180 : overrides.clientDeliveryEndOffsetMs,
      clientAborted: overrides.clientAborted ?? false,
    },
    transportAttempts: [
      { ordinal: 0, startedOffsetMs: 1, endedOffsetMs: 170, responseStatus: 200, outcome: 'response' },
    ],
    gatewayRouteAttempts: [
      {
        ordinal: 0,
        provider: 'served-provider',
        model: overrides.servedModel === undefined ? 'served-model' : overrides.servedModel,
        status: 200,
        selected: true,
        source: 'router_metadata',
      },
    ],
    qualityFlags: ['router_metadata_present'],
  };
}

describe('SQLite LLM metrics repository', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  async function repository(
    options: Partial<Parameters<typeof SqliteLlmMetricsRepository.open>[0]> = {},
  ): Promise<{ repository: SqliteLlmMetricsRepository; databasePath: string }> {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-metrics-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'statistics', 'llm-usage.sqlite3');
    return {
      repository: await SqliteLlmMetricsRepository.open({ databasePath, flushIntervalMs: 60_000, ...options }),
      databasePath,
    };
  }

  async function waitForMaintenanceLease(databasePath: string): Promise<void> {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      for (let attempt = 0; attempt < 1_000; attempt++) {
        const row = database
          .prepare(
            "SELECT expires_at_ms AS expiresAtMs FROM llm_maintenance_leases WHERE lease_name = 'llm-exchanges-delete'",
          )
          .get();
        if (typeof row?.expiresAtMs === 'number' && row.expiresAtMs > Date.now()) return;
        await delay(1);
      }
    } finally {
      database.close();
    }
    throw new Error('Timed out waiting for LLM metrics maintenance lease');
  }

  it('migrates, writes through WAL, and inserts exchanges idempotently', async () => {
    const opened = await repository({ processRunId: 'process-run-1' });
    expect(opened.repository.health().state).toBe('ready');

    expect(opened.repository.enqueue(exchange('exchange-1'))).toBe(true);
    expect(opened.repository.enqueue(exchange('exchange-1'))).toBe(true);
    await opened.repository.flush();

    expect(opened.repository.health()).toMatchObject({ persisted: 1, duplicates: 1, dropped: 0 });
    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      exchangeId: 'exchange-1',
      inputTokens: 100,
      toolUseInputTokens: 0,
      thinkingTokens: 10,
      nonThinkingOutputTokens: 30,
      outputTokens: 40,
      totalTokens: 140,
      logicalProvider: 'openrouter',
      servedModel: 'served-model',
      providerRequestId: 'request-1',
      providerResponseId: 'response-1',
      gatewayGenerationId: 'generation-1',
      actualServiceTier: 'priority',
      inputMeasurementProvenance: 'reported_exact',
      outputMeasurementProvenance: 'reported_exact',
      thinkingMeasurementProvenance: 'reported_exact',
      nonThinkingMeasurementProvenance: 'derived_exact',
      firstUpstreamBodyByteOffsetMs: 11,
    });

    await opened.repository.close();
    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
    expect(database.prepare('PRAGMA journal_mode').get()).toMatchObject({ journal_mode: 'wal' });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_transport_attempts').get()).toMatchObject({ count: 1 });
    expect(database.prepare('SELECT started_offset_ms, ended_offset_ms FROM llm_transport_attempts').get()).toEqual({
      started_offset_ms: 1,
      ended_offset_ms: 170,
    });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_gateway_route_attempts').get()).toMatchObject({
      count: 1,
    });
    expect(database.prepare('SELECT * FROM llm_process_runs').get()).toMatchObject({
      observed_count: 2,
      finalized_count: 2,
      enqueued_count: 2,
      clean_ended_at_ms: expect.any(Number),
    });
    database.close();
    expect(statSync(opened.databasePath).mode & 0o777).toBe(0o600);
  });

  it('filters and groups by service tier and measurement provenance', async () => {
    const opened = await repository();
    opened.repository.enqueue(exchange('exchange-query-facts'));
    await opened.repository.flush();
    const range = { fromMs: BASE_TIME, toMs: BASE_TIME + 1_000 };

    await expect(
      opened.repository.scan({
        ...range,
        limit: 10,
        filters: {
          actualServiceTier: ['priority'],
          inputMeasurementProvenance: ['reported_exact'],
          outputMeasurementProvenance: ['reported_exact'],
          thinkingMeasurementProvenance: ['reported_exact'],
          nonThinkingMeasurementProvenance: ['derived_exact'],
        },
      }),
    ).resolves.toMatchObject([{ exchangeId: 'exchange-query-facts' }]);
    await expect(
      opened.repository.scan({ ...range, limit: 10, filters: { actualServiceTier: ['standard'] } }),
    ).resolves.toEqual([]);

    const expectedDimensions = [
      ['actualServiceTier', 'priority'],
      ['inputMeasurementProvenance', 'reported_exact'],
      ['outputMeasurementProvenance', 'reported_exact'],
      ['thinkingMeasurementProvenance', 'reported_exact'],
      ['nonThinkingMeasurementProvenance', 'derived_exact'],
    ] as const;
    for (const [dimension, value] of expectedDimensions) {
      await expect(opened.repository.dimensionValues(dimension, { ...range, limit: 10 })).resolves.toEqual([
        { value, count: 1 },
      ]);
    }

    const service = new LlmStatisticsQueryService(opened.repository);
    await expect(
      service.summarize({
        ...range,
        measures: ['requestCount'],
        groupBy: ['actualServiceTier', 'inputMeasurementProvenance', 'outputMeasurementProvenance'],
      }),
    ).resolves.toMatchObject([
      {
        dimensions: {
          actualServiceTier: 'priority',
          inputMeasurementProvenance: 'reported_exact',
          outputMeasurementProvenance: 'reported_exact',
        },
        value: 1,
      },
    ]);
    await expect(
      service.summarize({
        ...range,
        measures: ['requestCount'],
        groupBy: ['thinkingMeasurementProvenance', 'nonThinkingMeasurementProvenance'],
      }),
    ).resolves.toMatchObject([
      {
        dimensions: {
          thinkingMeasurementProvenance: 'reported_exact',
          nonThinkingMeasurementProvenance: 'derived_exact',
        },
        value: 1,
      },
    ]);
    await opened.repository.close();
  });

  it('persists bounded OpenRouter provider labels and the full adapter attempt cap', async () => {
    const opened = await repository();
    const provider = 'Google AI Studio';
    const gatewayRouteAttempts = Array.from({ length: 64 }, (_, index) => ({
      ordinal: index + 1,
      provider,
      model: `google/gemini-${index + 1}`,
      status: 200,
      selected: index === 63,
      source: 'router_metadata' as const,
    }));
    const base = exchange('exchange-openrouter-provider');
    const record: LlmExchangeCompleted = {
      ...base,
      identity: { ...base.identity, servedProvider: { value: provider, source: 'router_metadata' } },
      gatewayRouteAttempts,
    };

    expect(opened.repository.enqueue(record)).toBe(true);
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({ persisted: 1, dropped: 0, state: 'ready' });
    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    expect(rows[0]).toMatchObject({ servedProvider: provider, servedModel: 'served-model' });

    await opened.repository.close();
    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_gateway_route_attempts').get()).toMatchObject({
      count: 64,
    });
    database.close();
  });

  it.each([
    { caseName: 'content-shaped', provider: 'provider\nsecret' },
    { caseName: 'overlong', provider: 'p'.repeat(129) },
  ])('rejects $caseName provider labels at the durable boundary', async ({ provider }) => {
    const opened = await repository();
    const base = exchange('exchange-invalid-provider');
    const record: LlmExchangeCompleted = {
      ...base,
      identity: {
        ...base.identity,
        servedProvider: { value: provider, source: 'router_metadata' },
      },
    };

    expect(opened.repository.enqueue(record)).toBe(true);
    await opened.repository.flush();
    expect(opened.repository.health()).toMatchObject({
      persisted: 0,
      dropped: 1,
      state: 'degraded',
      lastError: expect.stringMatching(/Invalid servedProvider/),
    });
    await opened.repository.close();
  });

  it('keeps fractional monotonic timings while using an integer completion index', async () => {
    const opened = await repository();
    opened.repository.enqueue(exchange('exchange-fractional-timing', { clientDeliveryEndOffsetMs: 180.75 }));
    await opened.repository.flush();

    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 1_000, limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      completedAtMs: BASE_TIME + 181,
      clientDeliveryEndOffsetMs: 180.75,
    });
    await opened.repository.close();
  });

  it('keeps pagination snapshots stable while newer rows are inserted', async () => {
    const opened = await repository();
    opened.repository.enqueue(exchange('exchange-1'));
    await opened.repository.flush();
    const snapshotMaxSequence = await opened.repository.snapshotMaxSequence();

    opened.repository.enqueue(exchange('exchange-2', { startedAtMs: BASE_TIME + 100 }));
    await opened.repository.flush();
    const snapshotRows = await opened.repository.scan({
      fromMs: BASE_TIME,
      toMs: BASE_TIME + 1_000,
      limit: 10,
      snapshotMaxSequence,
    });
    expect(snapshotRows.map((row) => row.exchangeId)).toEqual(['exchange-1']);
    await opened.repository.close();
  });

  it('deletes in bounded chunks and cascades child attempts', async () => {
    const opened = await repository();
    for (let index = 0; index < 5; index++) {
      opened.repository.enqueue(exchange(`exchange-old-${index}`, { startedAtMs: BASE_TIME + index }));
    }
    opened.repository.enqueue(exchange('exchange-new', { startedAtMs: BASE_TIME + 2_000 }));
    await opened.repository.flush();

    const cutoffMs = BASE_TIME + 1_000;
    const first = await opened.repository.deleteBefore(cutoffMs, {
      chunkSize: 2,
      maxRows: 3,
      maxDurationMs: 5_000,
      leaseDurationMs: 5_000,
    });
    expect(first).toMatchObject({
      status: 'partial',
      cutoffMs,
      deletedCount: 3,
      chunksProcessed: 2,
      snapshotMaxSequence: expect.any(Number),
    });
    if (first.snapshotMaxSequence === null) throw new Error('Expected a retention snapshot');
    opened.repository.enqueue(exchange('exchange-late-old'));
    await opened.repository.flush();

    const second = await opened.repository.deleteBefore(cutoffMs, {
      snapshotMaxSequence: first.snapshotMaxSequence,
      chunkSize: 2,
      maxRows: 10,
      maxDurationMs: 5_000,
      leaseDurationMs: 5_000,
    });
    expect(second).toMatchObject({ status: 'complete', cutoffMs, deletedCount: 2, chunksProcessed: 1 });

    const rows = await opened.repository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 3_000, limit: 10 });
    expect(rows.map((row) => row.exchangeId).sort()).toEqual(['exchange-late-old', 'exchange-new']);
    const database = new DatabaseSync(opened.databasePath, { readOnly: true });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_transport_attempts').get()).toMatchObject({ count: 2 });
    expect(database.prepare('SELECT COUNT(*) AS count FROM llm_gateway_route_attempts').get()).toMatchObject({
      count: 2,
    });
    database.close();
    await opened.repository.close();
  });

  it('uses a stable deletion snapshot and a cross-process lease while writers continue', async () => {
    const opened = await repository({ processRunId: 'retention-owner-a' });
    const secondRepository = await SqliteLlmMetricsRepository.open({
      databasePath: opened.databasePath,
      processRunId: 'retention-owner-b',
      flushIntervalMs: 60_000,
    });
    try {
      for (let index = 0; index < 128; index++) {
        opened.repository.enqueue(exchange(`exchange-seeded-${index}`, { startedAtMs: BASE_TIME + index }));
      }
      await opened.repository.flush();

      const cutoffMs = BASE_TIME + 1_000;
      const deletion = opened.repository.deleteBefore(cutoffMs, {
        chunkSize: 1,
        maxRows: 128,
        maxDurationMs: 30_000,
        leaseDurationMs: 30_000,
      });
      await waitForMaintenanceLease(opened.databasePath);

      await expect(
        secondRepository.deleteBefore(cutoffMs, {
          chunkSize: 1,
          maxRows: 128,
          maxDurationMs: 5_000,
          leaseDurationMs: 5_000,
        }),
      ).resolves.toMatchObject({ status: 'busy', deletedCount: 0, chunksProcessed: 0 });
      expect(secondRepository.health().state).toBe('ready');

      expect(secondRepository.enqueue(exchange('exchange-late-old'))).toBe(true);
      expect(secondRepository.enqueue(exchange('exchange-newer', { startedAtMs: BASE_TIME + 2_000 }))).toBe(true);
      await secondRepository.flush();

      await expect(deletion).resolves.toMatchObject({
        status: 'complete',
        cutoffMs,
        deletedCount: 128,
        chunksProcessed: 128,
      });
      const survivors = await secondRepository.scan({ fromMs: BASE_TIME, toMs: BASE_TIME + 3_000, limit: 10 });
      expect(survivors.map((row) => row.exchangeId).sort()).toEqual(['exchange-late-old', 'exchange-newer']);

      const database = new DatabaseSync(opened.databasePath, { readOnly: true });
      expect(database.prepare('SELECT COUNT(*) AS count FROM llm_transport_attempts').get()).toMatchObject({
        count: 2,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM llm_gateway_route_attempts').get()).toMatchObject({
        count: 2,
      });
      database.close();
    } finally {
      await Promise.all([opened.repository.close(), secondRepository.close()]);
    }
  });

  it('strictly bounds retention management inputs', async () => {
    const opened = await repository();
    await expect(opened.repository.deleteBefore(-1)).rejects.toThrow(/Invalid delete cutoff/);
    await expect(opened.repository.deleteBefore(BASE_TIME, { chunkSize: 1_001 })).rejects.toThrow(
      /Invalid delete chunkSize/,
    );
    await expect(opened.repository.deleteBefore(BASE_TIME, { snapshotMaxSequence: -1 })).rejects.toThrow(
      /Invalid delete snapshotMaxSequence/,
    );
    await expect(opened.repository.deleteBefore(BASE_TIME, { maxRows: 100_001 })).rejects.toThrow(
      /Invalid delete maxRows/,
    );
    await expect(opened.repository.deleteBefore(BASE_TIME, { maxDurationMs: 30_001 })).rejects.toThrow(
      /Invalid delete maxDurationMs/,
    );
    await expect(
      opened.repository.deleteBefore(BASE_TIME, { maxDurationMs: 1_000, leaseDurationMs: 999 }),
    ).rejects.toThrow(/must cover maxDurationMs/);
    expect(opened.repository.health().state).toBe('ready');
    await opened.repository.close();
  });

  it('bounds an unresponsive retention worker and exposes the failure in health', async () => {
    const opened = await repository({
      workerFactory: () =>
        new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', () => {});`,
          { eval: true },
        ),
    });

    const deletion = opened.repository.deleteBefore(BASE_TIME, {
      maxDurationMs: 20,
      leaseDurationMs: 100,
    });
    const enqueueStartedAt = performance.now();
    expect(opened.repository.enqueue(exchange('exchange-during-retention'))).toBe(true);
    expect(performance.now() - enqueueStartedAt).toBeLessThan(100);
    await expect(deletion).rejects.toThrow(/lease acquisition timed out/);
    expect(opened.repository.health()).toMatchObject({
      state: 'disabled',
      dropped: 1,
      queuedRecords: 0,
      lastError: expect.stringMatching(/lease acquisition timed out/),
    });
    await opened.repository.close();
  });

  it('bounds its queue and fails open when persistence cannot accept another record', async () => {
    const opened = await repository({ maxQueuedRecords: 1 });
    expect(opened.repository.enqueue(exchange('exchange-1'))).toBe(true);
    expect(opened.repository.enqueue(exchange('exchange-2'))).toBe(false);
    expect(opened.repository.health()).toMatchObject({ observed: 2, enqueued: 1, dropped: 1 });
    await opened.repository.close();
  });

  it('bounds flush and exposes dropped work when a worker is unresponsive', async () => {
    const opened = await repository({
      flushTimeoutMs: 30,
      closeTimeoutMs: 30,
      workerFactory: () =>
        new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', () => {});`,
          { eval: true },
        ),
    });
    opened.repository.enqueue(exchange('exchange-unresponsive-flush'));

    const startedAt = performance.now();
    await opened.repository.flush();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(opened.repository.health()).toMatchObject({
      state: 'disabled',
      dropped: 1,
      queuedRecords: 0,
      lastError: expect.stringMatching(/flush timed out/),
    });
    await opened.repository.close();
  });

  it('uses one bounded deadline for queue drain and close', async () => {
    const opened = await repository({
      flushTimeoutMs: 60_000,
      closeTimeoutMs: 30,
      workerFactory: () =>
        new Worker(
          `const { parentPort } = require('node:worker_threads');
           parentPort.postMessage({ kind: 'ready', schemaVersion: 1 });
           parentPort.on('message', () => {});`,
          { eval: true },
        ),
    });
    opened.repository.enqueue(exchange('exchange-unresponsive-close'));

    const startedAt = performance.now();
    await opened.repository.close();
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    expect(opened.repository.health()).toMatchObject({
      state: 'closed',
      dropped: 1,
      queuedRecords: 0,
      lastError: expect.stringMatching(/close timed out/),
    });
  });

  it('disables safely for a future schema without rewriting it', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-metrics-future-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'future.sqlite3');
    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA user_version = 99');
    database.close();

    const repository = await SqliteLlmMetricsRepository.open({ databasePath });
    expect(repository.health()).toMatchObject({ state: 'disabled', schemaVersion: null });
    expect(repository.enqueue(exchange('exchange-1'))).toBe(false);
    await expect(repository.scan({ fromMs: 0, toMs: 1, limit: 1 })).rejects.toThrow(/schema 99|unavailable/i);
    await repository.close();

    const verification = new DatabaseSync(databasePath, { readOnly: true });
    expect(verification.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 99 });
    verification.close();
  });

  it('persists only the explicit content-free allowlist', async () => {
    const opened = await repository();
    const canary = 'PROMPT-CONTENT-MUST-NEVER-BE-DURABLE-7c8fcf91';
    const record = { ...exchange('exchange-privacy'), accidentalPayload: canary } as LlmExchangeCompleted;
    opened.repository.enqueue(record);
    await opened.repository.close();

    expect(readFileSync(opened.databasePath).includes(Buffer.from(canary))).toBe(false);
  });
});

describe('LLM statistics query service', () => {
  it('provides stable pagination and coverage-aware summaries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-query-'));
    const databasePath = join(directory, 'llm-usage.sqlite3');
    const repository = await SqliteLlmMetricsRepository.open({ databasePath, flushIntervalMs: 60_000 });
    try {
      repository.enqueue(exchange('exchange-1'));
      repository.enqueue(
        exchange('exchange-2', {
          startedAtMs: BASE_TIME + 1_000,
          refusal: true,
          thinkingTokens: null,
          nonThinkingOutputTokens: null,
          completeness: 'partial',
        }),
      );
      await repository.flush();
      const service = new LlmStatisticsQueryService(repository);

      const first = await service.listExchanges({ fromMs: BASE_TIME, toMs: BASE_TIME + 2_000, limit: 1 });
      expect(first.items.map((row) => row.exchangeId)).toEqual(['exchange-2']);
      expect(first.nextCursor).not.toBeNull();
      const second = await service.listExchanges({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 2_000,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items.map((row) => row.exchangeId)).toEqual(['exchange-1']);

      const summaries = await service.summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 2_000,
        measures: ['requestCount', 'refusalRate', 'inputTokens', 'thinkingTokens'],
      });
      expect(summaries.find((summary) => summary.measure === 'requestCount')).toMatchObject({ value: 2 });
      expect(summaries.find((summary) => summary.measure === 'refusalRate')).toMatchObject({
        value: 0.5,
        coverage: 1,
      });
      expect(summaries.find((summary) => summary.measure === 'inputTokens')).toMatchObject({
        value: 200,
        sampleCount: 2,
        coverage: 1,
      });
      expect(summaries.find((summary) => summary.measure === 'thinkingTokens')).toMatchObject({
        value: 10,
        sampleCount: 1,
        coverage: 0.5,
      });

      expect(
        await service.dimensions({
          fromMs: BASE_TIME,
          toMs: BASE_TIME + 2_000,
          dimension: 'servedModel',
        }),
      ).toEqual([{ value: 'served-model', count: 2 }]);
      expect(await service.sessionTotals('session-1')).toMatchObject({
        exchanges: 2,
        inputTokens: 200,
        thinkingTokens: 10,
        completeUsageExchanges: 1,
        partialUsageExchanges: 1,
      });
      expect(await service.capabilities()).toMatchObject({ available: true, dtoVersion: 1, formulaVersion: 1 });
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('excludes aborted, missing, and nonpositive client delivery from effective output throughput', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ironcurtain-llm-effective-tps-'));
    const repository = await SqliteLlmMetricsRepository.open({
      databasePath: join(directory, 'llm-usage.sqlite3'),
      flushIntervalMs: 60_000,
    });
    try {
      repository.enqueue(exchange('delivered', { clientDeliveryEndOffsetMs: 200 }));
      repository.enqueue(exchange('aborted', { startedAtMs: BASE_TIME + 1, clientAborted: true }));
      repository.enqueue(exchange('missing', { startedAtMs: BASE_TIME + 2, clientDeliveryEndOffsetMs: null }));
      repository.enqueue(exchange('zero', { startedAtMs: BASE_TIME + 3, clientDeliveryEndOffsetMs: 0 }));
      await repository.flush();
      const summaries = await new LlmStatisticsQueryService(repository).summarize({
        fromMs: BASE_TIME,
        toMs: BASE_TIME + 1_000,
        measures: ['effectiveOutputTokensPerSecond'],
      });
      expect(summaries[0]).toMatchObject({
        value: 200,
        sampleCount: 1,
        eligibleCount: 4,
        coverage: 0.25,
      });
    } finally {
      await repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
