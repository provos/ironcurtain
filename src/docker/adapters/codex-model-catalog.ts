import type { ProviderModelMetadata } from '../../config/provider-definitions.js';

/** Serialize provider-supplied model metadata in Codex's catalog format. */
export function buildCodexModelCatalog(
  models: readonly (ProviderModelMetadata & { readonly id: string })[],
  label: string,
): string {
  return JSON.stringify(
    {
      models: models.map((metadata) => {
        const slug = metadata.id;
        return {
          slug,
          display_name: slug,
          description: `${label} model`,
          default_reasoning_level: metadata.reasoning?.defaultLevel,
          supported_reasoning_levels: (metadata.reasoning?.levels ?? []).map((effort) => ({
            effort,
            description: `${effort} reasoning`,
          })),
          shell_type: 'shell_command',
          visibility: 'list',
          supported_in_api: true,
          priority: 0,
          base_instructions: '',
          supports_reasoning_summaries: metadata.reasoning?.summaries ?? false,
          default_reasoning_summary: 'none',
          support_verbosity: false,
          apply_patch_tool_type: 'freeform',
          truncation_policy: { mode: 'bytes', limit: 10000 },
          context_window: metadata.contextWindow,
          max_context_window: metadata.contextWindow,
          effective_context_window_percent: 95,
          supports_parallel_tool_calls: metadata.parallelToolCalls ?? false,
          experimental_supported_tools: [],
          input_modalities: metadata.inputModalities,
        };
      }),
    },
    null,
    2,
  );
}
