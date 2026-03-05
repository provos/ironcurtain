/**
 * Loads tool description hints from a JSON config file and applies them
 * to proxied tool descriptions before exposing tools to agents.
 *
 * Hints help agents use MCP tool parameters correctly — e.g. avoiding
 * CLI flags in structured parameters or remembering required options.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProxiedTool } from './mcp-proxy-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface ToolDescriptionHint {
  server: string;
  tool: string;
  hint: string;
}

interface HintsFile {
  hints: ToolDescriptionHint[];
}

/**
 * Loads hints from `src/config/tool-description-hints.json` (or its
 * `dist/config/` equivalent). Returns an empty array if the file is
 * missing or malformed.
 */
export function loadToolDescriptionHints(): Map<string, string> {
  const hintsPath = resolve(__dirname, '..', 'config', 'tool-description-hints.json');
  try {
    const raw: unknown = JSON.parse(readFileSync(hintsPath, 'utf-8'));
    const file = raw as HintsFile;
    if (!Array.isArray(file.hints)) return new Map();
    const map = new Map<string, string>();
    for (const h of file.hints) {
      if (typeof h.server === 'string' && typeof h.tool === 'string' && typeof h.hint === 'string') {
        map.set(`${h.server}__${h.tool}`, h.hint);
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Returns a new tool list with hints appended to matching tool descriptions.
 * Tools without a matching hint are returned unchanged.
 */
export function applyToolDescriptionHints(tools: ProxiedTool[], hints: Map<string, string>): ProxiedTool[] {
  if (hints.size === 0) return tools;
  return tools.map((t) => {
    const hint = hints.get(`${t.serverName}__${t.name}`);
    if (!hint) return t;
    return {
      ...t,
      description: t.description ? `${t.description}\n\n${hint}` : hint,
    };
  });
}
