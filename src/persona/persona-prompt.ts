/**
 * Persona system prompt augmentation.
 *
 * Builds the system prompt fragment injected when a session is
 * created with a persona. Includes the persona description and
 * the contents of the persistent memory file (workspace/memory.md).
 */

import { existsSync, readFileSync } from 'node:fs';
import type { PersonaDefinition } from './types.js';

/**
 * Builds the system prompt augmentation for a persona session.
 *
 * Includes the persona's description and the current contents of
 * the memory file. The agent is instructed to read and update the
 * memory file across sessions.
 *
 * @param persona - The persona definition.
 * @param memoryPath - Absolute path to the memory file (workspace/memory.md).
 */
export function buildPersonaSystemPromptAugmentation(persona: PersonaDefinition, memoryPath: string): string {
  const memoryContent = existsSync(memoryPath) ? readFileSync(memoryPath, 'utf-8') : '';

  return `
## Persona: ${persona.name}

${persona.description}

## Persistent Memory

You have a persistent memory file at: ${memoryPath}
This file survives across sessions. Use it to remember important context:
- User preferences and patterns
- Ongoing tasks and their status
- Key decisions and their reasoning
- Names, dates, and recurring items

Read this file at the start of each session to recall prior context.
Before the session ends, update it with anything worth remembering.
Keep it concise and organized — this is your long-term memory.

${memoryContent ? `### Current Memory Contents\n\n${memoryContent}` : 'The memory file is currently empty — this is your first session.'}
`.trim();
}
