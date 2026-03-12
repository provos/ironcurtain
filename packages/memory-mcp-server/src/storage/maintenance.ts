import type Database from 'better-sqlite3';
import type { MemoryRow } from './database.js';
import type { MemoryConfig } from '../config.js';
import { getRandomActiveMemories, markDecayed } from './queries.js';
import { runCompaction } from './compaction.js';
import { runConsolidation } from './consolidation.js';

const SAMPLE_SIZE = 100;

let storeCounter = 0;

/**
 * Reset the store counter (useful for testing).
 */
export function resetMaintenanceCounter(): void {
  storeCounter = 0;
}

export interface MaintenanceResult {
  consolidated: number;
  merged: number;
  superseded: number;
  decayed: number;
  compacted: number;
}

/**
 * Called after each store operation. Runs maintenance every N stores.
 */
export async function maybeRunMaintenance(db: Database.Database, config: MemoryConfig): Promise<MaintenanceResult> {
  storeCounter++;
  if (storeCounter < config.maintenanceInterval) {
    return { consolidated: 0, merged: 0, superseded: 0, decayed: 0, compacted: 0 };
  }
  storeCounter = 0;
  return runMaintenance(db, config);
}

/**
 * Run a full maintenance pass: consolidation + decay check + compaction.
 */
export async function runMaintenance(db: Database.Database, config: MemoryConfig): Promise<MaintenanceResult> {
  // Phase 0: Consolidation -- batch-resolve duplicates/contradictions
  const consolidation = await runConsolidation(db, config);

  // Phase 1: Decay -- sample random memories and check vitality
  const now = Date.now();
  const sample = getRandomActiveMemories(db, config.namespace, SAMPLE_SIZE);

  let decayed = 0;
  for (const mem of sample) {
    const vitality = computeVitality(mem, now);
    if (vitality < config.decayThreshold) {
      markDecayed(db, mem.id);
      decayed++;
    }
  }

  // Phase 2: Compaction
  const compacted = await runCompaction(db, config);

  return { ...consolidation, decayed, compacted };
}

/**
 * Compute the vitality of a memory — a value between 0 and 1 indicating
 * how "alive" the memory is. Vitality below the decay threshold triggers decay.
 *
 * Factors:
 * - Time-based decay with half-life proportional to importance
 * - Access reinforcement: each access extends lifetime
 * - Recency of last access
 */
export function computeVitality(mem: MemoryRow, now: number): number {
  const ageHours = (now - mem.created_at) / 3600000;

  // Half-life proportional to importance: importance=1.0 -> 180-day half-life
  const halfLifeHours = mem.importance * 180 * 24;
  if (halfLifeHours <= 0) return 0;

  const baseDecay = Math.pow(0.5, ageHours / halfLifeHours);

  // Access reinforcement: each access extends effective lifetime (capped at 0.4)
  const reinforcement = Math.min(mem.access_count * 0.03, 0.4);

  // Recency of last access (60-day characteristic time)
  const accessAgeHours = (now - mem.last_accessed_at) / 3600000;
  const accessRecency = Math.exp(-accessAgeHours / (60 * 24));

  return Math.min(1.0, baseDecay + reinforcement * accessRecency);
}
