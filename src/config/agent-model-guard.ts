import { DOCKER_AGENTS } from './user-config.js';

/**
 * Guard against the common `--model <agent-name>` slip.
 *
 * `--agent` selects the agent (claude-code / goose / codex); `--model` only
 * overrides the LLM model ID. Passing an agent name to `--model` silently runs
 * the wrong (default) agent with a bogus model override, so the CLI entry
 * points (`start`, `mux`) reject it up front rather than launching the wrong
 * thing.
 *
 * Pure and side-effect free: returns a user-facing error message when `model`
 * is actually an agent name, otherwise `null`. Callers print it and exit in
 * their own style.
 */
export function modelFlagMisusedAsAgent(model: string | undefined): string | null {
  if (model === undefined) return null;
  if (!(DOCKER_AGENTS as readonly string[]).includes(model)) return null;
  return (
    `"${model}" is an agent, not a model. Did you mean --agent ${model}?\n` +
    `--agent selects the agent (${DOCKER_AGENTS.join(', ')}); ` +
    `--model only overrides the LLM model ID (e.g. --model claude-opus-4-8).`
  );
}
