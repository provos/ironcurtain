import type { MemoryConfig } from '../config.js';
import type { ScoredMemory } from './scoring.js';

/**
 * Output shape from the text-classification pipeline for a single input.
 * Cross-encoders produce a single label with a relevance logit as the score.
 */
interface ClassificationResult {
  label: string;
  score: number;
}

type ClassifierPipeline = (
  inputs: [string, string][],
  options?: { top_k?: number },
) => Promise<ClassificationResult[] | ClassificationResult[][]>;

let classifier: ClassifierPipeline | null = null;
let currentModel: string | null = null;

/**
 * Get or lazily initialize the cross-encoder pipeline.
 * Cached as a singleton -- the model is only loaded once.
 */
export async function getReranker(config: MemoryConfig): Promise<ClassifierPipeline> {
  if (classifier && currentModel === config.rerankerModel) {
    return classifier;
  }

  const { pipeline } = await import('@huggingface/transformers');
  classifier = (await pipeline('text-classification', config.rerankerModel, {
    dtype: 'q8' as const,
  })) as unknown as ClassifierPipeline;
  currentModel = config.rerankerModel;

  return classifier;
}

/**
 * Reset the cached reranker instance. Primarily for testing.
 */
export function resetReranker(): void {
  classifier = null;
  currentModel = null;
}

/**
 * Re-rank retrieval candidates using a cross-encoder model.
 *
 * Cross-encoders score (query, document) pairs jointly, producing much
 * more accurate relevance judgments than bi-encoder similarity alone.
 * The trade-off is latency -- cross-encoders can't pre-compute document
 * embeddings, so we only run them on the already-filtered candidate set.
 *
 * Returns a new array sorted by cross-encoder score (descending).
 * Each candidate's `rerankerScore` field is set to the raw model logit.
 */
export async function rerank(query: string, candidates: ScoredMemory[], config: MemoryConfig): Promise<ScoredMemory[]> {
  if (candidates.length === 0) return [];
  if (!config.rerankerEnabled) return candidates;

  const model = await getReranker(config);

  // Build (query, passage) pairs for the cross-encoder
  const pairs: [string, string][] = candidates.map((mem) => [query, mem.content]);

  // Score all pairs in a single batch for efficiency
  const rawResults = await model(pairs, { top_k: 1 });

  // Normalize results: single-pair returns ClassificationResult[],
  // multi-pair returns ClassificationResult[][] (one array per pair)
  const scores = extractScores(rawResults, candidates.length);

  // Attach scores and sort by cross-encoder relevance
  const reranked = candidates.map((mem, i) => {
    const out: ScoredMemory = { ...mem, rerankerScore: scores[i] };
    return out;
  });

  reranked.sort((a, b) => (b.rerankerScore ?? 0) - (a.rerankerScore ?? 0));
  return reranked;
}

/**
 * Extract a flat array of relevance scores from the classifier output.
 *
 * The text-classification pipeline returns different shapes depending on
 * whether the input was a single pair or a batch:
 * - Single pair: [{ label, score }]  (flat array of labels)
 * - Batch: [[{ label, score }], [{ label, score }], ...]  (nested)
 */
export function extractScores(
  results: ClassificationResult[] | ClassificationResult[][],
  expectedLength: number,
): number[] {
  if (expectedLength === 0) return [];

  // Detect nested vs flat by checking the first element
  const first = results[0];
  if (Array.isArray(first)) {
    // Nested: one array of results per input pair
    return (results as ClassificationResult[][]).map((r) => r[0]?.score ?? 0);
  }

  // Flat: single input produced one array of results.
  // For a single pair with top_k=1, we get one result element.
  if (expectedLength === 1) {
    return [first.score];
  }

  // Flat array with multiple results (one per pair)
  return (results as ClassificationResult[]).map((r) => r.score);
}
