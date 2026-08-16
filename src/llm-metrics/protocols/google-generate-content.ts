import {
  addCounts,
  asArray,
  asBoolean,
  asIdentifier,
  asKnownString,
  asRecord,
  makeNormalizedUsage,
  subtractCount,
  usageCompleteness,
} from '../normalization.js';
import type {
  LlmProtocolAccumulator,
  LlmProtocolAdapter,
  LlmProtocolObservation,
  LlmRequestFacts,
  GatewayResponseHeaders,
  NormalizedStopReason,
  NormalizedTermination,
  ProtocolRequestContext,
  ProtocolStreamEvent,
  RefusalSource,
} from '../types.js';
import {
  emptyOutcome,
  inspectCommonRequest,
  readCount,
  readIdentifier,
  readResponseHeaderIdentifier,
  stableFlags,
} from './common.js';

interface GoogleUsageValues {
  prompt: number | null;
  cached: number | null;
  candidates: number | null;
  thoughts: number | null;
  toolUsePrompt: number | null;
  total: number | null;
}

type GoogleAdditiveUsageField = 'prompt' | 'candidates' | 'thoughts' | 'toolUsePrompt';

interface GoogleUsageSnapshot {
  readonly values: GoogleUsageValues;
  readonly derived: ReadonlySet<GoogleAdditiveUsageField>;
}

const GOOGLE_ADDITIVE_USAGE_FIELDS = [
  ['prompt', 'promptTokenCount'],
  ['candidates', 'candidatesTokenCount'],
  ['thoughts', 'thoughtsTokenCount'],
  ['toolUsePrompt', 'toolUsePromptTokenCount'],
] as const satisfies readonly (readonly [GoogleAdditiveUsageField, string])[];

/**
 * Google totalTokenCount is additive over prompt, tool-use prompt,
 * candidates, and thoughts. cachedContentTokenCount is a subset of prompt and
 * is deliberately excluded. Missing additive fields are exact only when the
 * non-negative remainder forces them all to zero or leaves one sole unknown.
 */
function reconcileGoogleUsage(
  usage: Record<string, unknown>,
  values: GoogleUsageValues,
  flags: Set<string>,
): GoogleUsageSnapshot {
  if (values.total === null) return { values, derived: new Set() };

  const missing: GoogleAdditiveUsageField[] = [];
  let knownTotal = 0;
  for (const [field, wireField] of GOOGLE_ADDITIVE_USAGE_FIELDS) {
    const value = values[field];
    if (value === null) {
      // An explicitly invalid count is not an omitted optional component and
      // must not be repaired from a second, potentially contradictory field.
      if (wireField in usage && usage[wireField] !== null) return { values, derived: new Set() };
      missing.push(field);
      continue;
    }
    knownTotal += value;
    if (!Number.isSafeInteger(knownTotal)) {
      flags.add('contradictory_usage:provider_total');
      return { values, derived: new Set() };
    }
  }

  const remainder = values.total - knownTotal;
  if (remainder < 0 || (missing.length === 0 && remainder !== 0)) {
    flags.add('contradictory_usage:provider_total');
    return { values, derived: new Set() };
  }
  if (missing.length === 0 || (remainder !== 0 && missing.length > 1)) {
    return { values, derived: new Set() };
  }

  const reconciled = { ...values };
  const derived = new Set<GoogleAdditiveUsageField>();
  if (remainder === 0) {
    for (const field of missing) {
      reconciled[field] = 0;
      derived.add(field);
    }
  } else {
    const field = missing[0];
    reconciled[field] = remainder;
    derived.add(field);
  }
  return { values: reconciled, derived };
}

function googleFinishReason(reason: unknown): {
  stop: NormalizedStopReason;
  termination: NormalizedTermination;
  refusal: boolean | null;
  source: RefusalSource;
} {
  switch (reason) {
    case 'STOP':
      return { stop: 'completed', termination: 'stop', refusal: false, source: 'not_reported' };
    case 'MAX_TOKENS':
      return { stop: 'max_tokens', termination: 'length', refusal: false, source: 'not_reported' };
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return { stop: 'content_filter', termination: 'content_filter', refusal: true, source: 'content_filter' };
    case 'MALFORMED_FUNCTION_CALL':
    case 'UNEXPECTED_TOOL_CALL':
      return { stop: 'tool_use', termination: 'tool', refusal: false, source: 'not_reported' };
    default:
      return {
        stop: reason == null ? 'not_reported' : 'other',
        termination: 'unknown',
        refusal: null,
        source: 'not_reported',
      };
  }
}

function extractModelFromPath(
  path: string | undefined,
  flags: Set<string>,
): {
  model: string | null;
  streaming: boolean | null;
} {
  if (!path) return { model: null, streaming: null };
  const match = /\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(path);
  if (!match) {
    flags.add('invalid_google_completion_path');
    return { model: null, streaming: null };
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(match[1]);
  } catch {
    flags.add('invalid_google_model_encoding');
    return { model: null, streaming: match[2] === 'streamGenerateContent' };
  }
  const model = asIdentifier(decoded);
  if (model === null) flags.add('invalid_identifier:model');
  return { model, streaming: match[2] === 'streamGenerateContent' };
}

