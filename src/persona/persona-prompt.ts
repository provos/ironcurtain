/**
 * Persona system prompt augmentation.
 *
 * Builds the system prompt fragment injected when a session is
 * created with a persona. Includes the persona description and,
 * when memory is enabled, the MCP-based memory system prompt.
 */

import { buildMemorySystemPrompt, adaptMemoryToolNames } from '../memory/memory-prompt.js';
import type { PersonaDefinition } from './types.js';

/**
 * Builds the system prompt augmentation for a persona session.
 *
 * When memory is enabled, appends the memory system prompt with
 * the persona name for namespace context. When disabled, only
 * includes the persona name and description.
 *
 * @param persona - The persona definition.
 * @param memoryEnabled - Whether the MCP memory system is active.
 */
export function buildPersonaSystemPromptAugmentation(persona: PersonaDefinition, memoryEnabled: boolean): string {
  const sections: string[] = [`## Persona: ${persona.name}`, '', persona.description];

  if (memoryEnabled) {
    sections.push('');
    sections.push(adaptMemoryToolNames(buildMemorySystemPrompt({ persona: persona.name })));
  }

  return sections.join('\n');
}
