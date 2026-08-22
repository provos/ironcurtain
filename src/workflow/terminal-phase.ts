/** Terminal phases shared by the daemon projection and disk-only CLI tools. */
export type TerminalWorkflowPhase = 'completed' | 'failed' | 'aborted';

/**
 * Map a terminal state name using the same convention as the orchestrator.
 * Abort/fail matching is case-insensitive; every other terminal is success.
 */
export function terminalPhaseFromStateName(name: string): TerminalWorkflowPhase {
  const normalized = name.toLowerCase();
  if (normalized.includes('abort')) return 'aborted';
  if (normalized.includes('fail')) return 'failed';
  return 'completed';
}

export function isTerminalWorkflowPhase(value: string | undefined): value is TerminalWorkflowPhase {
  return value === 'completed' || value === 'failed' || value === 'aborted';
}
