/**
 * memory_ingest tool handler.
 * Validates/normalizes input, delegates to the engine, and renders the result.
 * PII note: the non-dry-run renderings are content-free (ids + counts only), but
 * `dry_run` intentionally returns a PREVIEW of the extracted fact text (model
 * output) so callers can inspect the decomposition before writing — so a dry-run
 * response is NOT content-free, and MCP clients that log tool output will capture
 * that fact text.
 */

import type { MemoryEngine, IngestOptions } from '../engine.js';
import type { IngestResult } from '../types.js';
import { validateTags } from './validation.js';

export type IngestMode = 'conversation' | 'document';
export type OnExtractionFailure = 'degrade' | 'skip' | 'error';

const INGEST_MODES: readonly IngestMode[] = ['conversation', 'document'];
const ON_EXTRACTION_FAILURES: readonly OnExtractionFailure[] = ['degrade', 'skip', 'error'];

export interface IngestInput {
  content: string;
  source?: string;
  mode: IngestMode;
  tags?: string[];
  importance?: number;
  dry_run: boolean;
  on_extraction_failure: OnExtractionFailure;
  as_of?: number;
}

/**
 * Normalize `as_of` (epoch ms number, numeric string, OR ISO 8601 string) to epoch ms.
 * Rejects non-finite / negative results.
 */
function normalizeAsOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;

  let ms: number;
  if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    // A bare numeric string (e.g. "1700000000000") is epoch ms; otherwise parse as ISO.
    // Guard empty/whitespace-only: Number('') is 0 (would slip through as epoch 0),
    // but it was unparseable before — keep rejecting it via Date.parse → NaN.
    const asNumber = value.trim().length === 0 ? NaN : Number(value);
    ms = Number.isFinite(asNumber) ? asNumber : Date.parse(value);
  } else {
    throw new Error('as_of must be an epoch-ms number or an ISO 8601 string');
  }

  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error('as_of must resolve to a non-negative epoch-ms timestamp');
  }
  return ms;
}

/**
 * Validate an optional enum-valued arg: undefined passes through, otherwise the
 * value must be one of `allowed` (throws `errorMsg` if not). Returns the value
 * narrowed to `T` without the caller needing a double cast.
 */
function optEnum<T>(value: unknown, allowed: readonly T[], errorMsg: string): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(errorMsg);
  }
  return value as T;
}

export function validateIngestInput(args: Record<string, unknown>): IngestInput {
  const content = args.content;
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('content is required and must be a non-empty string');
  }

  const source = args.source;
  if (source !== undefined && typeof source !== 'string') {
    throw new Error('source must be a string');
  }

  const mode = optEnum(args.mode, INGEST_MODES, "mode must be 'conversation' or 'document'") ?? 'conversation';

  const tags = validateTags(args.tags);

  const importance = args.importance;
  if (importance !== undefined) {
    if (typeof importance !== 'number' || !Number.isFinite(importance) || importance < 0 || importance > 1) {
      throw new Error('importance must be a number between 0 and 1');
    }
  }

  const dryRun = args.dry_run;
  if (dryRun !== undefined && typeof dryRun !== 'boolean') {
    throw new Error('dry_run must be a boolean');
  }

  const onExtractionFailure =
    optEnum(
      args.on_extraction_failure,
      ON_EXTRACTION_FAILURES,
      "on_extraction_failure must be 'degrade', 'skip', or 'error'",
    ) ?? 'degrade';

  const asOf = normalizeAsOf(args.as_of);

  return {
    content: content.trim(),
    source,
    mode,
    tags,
    importance,
    dry_run: dryRun ?? false,
    on_extraction_failure: onExtractionFailure,
    as_of: asOf,
  };
}

function truncateId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** One-line "N of M chunks failed" suffix, or '' when extraction was complete. */
function partialSuffix(result: IngestResult): string {
  if (!result.partial) return '';
  return ` ${result.failed_chunks ?? 0} of ${result.chunks ?? 0} chunks failed extraction`;
}

/**
 * Render the dry-run preview. Unlike the other renderings this DOES include the
 * extracted fact text (model output) — see the handler doc. Appends the partial
 * warning so a preview built from an incomplete extraction is not mistaken for
 * the full decomposition.
 */
function renderDryRunPreview(result: IngestResult): string {
  const lines = result.facts.map((f, i) => {
    const imp = f.importance !== undefined ? ` (importance: ${f.importance})` : '';
    return `${i + 1}. ${f.fact}${imp}`;
  });
  const header = `Dry run — nothing written. ${result.facts.length} fact(s) proposed:`;
  const warning = result.partial ? `\n(incomplete —${partialSuffix(result)}; preview may be missing facts.)` : '';
  return [header, ...lines].join('\n') + warning;
}

export function formatIngestResult(result: IngestResult, dryRun: boolean): string {
  if (result.skipped) {
    return 'Extraction failed and on_extraction_failure=skip — nothing written.';
  }

  // Full degrade (no decomposition): set by the engine only when the fact union
  // was empty. `partial` distinguishes this from "some chunks failed but we got facts".
  if (result.degraded && !result.partial) {
    if (dryRun) {
      return 'No LLM configured or extraction failed — dry run, nothing written (no decomposition).';
    }
    const id = result.memory_ids[0] ?? '?';
    return `No LLM configured or extraction failed — stored the blob as a single memory ${truncateId(id)}.`;
  }

  // Dry run preview (facts extracted, nothing written).
  if (dryRun) {
    return renderDryRunPreview(result);
  }

  const idList = result.memory_ids.map(truncateId).join(', ');
  const base =
    `Ingested ${result.facts.length} atomic fact(s): ` +
    `${result.created} new memor${result.created === 1 ? 'y' : 'ies'}, ${result.merged} merged into existing` +
    (idList.length > 0 ? ` (ids: ${idList})` : '') +
    '.';

  if (result.partial) {
    return `${base}${partialSuffix(result)} — partial result.`;
  }

  return base;
}

export async function handleIngest(engine: MemoryEngine, args: Record<string, unknown>): Promise<string> {
  const input = validateIngestInput(args);
  const opts: IngestOptions = {
    source: input.source,
    mode: input.mode,
    tags: input.tags,
    importance: input.importance,
    dry_run: input.dry_run,
    as_of: input.as_of,
    on_extraction_failure: input.on_extraction_failure,
  };
  const result = await engine.ingest(input.content, opts);
  return formatIngestResult(result, input.dry_run);
}
