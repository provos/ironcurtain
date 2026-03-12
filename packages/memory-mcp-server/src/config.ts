import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface MemoryConfig {
  // Storage
  dbPath: string;
  namespace: string;

  // Embeddings
  embeddingModel: string;
  embeddingDtype: string;

  // LLM
  llmBaseUrl: string | null;
  llmApiKey: string | null;
  llmModel: string;

  // Maintenance
  decayThreshold: number;
  maintenanceInterval: number;
  compactionMinGroup: number;

  // Retrieval
  defaultTokenBudget: number;
}

type EnvSource = Record<string, string | undefined>;

function envFloat(env: EnvSource, key: string, fallback: number): number {
  const val = env[key];
  if (val === undefined) return fallback;
  const parsed = parseFloat(val);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envInt(env: EnvSource, key: string, fallback: number): number {
  const val = env[key];
  if (val === undefined) return fallback;
  const parsed = parseInt(val, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function loadConfig(env: EnvSource = process.env): MemoryConfig {
  const defaultDbPath = resolve(homedir(), '.local', 'share', 'memory-mcp', 'default.db');

  return {
    dbPath: env.MEMORY_DB_PATH ?? defaultDbPath,
    namespace: env.MEMORY_NAMESPACE ?? 'default',

    embeddingModel: env.MEMORY_EMBEDDING_MODEL ?? 'Xenova/all-MiniLM-L6-v2',
    embeddingDtype: env.MEMORY_EMBEDDING_DTYPE ?? 'q8',

    llmBaseUrl: env.MEMORY_LLM_BASE_URL ?? null,
    llmApiKey: env.MEMORY_LLM_API_KEY ?? null,
    llmModel: env.MEMORY_LLM_MODEL ?? 'claude-haiku-4-5-20251001',

    decayThreshold: envFloat(env, 'MEMORY_DECAY_THRESHOLD', 0.05),
    maintenanceInterval: envInt(env, 'MEMORY_MAINTENANCE_INTERVAL', 50),
    compactionMinGroup: envInt(env, 'MEMORY_COMPACTION_MIN_GROUP', 10),

    defaultTokenBudget: envInt(env, 'MEMORY_DEFAULT_TOKEN_BUDGET', 500),
  };
}
