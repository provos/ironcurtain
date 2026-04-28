/**
 * Pure-data memory enablement helper.
 *
 * Combines the three signals that determine whether the memory MCP
 * server is mounted for a session: the global kill switch
 * (`userConfig.memory.enabled`), the per-persona opt-in, and the
 * per-job opt-in. The helper is the SINGLE point where these signals
 * are combined; all runtime sites call it.
 *
 * This file is intentionally pure-data: it imports types only, no
 * runtime modules from `src/persona/`. The loader-aware variant (which
 * needs `loadPersona`) lives in `src/persona/memory-gate.ts` to avoid
 * a `memory/ -> persona/ -> memory/` import cycle.
 */

// Type-only imports: no runtime edge, no cycle risk.
import type { PersonaDefinition } from '../persona/types.js';
import type { JobDefinition } from '../cron/types.js';
import type { ResolvedUserConfig } from '../config/user-config.js';

/**
 * Inputs to the memory-enablement decision. All scope fields optional;
 * absence is significant (e.g., no persona AND no job means a default
 * session, which never gets memory).
 */
export interface MemoryGateInputs {
  /** Loaded persona definition, or undefined for non-persona sessions. */
  readonly persona?: PersonaDefinition;
  /** Loaded job definition, or undefined for non-cron sessions. */
  readonly job?: JobDefinition;
  /** Resolved user config (always present at the call sites). */
  readonly userConfig: ResolvedUserConfig;
}

/**
 * Decides whether the memory MCP server is enabled for this session.
 *
 * Precedence (most-restrictive wins):
 *   1. Global kill switch: userConfig.memory.enabled === false -> off.
 *   2. Scope: no persona AND no job -> off (default sessions are stateless).
 *   3. Per-persona: persona.memory.enabled === false -> off.
 *   4. Per-job:     job.memory.enabled === false -> off.
 *   5. Otherwise: on.
 */
export function isMemoryEnabledFor(inputs: MemoryGateInputs): boolean {
  if (!inputs.userConfig.memory.enabled) return false;
  if (!inputs.persona && !inputs.job) return false;
  if (inputs.persona?.memory?.enabled === false) return false;
  if (inputs.job?.memory?.enabled === false) return false;
  return true;
}
