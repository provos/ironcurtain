/** Read-only LLM statistics methods served by the daemon's existing WebSocket. */

import { z } from 'zod';

import { LlmMetricsRepositoryUnavailableError } from '../../llm-metrics/persistence/repository.js';
import {
  isValidStatisticsTimeZone,
  MAX_STATISTICS_AGGREGATION_ROWS,
  MAX_STATISTICS_DISTRIBUTION_BINS,
  MAX_STATISTICS_FILTER_VALUES,
  MAX_STATISTICS_TOP_GROUPS,
  STATISTICS_BUCKET_SIZES_MS,
  STATISTICS_CALENDAR_BUCKET_UNITS,
  STATISTICS_DIMENSIONS,
  STATISTICS_DISTRIBUTION_MEASURES,
  STATISTICS_IDENTIFIER_PATTERN,
  STATISTICS_MEASURES,
  STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH,
  STATISTICS_PROVIDER_IDENTIFIER_PATTERN,
  STATISTICS_TIME_ZONE_MAX_LENGTH,
} from '../../llm-metrics/query-contract.js';
import type { WorkflowDispatchContext } from './workflow-dispatch.js';
import { validateParams } from './types.js';
import { InvalidParamsError, MethodNotFoundError, RpcError } from '../web-ui-types.js';

const dimensionSchema = z.enum(STATISTICS_DIMENSIONS);
const measureSchema = z.enum(STATISTICS_MEASURES);
const distributionMeasureSchema = z.enum(STATISTICS_DISTRIBUTION_MEASURES);

const identifierSchema = z.string().regex(STATISTICS_IDENTIFIER_PATTERN);
const providerIdentifierSchema = z
  .string()
  .max(STATISTICS_PROVIDER_IDENTIFIER_MAX_LENGTH)
  .regex(STATISTICS_PROVIDER_IDENTIFIER_PATTERN);
const identifierList = z.array(identifierSchema).max(MAX_STATISTICS_FILTER_VALUES);
const providerIdentifierList = z.array(providerIdentifierSchema).max(MAX_STATISTICS_FILTER_VALUES);
const booleanList = z.array(z.boolean()).max(2);
const bucketSizeSchema = z.union(STATISTICS_BUCKET_SIZES_MS.map((bucketMs) => z.literal(bucketMs)));
const filtersSchema = z
  .object({
    agent: identifierList.optional(),
    logicalProvider: identifierList.optional(),
    gateway: identifierList.optional(),
    protocol: identifierList.optional(),
    providerProfile: identifierList.optional(),
    requestedModel: identifierList.optional(),
    forwardedModel: identifierList.optional(),
    responseModel: identifierList.optional(),
    servedModel: identifierList.optional(),
    servedProvider: providerIdentifierList.optional(),
    reasoningMode: identifierList.optional(),
    requestedServiceTier: identifierList.optional(),
    actualServiceTier: identifierList.optional(),
    inputMeasurementProvenance: identifierList.optional(),
    outputMeasurementProvenance: identifierList.optional(),
    thinkingMeasurementProvenance: identifierList.optional(),
    nonThinkingMeasurementProvenance: identifierList.optional(),
    speedMode: identifierList.optional(),
    streaming: booleanList.optional(),
    outcome: identifierList.optional(),
    refusal: booleanList.optional(),
    usageCompleteness: identifierList.optional(),
    attributionQuality: identifierList.optional(),
    sessionId: identifierList.optional(),
    workflowRunId: identifierList.optional(),
    stateId: identifierList.optional(),
    personaId: identifierList.optional(),
    bundleId: identifierList.optional(),
  })
  .strict();

const rangeSchema = z
  .object({
    fromMs: z.number().int().nonnegative(),
    toMs: z.number().int().nonnegative(),
    filters: filtersSchema.optional(),
  })
  .strict();

const summarySchema = rangeSchema
  .extend({
    measures: z.array(measureSchema).min(1).max(20),
    groupBy: z.array(dimensionSchema).max(3).optional(),
    topGroups: z.number().int().positive().max(MAX_STATISTICS_TOP_GROUPS).optional(),
  })
  .superRefine((value, context) => {
    if (value.topGroups !== undefined && (value.groupBy === undefined || value.groupBy.length === 0)) {
      context.addIssue({ code: 'custom', message: 'topGroups requires at least one grouping dimension' });
    }
  });

const calendarBucketSchema = z
  .object({
    unit: z.literal('day'),
    timeZone: z
      .string()
      .min(1)
      .max(STATISTICS_TIME_ZONE_MAX_LENGTH)
      .refine(isValidStatisticsTimeZone, { message: 'timeZone must be a valid IANA time zone' }),
  })
  .strict();

const seriesSchema = summarySchema
  .extend({
    bucketMs: bucketSizeSchema.optional(),
    calendarBucket: calendarBucketSchema.optional(),
  })
  .superRefine((value, context) => {
    if ((value.bucketMs === undefined) === (value.calendarBucket === undefined)) {
      context.addIssue({ code: 'custom', message: 'Exactly one statistics bucket form is required' });
    }
  });

const distributionSchema = rangeSchema.extend({
  measure: distributionMeasureSchema,
  maxBins: z.number().int().positive().max(MAX_STATISTICS_DISTRIBUTION_BINS).optional(),
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
    if (error instanceof LlmMetricsRepositoryUnavailableError) {
      throw new RpcError('STATISTICS_UNAVAILABLE', 'LLM statistics are temporarily unavailable');
    }
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
        dtoVersion: 2,
        formulaVersion: 1,
        schemaVersion: null,
        maxPageSize: 500,
        maxScannedRows: MAX_STATISTICS_AGGREGATION_ROWS,
        maxGroups: 500,
        allowedBucketSizesMs: [...STATISTICS_BUCKET_SIZES_MS],
        allowedCalendarBucketUnits: [...STATISTICS_CALENDAR_BUCKET_UNITS],
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
          readerState: 'closed',
          readerLastError: null,
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
      const query = validateParams(seriesSchema, params);
      return mapQueryError(() => reader.timeSeries(query));
    }
    case 'statistics.distribution': {
      const query = validateParams(distributionSchema, params);
      return mapQueryError(() => reader.distribution(query));
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
