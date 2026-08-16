import { addCounts, asRecord, makeNormalizedUsage, subtractCount, usageCompleteness } from '../normalization.js';
import type { NormalizedUsage } from '../types.js';
import { readCount } from './common.js';

interface OpenAiUsageValues {
  input: number | null;
  cached: number | null;
  output: number | null;
  reasoning: number | null;
  total: number | null;
}

const EMPTY_VALUES: OpenAiUsageValues = {
  input: null,
  cached: null,
  output: null,
  reasoning: null,
  total: null,
};

export class OpenAiUsageAccumulator {
  private values: OpenAiUsageValues = { ...EMPTY_VALUES };
  private sawUsage = false;
  private sawAuthoritative = false;

  constructor(
    private readonly dialect: 'responses' | 'chat',
    private readonly flags: Set<string>,
  ) {}

  observe(value: unknown, authoritative: boolean): void {
    const usage = asRecord(value);
    if (!usage) return;
    this.sawUsage = true;
    const inputField = this.dialect === 'responses' ? 'input_tokens' : 'prompt_tokens';
    const outputField = this.dialect === 'responses' ? 'output_tokens' : 'completion_tokens';
    const totalField = 'total_tokens';
    const detailsField = this.dialect === 'responses' ? 'input_tokens_details' : 'prompt_tokens_details';
    const outputDetailsField = this.dialect === 'responses' ? 'output_tokens_details' : 'completion_tokens_details';
    const next: OpenAiUsageValues = {
      input: readCount(usage, inputField, this.flags),
      cached: readCount(asRecord(usage[detailsField]), 'cached_tokens', this.flags),
      output: readCount(usage, outputField, this.flags),
      reasoning: readCount(asRecord(usage[outputDetailsField]), 'reasoning_tokens', this.flags),
      total: readCount(usage, totalField, this.flags),
    };

    if (authoritative && this.sawAuthoritative) this.flags.add('duplicate_terminal_usage');
    for (const field of Object.keys(next) as (keyof OpenAiUsageValues)[]) {
      const previous = this.values[field];
      const candidate = next[field];
      if (candidate === null) continue;
      if (previous !== null && previous !== candidate) this.flags.add(`conflicting_usage:${field}`);
      if (authoritative || previous === null) this.values[field] = candidate;
    }
    if (authoritative) this.sawAuthoritative = true;
  }

  snapshot(source: string): NormalizedUsage {
    const input = this.values.input;
    const cached = this.values.cached;
    const output = this.values.output;
    const reasoning = this.values.reasoning;
    const uncached = subtractCount(input, cached);
    const nonReasoning = subtractCount(output, reasoning);
    if (cached !== null && input !== null && cached > input) this.flags.add('contradictory_usage:cache_exceeds_input');
    if (reasoning !== null && output !== null && reasoning > output) {
      this.flags.add('contradictory_usage:reasoning_exceeds_output');
    }
    const canonicalTotal = addCounts(input, output);
    if (this.values.total !== null && canonicalTotal !== null && this.values.total !== canonicalTotal) {
      this.flags.add('contradictory_usage:provider_total');
    }
    const invalid = [...this.flags].some((flag) => flag.startsWith('invalid_count:'));
    return makeNormalizedUsage({
      inputTokensReported: input,
      inputTokensTotal: input,
      inputTokensAccuracy: input === null ? 'unknown' : 'reported_exact',
      inputTokensUncached: cached !== null && cached <= (input ?? -1) ? uncached : null,
      cacheReadInputTokens: cached,
      cacheWriteInputTokens: null,
      outputTokensReported: output,
      outputTokenSemantics: 'includes_thinking',
      outputTokensTotal: output,
      outputTokensAccuracy: output === null ? 'unknown' : 'reported_exact',
      thinkingTokens: reasoning,
      thinkingTokensAccuracy: reasoning === null ? 'unknown' : 'reported_exact',
      nonThinkingOutputTokens: reasoning !== null && reasoning <= (output ?? -1) ? nonReasoning : null,
      nonThinkingOutputTokensAccuracy: nonReasoning === null ? 'unknown' : 'derived_exact',
      providerTotalTokens: this.values.total,
      canonicalTotalTokens: canonicalTotal,
      usageSource: this.sawUsage ? source : null,
      usageCompleteness: usageCompleteness(input, output, this.sawUsage, invalid),
      qualityFlags: [...this.flags].filter((flag) => flag.includes('usage') || flag.startsWith('invalid_count:')),
    });
  }
}
