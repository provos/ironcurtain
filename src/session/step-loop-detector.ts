/**
 * StepLoopDetector -- Agent-level loop detection.
 *
 * Analyzes each execute_code step (code + result) using a 2x2 progress
 * matrix to detect stuck or stagnating agents. The unit of analysis is
 * the step, not individual MCP calls.
 *
 * Progress matrix:
 *   - Full progress:    new approach + new outcome → reset concern
 *   - World changed:    repeated approach + new outcome → reset concern
 *   - Stuck:            new approach + repeated outcome → increment stuck
 *   - Full stagnation:  repeated approach + repeated outcome → increment stagnation
 */

import { computeHash } from '../hash.js';

export type ProgressCategory = 'full_progress' | 'world_changed' | 'stuck' | 'full_stagnation';

export type BlockVerdict = { action: 'block'; message: string; category: ProgressCategory };

export type StepVerdict =
  | { action: 'allow' }
  | { action: 'warn'; message: string; category: ProgressCategory }
  | BlockVerdict;

export interface StepLoopDetectorConfig {
  stagnation: { warn: number; block: number };
  stuck: { warn: number; block: number };
}

const DEFAULT_CONFIG: StepLoopDetectorConfig = {
  stagnation: { warn: 3, block: 5 },
  stuck: { warn: 5, block: 8 },
};

export class StepLoopDetector {
  private readonly config: StepLoopDetectorConfig;
  private approachHashes = new Set<string>();
  private outcomeHashes = new Set<string>();
  private stagnationStreak = 0;
  private stuckStreak = 0;
  private blocked = false;
  private blockVerdict: BlockVerdict | null = null;

  constructor(config?: Partial<StepLoopDetectorConfig>) {
    this.config = {
      stagnation: { ...DEFAULT_CONFIG.stagnation, ...config?.stagnation },
      stuck: { ...DEFAULT_CONFIG.stuck, ...config?.stuck },
    };
  }

  /**
   * Check if execution is blocked before running code.
   * Returns the block verdict if blocked, null otherwise.
   */
  isBlocked(): BlockVerdict | null {
    return this.blocked ? this.blockVerdict : null;
  }

  /**
   * Analyze a completed step and return a verdict.
   *
   * @param code - The TypeScript code that was executed
   * @param result - The execution result (will be hashed)
   */
  analyzeStep(code: string, result: unknown): StepVerdict {
    const approachHash = computeHash(code);
    const outcomeHash = computeHash(result);

    const isNewApproach = !this.approachHashes.has(approachHash);
    const isNewOutcome = !this.outcomeHashes.has(outcomeHash);

    this.approachHashes.add(approachHash);
    this.outcomeHashes.add(outcomeHash);

    const category = this.classify(isNewApproach, isNewOutcome);
    this.updateStreaks(category);

    return this.checkThresholds();
  }

  /** Reset all state. */
  reset(): void {
    this.approachHashes.clear();
    this.outcomeHashes.clear();
    this.stagnationStreak = 0;
    this.stuckStreak = 0;
    this.blocked = false;
    this.blockVerdict = null;
  }

  private classify(isNewApproach: boolean, isNewOutcome: boolean): ProgressCategory {
    if (isNewApproach && isNewOutcome) return 'full_progress';
    if (!isNewApproach && isNewOutcome) return 'world_changed';
    if (isNewApproach && !isNewOutcome) return 'stuck';
    return 'full_stagnation';
  }

  private updateStreaks(category: ProgressCategory): void {
    switch (category) {
      case 'full_progress':
      case 'world_changed':
        this.stagnationStreak = 0;
        this.stuckStreak = 0;
        break;
      case 'stuck':
        this.stuckStreak++;
        this.stagnationStreak = 0;
        break;
      case 'full_stagnation':
        this.stagnationStreak++;
        this.stuckStreak = 0;
        break;
    }
  }

  private checkThresholds(): StepVerdict {
    // Check block thresholds first
    if (this.stagnationStreak >= this.config.stagnation.block) {
      const verdict: BlockVerdict = {
        action: 'block',
        message:
          'LOOP DETECTED: You have been repeating the same code with the same result. ' +
          'Execution is now blocked. Summarize what you have accomplished and stop.',
        category: 'full_stagnation',
      };
      this.blocked = true;
      this.blockVerdict = verdict;
      return verdict;
    }

    if (this.stuckStreak >= this.config.stuck.block) {
      const verdict: BlockVerdict = {
        action: 'block',
        message:
          'LOOP DETECTED: You keep trying different approaches but getting the same result. ' +
          'Execution is now blocked. Summarize what you have accomplished and stop.',
        category: 'stuck',
      };
      this.blocked = true;
      this.blockVerdict = verdict;
      return verdict;
    }

    // Check warn thresholds
    if (this.stagnationStreak >= this.config.stagnation.warn) {
      return {
        action: 'warn',
        message:
          'WARNING: You are repeating the same code with the same result. ' +
          `Try a fundamentally different approach. (${this.stagnationStreak}/${this.config.stagnation.block} before block)`,
        category: 'full_stagnation',
      };
    }

    if (this.stuckStreak >= this.config.stuck.warn) {
      return {
        action: 'warn',
        message:
          'WARNING: Different approaches are producing the same result. ' +
          `Re-examine your assumptions. (${this.stuckStreak}/${this.config.stuck.block} before block)`,
        category: 'stuck',
      };
    }

    return { action: 'allow' };
  }
}
