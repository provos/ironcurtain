import type { MemoryConfig } from '../config.js';

type EmbedderPipeline = (
  text: string,
  options: { pooling: string; normalize: boolean },
) => Promise<{ data: ArrayLike<number> }>;

let cachedPromise: Promise<EmbedderPipeline> | null = null;
let currentModel: string | null = null;

/**
 * BGE models use asymmetric prefixes — queries get an instruction prefix
 * so the model embeds them closer to relevant passages rather than
 * syntactically similar text.
 */
const QUERY_PREFIXES: Record<string, string> = {
  'Xenova/bge-base-en-v1.5': 'Represent this sentence for searching relevant passages: ',
  'Xenova/bge-small-en-v1.5': 'Represent this sentence for searching relevant passages: ',
  'BAAI/bge-base-en-v1.5': 'Represent this sentence for searching relevant passages: ',
  'BAAI/bge-small-en-v1.5': 'Represent this sentence for searching relevant passages: ',
};

/**
 * Get or lazily initialize the embedding pipeline.
 * The pipeline is cached as a singleton — the model is only loaded once.
 */
export async function getEmbedder(config: MemoryConfig): Promise<EmbedderPipeline> {
  if (cachedPromise && currentModel === config.embeddingModel) {
    return cachedPromise;
  }

  // Cache the loading promise to prevent concurrent calls from racing
  currentModel = config.embeddingModel;
  cachedPromise = loadEmbedder(config).catch((e: unknown) => {
    cachedPromise = null;
    currentModel = null;
    throw e;
  });

  return cachedPromise;
}

async function loadEmbedder(config: MemoryConfig): Promise<EmbedderPipeline> {
  const { pipeline } = await import('@huggingface/transformers');
  return (await pipeline('feature-extraction', config.embeddingModel, {
    dtype: config.embeddingDtype as 'q8' | 'fp32' | 'fp16',
  })) as unknown as EmbedderPipeline;
}

/**
 * Embed a document (memory content) into a vector.
 * Documents are embedded as-is — no prefix applied.
 */
export async function embed(text: string, config: MemoryConfig): Promise<Float32Array> {
  const model = await getEmbedder(config);
  const result = await model(text, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}

/**
 * Embed a query for retrieval. Applies the model's asymmetric query prefix
 * so the embedding is optimized for matching against document passages
 * rather than syntactically similar text.
 */
export async function embedQuery(text: string, config: MemoryConfig): Promise<Float32Array> {
  const prefix = QUERY_PREFIXES[config.embeddingModel] ?? '';
  return embed(prefix + text, config);
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
