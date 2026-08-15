/** Read-only LLM statistics methods served by the daemon's existing WebSocket. */

import { z } from 'zod';

import type { WorkflowDispatchContext } from './workflow-dispatch.js';
import { validateParams } from './types.js';
import { InvalidParamsError, MethodNotFoundError, RpcError } from '../web-ui-types.js';

const dimensionSchema = z.enum([
  'agent',
  'logicalProvider',
  'gateway',
  'protocol',
  'providerProfile',
  'requestedModel',
  'forwardedModel',
  'responseModel',
  'servedModel',
  'servedProvider',
  'reasoningMode',
  'requestedServiceTier',
  'actualServiceTier',
  'inputMeasurementProvenance',
  'outputMeasurementProvenance',
  'thinkingMeasurementProvenance',
  'nonThinkingMeasurementProvenance',
  'speedMode',
  'streaming',
  'outcome',
  'refusal',
  'usageCompleteness',
  'attributionQuality',
  'sessionId',
  'workflowRunId',
  'bundleId',
]);

const measureSchema = z.enum([
  'requestCount',
  'refusalCount',
  'refusalRate',
  'errorCount',
  'errorRate',
  'inputTokens',
  'uncachedInputTokens',
  'cacheReadInputTokens',
  'cacheWriteInputTokens',
  'toolUseInputTokens',
  'thinkingTokens',
  'nonThinkingOutputTokens',
  'outputTokens',
  'totalTokens',
  'costUsd',
  'ttftMs',
  'upstreamLatencyMs',
  'clientLatencyMs',
  'observableOutputTokensPerSecond',
  'effectiveOutputTokensPerSecond',
]);

const stringList = z.array(z.string().min(1).max(256)).max(100);
const filtersSchema = z
  .object({
    agent: stringList.optional(),
    logicalProvider: stringList.optional(),
    gateway: stringList.optional(),
    protocol: stringList.optional(),
    providerProfile: stringList.optional(),
    requestedModel: stringList.optional(),
    forwardedModel: stringList.optional(),
    responseModel: stringList.optional(),
    servedModel: stringList.optional(),
    servedProvider: stringList.optional(),
    reasoningMode: stringList.optional(),
    requestedServiceTier: stringList.optional(),
    actualServiceTier: stringList.optional(),
    inputMeasurementProvenance: stringList.optional(),
    outputMeasurementProvenance: stringList.optional(),
    thinkingMeasurementProvenance: stringList.optional(),
    nonThinkingMeasurementProvenance: stringList.optional(),
    speedMode: stringList.optional(),
    streaming: z.array(z.boolean()).max(2).optional(),
    outcome: stringList.optional(),
    refusal: z.array(z.boolean()).max(2).optional(),
    usageCompleteness: stringList.optional(),
    attributionQuality: stringList.optional(),
    sessionId: stringList.optional(),
    workflowRunId: stringList.optional(),
    bundleId: stringList.optional(),
  })
  .strict();

const rangeSchema = z.object({
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
  filters: filtersSchema.optional(),
});

const summarySchema = rangeSchema.extend({
  measures: z.array(measureSchema).min(1).max(20),
  groupBy: z.array(dimensionSchema).max(3).optional(),
});

function requireReader(ctx: WorkflowDispatchContext) {
  if (!ctx.statisticsReader) {
    throw new RpcError('STATISTICS_UNAVAILABLE', 'LLM statistics are disabled or unavailable');
  }
  return ctx.statisticsReader;
}

async function mapQueryError<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RpcError) throw error;
    throw new InvalidParamsError(error instanceof Error ? error.message : 'Invalid statistics query');
  }
}

export async function statisticsDispatch(
  ctx: WorkflowDispatchContext,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method === 'statistics.capabilities') {
    validateParams(z.object({}).strict(), params);
    if (!ctx.statisticsReader) {
      return {
        available: false,
        dtoVersion: 1,
        formulaVersion: 1,
        schemaVersion: null,
        maxPageSize: 500,
        maxScannedRows: 10_000,
        maxGroups: 500,
        allowedBucketSizesMs: [60_000, 300_000, 900_000, 3_600_000, 86_400_000],
        health: {
          state: 'disabled',
          schemaVersion: null,
          observed: 0,
          finalized: 0,
          enqueued: 0,
          persisted: 0,
          duplicates: 0,
          dropped: 0,
          queuedRecords: 0,
          queuedBytes: 0,
          lastError: null,
        },
      };
    }
    return ctx.statisticsReader.capabilities();
  }

  const reader = requireReader(ctx);
  switch (method) {
    case 'statistics.summary': {
      const query = validateParams(summarySchema, params);
      return mapQueryError(() => reader.summarize(query));
    }
    case 'statistics.series': {
      const query = validateParams(summarySchema.extend({ bucketMs: z.number().int().positive() }), params);
      return mapQueryError(() => reader.timeSeries(query));
    }
    case 'statistics.exchanges': {
      const query = validateParams(
        rangeSchema.extend({
          limit: z.number().int().positive().max(500).optional(),
          cursor: z.string().max(1024).optional(),
        }),
        params,
      );
      return mapQueryError(() => reader.listExchanges(query));
    }
    case 'statistics.dimensions': {
      const query = validateParams(
        rangeSchema.extend({ dimension: dimensionSchema, limit: z.number().int().positive().max(500).optional() }),
        params,
      );
      return mapQueryError(() => reader.dimensions(query));
    }
    default:
      throw new MethodNotFoundError(method);
  }
}
