/**
 * Compact server listing — `{ name, description }` pairs the agent
 * receives in its system prompt to bootstrap progressive tool
 * disclosure (the agent calls `help.help('serverName')` to discover
 * a server's tools on demand).
 *
 * Lives in `src/types/` because both code-mode (`session/prompts.ts`)
 * and Docker-mode (`docker/orientation.ts`, `docker/agent-adapter.ts`)
 * system-prompt builders consume it.
 */
export interface ServerListing {
  name: string;
  description: string;
}
