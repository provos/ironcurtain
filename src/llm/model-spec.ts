/**
 * Model/backend spec parsing for control-plane LLM calls.
 *
 * API model IDs keep their existing shape (`provider:model`). CLI-backed
 * control-plane models use explicit backend prefixes so they are never
 * confused with provider-qualified API models.
 */

export const CLI_LLM_BACKENDS = ['codex-cli', 'claude-cli', 'claude-code-cli'] as const;
export type CliLlmBackendId = (typeof CLI_LLM_BACKENDS)[number];

export interface ParsedCliLlmModelId {
  readonly backend: CliLlmBackendId;
  /**
   * Backend-specific model name. The sentinel "default" means "do not pass a
   * model flag; let the CLI choose its configured default".
   */
  readonly modelId: string | undefined;
}

const CLI_BACKEND_SET = new Set<string>(CLI_LLM_BACKENDS);

/**
 * Parses CLI-backed model IDs such as `codex-cli:gpt-5.2` or
 * `claude-code-cli:sonnet`. Returns undefined for API-backed IDs.
 */
export function parseCliLlmModelId(qualifiedId: string): ParsedCliLlmModelId | undefined {
  const colonIndex = qualifiedId.indexOf(':');
  if (colonIndex === -1) return undefined;

  const prefix = qualifiedId.slice(0, colonIndex);
  if (!CLI_BACKEND_SET.has(prefix)) return undefined;

  const rawModelId = qualifiedId.slice(colonIndex + 1).trim();
  if (!rawModelId) {
    throw new Error(`Empty CLI model ID in "${qualifiedId}". Expected "${prefix}:default" or "${prefix}:model-name".`);
  }

  return {
    backend: prefix as CliLlmBackendId,
    modelId: rawModelId === 'default' ? undefined : rawModelId,
  };
}

export function isCliLlmModelId(qualifiedId: string): boolean {
  return parseCliLlmModelId(qualifiedId) !== undefined;
}

export function formatCliLlmBackendLabel(backend: CliLlmBackendId): string {
  switch (backend) {
    case 'codex-cli':
      return 'Codex CLI';
    case 'claude-cli':
    case 'claude-code-cli':
      return 'Claude Code CLI';
  }
}
