import type { MemoryConfig } from '../config.js';
import type { ScoredMemory } from './scoring.js';

interface RerankerModel {
  tokenizer: {
    (texts: string[], options: { text_pair: string[]; padding: boolean; truncation: boolean }): Record<string, unknown>;
  };
  model: {
    (inputs: Record<string, unknown>): Promise<{ logits: { data: Float32Array; dims: number[] } }>;
  };
}

let cached: RerankerModel | null = null;
let currentModel: string | null = null;

/**
 * Get or lazily initialize the cross-encoder model and tokenizer.
 * Cached as a singleton — the model is only loaded once.
 */
export async function getReranker(config: MemoryConfig): Promise<RerankerModel> {
  if (cached && currentModel === config.rerankerModel) {
    return cached;
  }

  const { AutoTokenizer, AutoModelForSequenceClassification } = await import('@huggingface/transformers');
  const tokenizer = await AutoTokenizer.from_pretrained(config.rerankerModel);
  const model = await AutoModelForSequenceClassification.from_pretrained(config.rerankerModel, { dtype: 'q8' });

  cached = {
    tokenizer: tokenizer as unknown as RerankerModel['tokenizer'],
    model: model as unknown as RerankerModel['model'],
  };
  currentModel = config.rerankerModel;

  return cached;
}

/**
 * Reset the cached reranker instance. Primarily for testing.
 */
export function resetReranker(): void {
  cached = null;
  currentModel = null;
}

/**
 * Re-rank retrieval candidates using a cross-encoder model.
 *
 * Cross-encoders score (query, document) pairs jointly, producing much
 * more accurate relevance judgments than bi-encoder similarity alone.
 * Uses the low-level AutoModelForSequenceClassification API to get
 * raw logits — the high-level pipeline applies softmax which squashes
 * single-output models to always return 1.0.
 *
 * Returns a new array sorted by cross-encoder score (descending).
 * Each candidate's `rerankerScore` field is set to the raw model logit.
 */
export async function rerank(query: string, candidates: ScoredMemory[], config: MemoryConfig): Promise<ScoredMemory[]> {
  if (candidates.length === 0) return [];
  if (!config.rerankerEnabled) return candidates;

  const { tokenizer, model } = await getReranker(config);

  // Build parallel arrays for tokenizer's text_pair API
  const queries = candidates.map(() => query);
  const passages = candidates.map((mem) => mem.content);

  // Tokenize all pairs and run through the model
  const inputs = tokenizer(queries, { text_pair: passages, padding: true, truncation: true });
  const output = await model(inputs);

  // Extract raw logits (shape: [n_candidates, 1] for single-output cross-encoders)
  const logits = output.logits.data;
  const stride = output.logits.dims[1] ?? 1;

  // Attach scores and sort by cross-encoder relevance
  const reranked = candidates.map((mem, i) => {
    const out: ScoredMemory = { ...mem, rerankerScore: logits[i * stride] };
    return out;
  });

  reranked.sort((a, b) => (b.rerankerScore ?? 0) - (a.rerankerScore ?? 0));
  return reranked;
}