export class GoogleGenerateContentAccumulator implements LlmProtocolAccumulator {
  private responseModel: string | null = null;
  private providerRequestId: string | null = null;
  private providerResponseId: string | null = null;
  private actualServiceTier: string | null = null;
  private protocolTerminal = false;
  private termination: NormalizedTermination = 'unknown';
  private stopReason: NormalizedStopReason = 'not_reported';
  private refusal: boolean | null = null;
  private refusalSource: RefusalSource = 'not_reported';
  private sawUsage = false;
  private sawAuthoritativeUsage = false;
  private usage: GoogleUsageValues = {
    prompt: null,
    cached: null,
    candidates: null,
    thoughts: null,
    toolUsePrompt: null,
    total: null,
  };
  private readonly derivedUsageFields = new Set<GoogleAdditiveUsageField>();
  private readonly flags = new Set<string>();

  observeResponseHeaders(headers: GatewayResponseHeaders): void {
    this.providerRequestId = readResponseHeaderIdentifier(headers, 'x-goog-request-id', this.flags);
  }

  observeJsonResponse(value: unknown): void {
    const response = asRecord(value);
    if (!response) {
      this.flags.add('invalid_response_envelope');
      return;
    }
    const alreadyTerminal = this.protocolTerminal;
    this.observeResponse(response, true);
    if (alreadyTerminal) this.flags.add('duplicate_protocol_terminal');
    this.protocolTerminal = true;
  }

  observeStreamEvent(event: ProtocolStreamEvent): 'control' | 'reasoning' | 'output' {
    const response = asRecord(event.data);
    if (!response) {
      this.flags.add('invalid_stream_event');
      return 'control';
    }
    this.observeResponse(response, false);
    let reasoning = false;
    for (const candidate of asArray(response['candidates']) ?? []) {
      const content = asRecord(asRecord(candidate)?.['content']);
      for (const part of asArray(content?.['parts']) ?? []) {
        const record = asRecord(part);
        if (!record) continue;
        const generated = typeof record['text'] === 'string' || record['functionCall'] !== undefined;
        if (generated && record['thought'] !== true) return 'output';
        if (generated && record['thought'] === true) reasoning = true;
      }
    }
    return reasoning ? 'reasoning' : 'control';
  }

  isProtocolTerminal(): boolean {
    return this.protocolTerminal;
  }

  snapshot(): LlmProtocolObservation {
    const prompt = this.usage.prompt;
    const input = addCounts(prompt, this.usage.toolUsePrompt);
    const cached = this.usage.cached;
    const uncached = subtractCount(input, cached);
    const output = addCounts(this.usage.candidates, this.usage.thoughts);
    if (cached !== null && prompt !== null && cached > prompt)
      this.flags.add('contradictory_usage:cache_exceeds_input');
    const canonicalTotal = addCounts(input, output);
    if (this.usage.total !== null && canonicalTotal !== null && this.usage.total !== canonicalTotal) {
      this.flags.add('contradictory_usage:provider_total');
    }
    const invalid = [...this.flags].some((flag) => flag.startsWith('invalid_count:'));
    const usage = makeNormalizedUsage({
      inputTokensReported: this.derivedUsageFields.has('prompt') ? null : prompt,
      inputTokensTotal: input,
      inputTokensAccuracy: input === null ? 'unknown' : 'derived_exact',
      inputTokensUncached: cached !== null && cached <= (prompt ?? -1) ? uncached : null,
      cacheReadInputTokens: cached,
      cacheWriteInputTokens: null,
      toolUseInputTokens: this.usage.toolUsePrompt,
      outputTokensReported: this.derivedUsageFields.has('candidates') ? null : this.usage.candidates,
      outputTokenSemantics: 'excludes_thinking',
      outputTokensTotal: output,
      outputTokensAccuracy: output === null ? 'unknown' : 'derived_exact',
      thinkingTokens: this.usage.thoughts,
      thinkingTokensAccuracy:
        this.usage.thoughts === null
          ? 'unknown'
          : this.derivedUsageFields.has('thoughts')
            ? 'derived_exact'
            : 'reported_exact',
      nonThinkingOutputTokens: this.usage.candidates,
      nonThinkingOutputTokensAccuracy:
        this.usage.candidates === null
          ? 'unknown'
          : this.derivedUsageFields.has('candidates')
            ? 'derived_exact'
            : 'reported_exact',
      providerTotalTokens: this.usage.total,
      canonicalTotalTokens: canonicalTotal,
      usageSource: this.sawUsage ? 'google_usage_metadata' : null,
      usageCompleteness: usageCompleteness(input, output, this.sawUsage, invalid),
      qualityFlags: [...this.flags].filter((flag) => flag.includes('usage') || flag.startsWith('invalid_count:')),
    });
    const outcome =
      this.stopReason === 'not_reported'
        ? emptyOutcome()
        : {
            termination: this.termination,
            providerStopReason: this.stopReason,
            responseStatus: null,
            refusal: this.refusal,
            refusalCategory: null,
            refusalSource: this.refusalSource,
          };
    return {
      protocol: 'google-generate-content',
      responseModel: this.responseModel,
      providerRequestId: this.providerRequestId,
      providerResponseId: this.providerResponseId,
      actualServiceTier: this.actualServiceTier,
      usage,
      outcome,
      protocolTerminal: this.protocolTerminal,
      qualityFlags: stableFlags([...this.flags], usage.qualityFlags),
    };
  }

