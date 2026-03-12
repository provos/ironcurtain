import type { MemoryConfig } from '../config.js';

type EmbedderPipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

let embedder: EmbedderPipeline | null = null;
let currentModel: string | null = null;

/**
 * Get or lazily initialize the embedding pipeline.
 * The pipeline is cached as a singleton — the model is only loaded once.
 */
export async function getEmbedder(config: MemoryConfig): Promise<EmbedderPipeline> {
  if (embedder && currentModel === config.embeddingModel) {
    return embedder;
  }

  const { pipeline } = await import('@huggingface/transformers');
  embedder = (await pipeline('feature-extraction', config.embeddingModel, {
    dtype: config.embeddingDtype as 'q8' | 'fp32' | 'fp16',
  })) as unknown as EmbedderPipeline;
  currentModel = config.embeddingModel;

  return embedder;
}

/**
 * Embed a text string into a 384-dimensional vector.
 * Lazily loads the model on first call.
 */
export async function embed(text: string, config: MemoryConfig): Promise<Float32Array> {
  const model = await getEmbedder(config);
  const result = await model(text, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}

/**
 * Compute cosine similarity between two vectors.
 * Assumes both vectors are already normalized (as produced by embed()).
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}
