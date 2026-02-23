/**
 * Registry of known agent adapters.
 *
 * New agents are added by implementing AgentAdapter and registering here.
 * The registry is a simple Map -- no dynamic loading or plugin system.
 */

import type { AgentAdapter, AgentId } from './agent-adapter.js';

const registry = new Map<AgentId, AgentAdapter>();

export function registerAgent(adapter: AgentAdapter): void {
  if (registry.has(adapter.id)) {
    throw new Error(`Agent adapter already registered: ${adapter.id}`);
  }
  registry.set(adapter.id, adapter);
}

export function getAgent(id: AgentId): AgentAdapter {
  const adapter = registry.get(id);
  if (!adapter) {
    const available = [...registry.keys()].join(', ');
    throw new Error(`Unknown agent: ${id}. Available: ${available || 'none'}`);
  }
  return adapter;
}

export function listAgents(): readonly AgentAdapter[] {
  return [...registry.values()];
}

/**
 * Ensures all built-in agent adapters are registered. Safe to call
 * multiple times -- skips adapters that are already registered.
 */
export async function registerBuiltinAdapters(): Promise<void> {
  const { claudeCodeAdapter } = await import('./adapters/claude-code.js');
  if (!registry.has(claudeCodeAdapter.id)) {
    registry.set(claudeCodeAdapter.id, claudeCodeAdapter);
  }
}