  private observeResponse(response: Record<string, unknown>, wholeJsonResponse: boolean): void {
    const model = readIdentifier(response, 'modelVersion', this.flags);
    const id = readIdentifier(response, 'responseId', this.flags);
    if (model !== null) this.responseModel = model;
    if (id !== null) this.providerResponseId = id;
    let terminalUsage = wholeJsonResponse;
    const promptFeedback = asRecord(response['promptFeedback']);
    if (promptFeedback?.['blockReason'] !== undefined) {
      this.stopReason = 'content_filter';
      this.termination = 'content_filter';
      this.refusal = true;
      this.refusalSource = 'prompt_feedback';
      this.protocolTerminal = true;
      terminalUsage = true;
    }
    for (const candidate of asArray(response['candidates']) ?? []) {
      const candidateRecord = asRecord(candidate);
      if (!candidateRecord) continue;
      const mapped = googleFinishReason(candidateRecord['finishReason']);
      if (mapped.stop === 'not_reported') continue;
      if (this.stopReason !== 'not_reported' && this.stopReason !== mapped.stop)
        this.flags.add('conflicting_stop_reason');
      this.stopReason = mapped.stop;
      this.termination = mapped.termination;
      this.refusal = mapped.refusal;
      this.refusalSource = mapped.source;
      this.protocolTerminal = true;
      terminalUsage = true;
    }
    this.observeUsage(asRecord(response['usageMetadata']), terminalUsage);
  }

  private observeUsage(usage: Record<string, unknown> | undefined, authoritative: boolean): void {
    if (!usage) return;
    this.sawUsage = true;
    const raw: GoogleUsageValues = {
      prompt: readCount(usage, 'promptTokenCount', this.flags),
      cached: readCount(usage, 'cachedContentTokenCount', this.flags),
      candidates: readCount(usage, 'candidatesTokenCount', this.flags),
      thoughts: readCount(usage, 'thoughtsTokenCount', this.flags),
      toolUsePrompt: readCount(usage, 'toolUsePromptTokenCount', this.flags),
      total: readCount(usage, 'totalTokenCount', this.flags),
    };
    const next = reconcileGoogleUsage(usage, raw, this.flags);
    if (authoritative && this.sawAuthoritativeUsage) this.flags.add('duplicate_terminal_usage');
    for (const field of Object.keys(next.values) as (keyof GoogleUsageValues)[]) {
      const candidate = next.values[field];
      const previous = this.usage[field];
      if (candidate !== null && previous !== null && candidate < previous) {
        this.flags.add(`regressing_cumulative_usage:${field}`);
      }
      if (authoritative || !this.sawAuthoritativeUsage) {
        this.usage[field] = candidate;
        if (field !== 'cached' && field !== 'total') {
          if (candidate !== null && next.derived.has(field)) this.derivedUsageFields.add(field);
          else this.derivedUsageFields.delete(field);
        }
      }
    }
    if (authoritative) this.sawAuthoritativeUsage = true;
  }
}

export class GoogleGenerateContentAdapter implements LlmProtocolAdapter {
  readonly id = 'google-generate-content' as const;

  inspectRequest(value: unknown, context?: ProtocolRequestContext): LlmRequestFacts {
    const common = inspectCommonRequest(value);
    const flags = new Set(common.qualityFlags);
    const pathFacts = extractModelFromPath(context?.path, flags);
    const body = asRecord(value);
    const generationConfig = asRecord(body?.['generationConfig']);
    const thinkingConfig = asRecord(generationConfig?.['thinkingConfig']);
    const includeThoughts = asBoolean(thinkingConfig?.['includeThoughts']);
    const thinkingBudget = readCount(thinkingConfig, 'thinkingBudget', flags);
    const thinkingLevel = asKnownString(thinkingConfig?.['thinkingLevel'], [
      'MINIMAL',
      'LOW',
      'MEDIUM',
      'HIGH',
    ] as const);
    if (thinkingConfig?.['thinkingLevel'] != null && thinkingLevel === null) flags.add('unknown_reasoning_effort');
    return {
      ...common,
      requestedModel: pathFacts.model,
      streaming: pathFacts.streaming,
      reasoningMode: includeThoughts === true || thinkingBudget !== null ? 'enabled' : common.reasoningMode,
      reasoningEffort: thinkingLevel,
      thinkingBudgetTokens: thinkingBudget,
      qualityFlags: [...flags].sort(),
    };
  }

  createAccumulator(): LlmProtocolAccumulator {
    return new GoogleGenerateContentAccumulator();
  }
}
