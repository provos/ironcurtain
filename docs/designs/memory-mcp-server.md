# Design: Memory MCP Server for IronCurtain

**Status:** Superseded by `memory-mcp-server-v2.md`
**Date:** 2026-03-09

## 1. Problem Statement

IronCurtain agents need persistent memory across sessions. Currently, personas use a `memory.md` file inside the agent's sandbox workspace, which has three significant problems:

1. **Full contents injected into system prompt.** The `buildPersonaSystemPromptAugmentation()` function reads the entire `memory.md` file and embeds it in the system prompt. This wastes context window tokens and does not scale as memory grows.

2. **No structured retrieval.** The agent can only read the entire file or use filesystem tools to grep through it. There is no semantic search, no categorization, and no way to retrieve just the relevant memories for a given task.

3. **No memory for non-persona sessions.** Regular sessions and cron jobs each have ad-hoc memory approaches (cron uses `workspace/memory.md` via prompt convention), but there is no unified memory system.

### Goals

- Provide persistent, structured memory accessible via MCP tools (not system prompt injection)
- Support multiple namespaces: personas, cron jobs, and optionally regular sessions
- Configurable: memory is opt-in via user config
- Security: agents cannot access other namespaces' memories
- Simple initial implementation with extension points for richer capabilities later

## 2. Research Findings

### Existing MCP Memory Servers

#### `@modelcontextprotocol/server-memory` (Official)

- **API:** 9 tools -- `create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`, `delete_relations`, `read_graph`, `search_nodes`, `open_nodes`
- **Storage:** JSONL file (`memory.jsonl`) with a knowledge graph model (entities, relations, observations)
- **Config:** `MEMORY_FILE_PATH` env var for custom storage location
- **License:** MIT
- **Downloads:** ~44k/week
- **Pros:** Official, well-maintained, MIT license, TypeScript, simple JSONL storage, `MEMORY_FILE_PATH` env var makes namespacing trivial (point each session at a different file)
- **Cons:** Knowledge graph model is complex for simple use cases (9 tools is a large API surface for an LLM to learn), no built-in semantic search, `search_nodes` is substring matching only, `read_graph` returns everything (no pagination), no TTL/expiry, no size limits

#### `@mem0/mcp-server` (Mem0)

- **API:** `add_memory`, `search_memory` (simpler)
- **Storage:** Cloud-hosted via Mem0 API (requires API key and account)
- **Pros:** Semantic search built-in, simple 2-tool API, automatic memory extraction
- **Cons:** Cloud dependency (data leaves the machine), requires Mem0 account/API key, not self-hosted, violates IronCurtain's local-first security model

#### Community forks (`mcp-knowledge-graph`, `@itseasy21/mcp-knowledge-graph`, etc.)

- Mostly forks of the official server with minor customizations (custom memory path, refactored data structures)
- None add semantic search or fundamentally improve the model

### Evaluation

| Criterion | Official server-memory | Mem0 | Custom built |
|---|---|---|---|
| Local-only storage | Yes | No (cloud) | Yes |
| Simple API | No (9 tools) | Yes (2 tools) | Yes (controllable) |
| Namespacing | Via `MEMORY_FILE_PATH` | Via user_id | Via file path |
| Semantic search | No (substring) | Yes | Future extension |
| MIT license | Yes | N/A | N/A |
| No extra dependencies | npx spawns it | Requires API key | Bundled |
| Knowledge graph model | Yes (entities/relations) | Flat memories | Controllable |

## 3. Recommended Approach: Use `@modelcontextprotocol/server-memory`

**Use the official `@modelcontextprotocol/server-memory` package**, configured per-namespace via the `MEMORY_FILE_PATH` environment variable. This is the right choice for several reasons:

1. **Already works.** The official server is production-quality, MIT-licensed, and actively maintained. Building our own gains nothing in the initial version.

2. **Namespacing is trivial.** Setting `MEMORY_FILE_PATH` per-session to point at the appropriate directory (`~/.ironcurtain/personas/<name>/memory.jsonl`, `~/.ironcurtain/jobs/<jobId>/memory.jsonl`, or `~/.ironcurtain/memory/default.jsonl`) gives us complete namespace isolation with zero custom code.

3. **Knowledge graph model is more powerful than flat key-value.** While 9 tools is a large surface, the knowledge graph model lets agents store relationships between concepts, not just isolated facts. This is more useful for personas that need to remember complex user contexts. The system prompt can guide the agent to use a small subset of tools (primarily `create_entities`, `add_observations`, `search_nodes`).

4. **Extension path is clear.** When we need semantic search, we can either fork the server or build a wrapper that adds an embedding layer on top of the same JSONL storage. The storage format does not lock us in.

5. **No cloud dependency.** Unlike Mem0, everything stays local.

### What we do NOT do

- We do **not** fork or wrap the server initially. We use it as-is via npx.
- We do **not** build semantic search in v1. Substring matching via `search_nodes` is sufficient for the initial implementation.
- We do **not** inject memory contents into the system prompt. The system prompt tells the agent the memory server exists; the agent calls its tools to read/write.

## 4. Memory Server Configuration

### MCP Server Entry

The memory server is **not** listed in `mcp-servers.json` as a static entry. It is dynamically injected into the session's `mcpServers` config by `buildSessionConfig()` when memory is enabled, with the `MEMORY_FILE_PATH` set per-namespace.

```typescript
// Dynamically injected -- not in mcp-servers.json
const memoryServerConfig: MCPServerConfig = {
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-memory'],
  env: {
    MEMORY_FILE_PATH: memoryFilePath,  // namespace-specific
  },
  description: 'Persistent memory across sessions (knowledge graph)',
  sandbox: false,  // Data file is outside sandbox; server needs access
};
```

### Why dynamic injection (not static in mcp-servers.json)

1. **`MEMORY_FILE_PATH` varies per session** -- persona sessions point at `~/.ironcurtain/personas/<name>/memory.jsonl`, cron jobs at `~/.ironcurtain/jobs/<jobId>/memory.jsonl`, regular sessions at `~/.ironcurtain/memory/default.jsonl`. A static entry cannot express this.

2. **Conditional spawning** -- when memory is disabled in config, the server should not be spawned at all. Dynamic injection makes this a simple `if` check.

3. **Server allowlist compatibility** -- persona server allowlists filter `mcpServers` keys. By injecting with a known key `"memory"`, it naturally participates in allowlist filtering. Personas that do not list `"memory"` in their `servers` array will not get the memory server (assuming the allowlist is respected). However, since memory is integral to the persona concept, `"memory"` should be treated like `"filesystem"` -- always included when memory is enabled, regardless of allowlist.

## 5. Storage Layout

```
~/.ironcurtain/
  memory/
    default.jsonl           # Regular (non-persona, non-cron) sessions
  personas/
    alice/
      memory.jsonl          # Persona "alice" memory
      workspace/
        memory.md           # Legacy (deprecated, kept for backward compat)
    bob/
      memory.jsonl          # Persona "bob" memory
  jobs/
    daily-review/
      memory.jsonl          # Cron job memory
```

Each `memory.jsonl` file is the standard `@modelcontextprotocol/server-memory` JSONL format (entities, relations, observations as line-delimited JSON).

### Namespace resolution

```typescript
function resolveMemoryFilePath(
  opts: { persona?: string; jobId?: string },
): string {
  if (opts.persona) {
    const name = createPersonaName(opts.persona);
    return resolve(getPersonaDir(name), 'memory.jsonl');
  }
  if (opts.jobId) {
    return resolve(getJobDir(opts.jobId), 'memory.jsonl');
  }
  // Default namespace for regular sessions
  return resolve(getIronCurtainHome(), 'memory', 'default.jsonl');
}
```

### Security invariant

The `MEMORY_FILE_PATH` always resolves to a path **outside** the agent's sandbox. The agent cannot read or modify the JSONL file directly via the filesystem server -- it can only interact through the memory server's MCP tools. This is enforced structurally: the filesystem server's allowed directory is the sandbox, and the memory file lives under `~/.ironcurtain/`.

## 6. Session Integration

### Changes to `buildSessionConfig()`

After existing config patching (sandbox dir, policy dir, etc.), conditionally inject the memory server:

```typescript
// In buildSessionConfig(), after patchMcpServerAllowedDirectory():

if (config.userConfig.memory?.enabled !== false) {
  const memoryFilePath = resolveMemoryFilePath({
    persona: opts.persona,
    jobId: opts.jobId,
  });

  // Ensure parent directory exists
  mkdirSync(dirname(memoryFilePath), { recursive: true });

  sessionConfig.mcpServers['memory'] = {
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {
      MEMORY_FILE_PATH: memoryFilePath,
    },
    description: 'Persistent memory across sessions (knowledge graph)',
    sandbox: false,
  };
}
```

### Changes to SessionOptions

Add an optional `jobId` field (or thread it from the cron system) so `buildSessionConfig` can resolve the correct memory namespace. Personas already have `opts.persona`. Regular sessions use the default namespace.

```typescript
export interface SessionOptions {
  // ... existing fields ...

  /**
   * Job ID for cron-initiated sessions. Used to resolve
   * the job-specific memory namespace.
   */
  jobId?: string;
}
```

### Server allowlist treatment

The `"memory"` server is always included when memory is enabled, regardless of persona server allowlist -- same as `"filesystem"`. The `applyServerAllowlist()` function's hardcoded always-include set expands from `['filesystem']` to `['filesystem', 'memory']`.

## 7. System Prompt Augmentation

### Current approach (to be replaced for personas)

Currently, `buildPersonaSystemPromptAugmentation()` reads `memory.md` and injects its full contents into the system prompt. This is replaced with a lightweight pointer:

```typescript
export function buildPersonaSystemPromptAugmentation(
  persona: PersonaDefinition,
): string {
  return `
## Persona: ${persona.name}

${persona.description}

## Persistent Memory

You have access to a persistent memory server ("memory") that stores a knowledge graph across sessions.

At the **start** of each session:
- Call \`memory.search_nodes\` with relevant keywords to recall prior context
- Call \`memory.open_nodes\` for specific entities you remember by name

During the session, when you learn something worth remembering:
- Use \`memory.create_entities\` to store new concepts (people, projects, decisions, preferences)
- Use \`memory.add_observations\` to add facts to existing entities
- Use \`memory.create_relations\` to link related concepts

Keep memories **atomic** (one fact per observation) and **concise**.
Do NOT call \`memory.read_graph\` unless you specifically need the full graph -- prefer targeted searches.
`.trim();
}
```

### For cron jobs

The cron system prompt augmentation (`buildCronSystemPromptAugmentation`) is updated similarly -- replace the `workspace/memory.md` convention with memory server instructions:

```typescript
// In the scheduled task prompt:
`### Persistent Memory

You have access to a persistent memory server for this job.
- At the start of each run, call \`memory.search_nodes\` to recall context from previous runs.
- Before finishing, store relevant observations (last processed item, patterns, recurring issues).
- Use \`memory.create_entities\` for new concepts and \`memory.add_observations\` for updates to known entities.`
```

### For regular sessions

When memory is enabled and no persona/job is set, the base system prompt (in `buildSystemPrompt()`) does not change. The memory server appears in the server listing like any other server:

```
- **memory** -- Persistent memory across sessions (knowledge graph)
```

The agent discovers it via `help.help('memory')` like any other server. No special prompting is needed -- the server's tool descriptions are self-explanatory.

## 8. Configuration

### User config schema addition

```typescript
// In userConfigSchema:
const memorySchema = z.object({
  enabled: z.boolean().optional(),  // default: true
}).optional();

// Added to userConfigSchema:
memory: memorySchema,
```

### Resolved config type

```typescript
export interface ResolvedMemoryConfig {
  readonly enabled: boolean;
}
```

### Defaults

```typescript
export const USER_CONFIG_DEFAULTS = {
  // ... existing ...
  memory: {
    enabled: true,
  },
} as const;
```

Memory is **enabled by default**. Rationale: memory is a core capability that makes agents significantly more useful. Users who want to disable it can set `"memory": { "enabled": false }` in their config. The memory server is lightweight (small Node process, JSONL file).

### Config editor

Add a "Memory" section to `config-command.ts` that lets users toggle memory on/off via the interactive config editor.

## 9. Policy Treatment

### Tool annotations

The memory server's tools need argument role annotations. Since the memory server is dynamically injected (not in `mcp-servers.json`), its annotations must be either:

**Option A: Hardcoded annotations** -- Since the memory server's tool surface is fixed and well-known, we can ship static annotations in code rather than running the LLM annotation pipeline. This is simpler and more reliable.

**Option B: Pipeline annotation** -- Add the memory server to the annotation pipeline. This requires the memory server to be connectable during pipeline runs.

**Recommendation: Option A (hardcoded).** The memory server's tools take entity names, observation strings, and query strings -- none of which are path or URL roles. All arguments are `none` role. This means:

- No structural invariants apply (no path containment, no domain checks)
- Policy falls through to compiled rules (allow/escalate based on constitution)
- Memory reads (search_nodes, open_nodes, read_graph) should be `allow`
- Memory writes (create_entities, add_observations, create_relations) should be `allow` (the agent needs to freely manage its own memory)
- Memory deletes (delete_entities, delete_observations, delete_relations) should be `allow` (the agent needs to clean up stale memories)

### Hardcoded annotation

```typescript
// In a new file or added to an existing annotations utility:
const MEMORY_SERVER_ANNOTATIONS: ToolAnnotation = {
  serverName: 'memory',
  sideEffects: {
    create_entities: true,
    create_relations: true,
    add_observations: true,
    delete_entities: true,
    delete_observations: true,
    delete_relations: true,
    read_graph: false,
    search_nodes: false,
    open_nodes: false,
  },
  tools: {
    create_entities: { args: { entities: 'none' } },
    create_relations: { args: { relations: 'none' } },
    add_observations: { args: { observations: 'none' } },
    delete_entities: { args: { entityNames: 'none' } },
    delete_observations: { args: { deletions: 'none' } },
    delete_relations: { args: { relations: 'none' } },
    read_graph: { args: {} },
    search_nodes: { args: { query: 'none' } },
    open_nodes: { args: { names: 'none' } },
  },
};
```

### Constitution guidance

Add a section to the base constitution:

```markdown
## Memory Server

The memory server stores persistent knowledge across sessions. All memory operations
(read, write, delete) are permitted. The agent manages its own memory namespace and
cannot access other users' or personas' memories (enforced by server configuration,
not policy rules).
```

### Compiled policy rules

The compiled policy should include rules that allow all memory server tools:

```json
{
  "name": "allow-memory-operations",
  "description": "All memory server operations are allowed",
  "conditions": { "server": "memory" },
  "then": "allow"
}
```

This is a blanket allow for the `memory` server. The namespace isolation is enforced structurally (each session gets a different `MEMORY_FILE_PATH`), not by policy rules.

## 10. Migration from `memory.md`

### Backward compatibility

The `memory.md` file approach continues to work for existing persona sessions. The migration is:

1. **Phase 1 (this design):** Add the memory MCP server. Update system prompt to reference it. Stop injecting `memory.md` contents into the system prompt. The `memory.md` file still exists in the workspace and is accessible via the filesystem server.

2. **Phase 2 (future):** Add a one-time migration that reads an existing `memory.md` file, converts its contents into knowledge graph entities via an LLM call, and populates the new `memory.jsonl`. This is not part of the initial implementation.

### System prompt transition

The `buildPersonaSystemPromptAugmentation()` function signature changes:

```typescript
// Before:
export function buildPersonaSystemPromptAugmentation(
  persona: PersonaDefinition,
  memoryPath: string,  // removed
): string;

// After:
export function buildPersonaSystemPromptAugmentation(
  persona: PersonaDefinition,
): string;
```

The call site in `buildSessionConfig()` simplifies -- no need to compute or pass `memoryPath`:

```typescript
// Before:
const personaAugmentation = buildPersonaSystemPromptAugmentation(
  resolved.persona,
  resolve(workspacePath, 'memory.md'),
);

// After:
const personaAugmentation = buildPersonaSystemPromptAugmentation(resolved.persona);
```

## 11. Docker Agent Mode

In Docker agent mode, the memory server runs on the **host** side (not inside the container). The MCP proxy already mediates all tool calls between the container and host-side MCP servers. The memory server is just another host-side server, configured with the appropriate `MEMORY_FILE_PATH`.

No special Docker handling is needed -- the existing MCP proxy infrastructure handles it.

## 12. Component Diagram

```
                    +-----------------+
                    |  Agent Session  |
                    +--------+--------+
                             |
                    buildSessionConfig()
                             |
              +--------------+--------------+
              |                             |
    mcpServers['filesystem']      mcpServers['memory']
              |                             |
              v                             v
    +------------------+        +------------------------+
    | MCP Filesystem   |        | @modelcontextprotocol/ |
    | Server           |        | server-memory          |
    | (sandbox dir)    |        | (MEMORY_FILE_PATH)     |
    +------------------+        +------------------------+
              |                             |
              v                             v
    ~/.ironcurtain/              ~/.ironcurtain/
    sessions/{id}/sandbox/       personas/{name}/memory.jsonl
                                       OR
                                 jobs/{jobId}/memory.jsonl
                                       OR
                                 memory/default.jsonl
```

## 13. Future Extensions

### Semantic search (v2)

Replace or augment the official memory server with embedding-based search:
- Compute embeddings for observations on write
- Store embeddings alongside the JSONL data (or in a separate index file)
- `search_nodes` queries against embeddings instead of substring matching
- Could use a local embedding model (e.g., via `@xenova/transformers`) to stay offline

### Memory summarization / compaction (v2)

As the knowledge graph grows, add periodic compaction:
- LLM-driven summarization of old observations into consolidated entities
- TTL-based expiry for observations tagged as ephemeral
- Size limits with automatic pruning of least-referenced entities

### Cross-namespace memory (v3)

Allow controlled sharing between namespaces:
- A "shared" namespace readable by all personas
- User-managed export/import between namespaces
- Policy-controlled: constitution can specify which namespaces may be read

### Memory analytics (v3)

Expose memory statistics:
- Entity count, relation count, observation count per namespace
- Most-referenced entities (identify what the agent finds important)
- Memory growth over time

### Custom memory tools (v3)

Wrap the official server with additional tools:
- `memory.remember_decision` -- structured tool for recording decisions with context
- `memory.recall_similar` -- semantic similarity search
- `memory.forget_before` -- bulk expiry by date
- `memory.summarize_entity` -- LLM-driven entity summary

## 14. Implementation Plan

### PR 1: Core infrastructure

1. Add `memory` config schema to `user-config.ts` (schema, defaults, resolved type)
2. Add `resolveMemoryFilePath()` to `src/config/paths.ts`
3. Add memory server injection to `buildSessionConfig()` in `src/session/index.ts`
4. Update `applyServerAllowlist()` to always include `"memory"` (like `"filesystem"`)
5. Add hardcoded tool annotations for memory server tools
6. Add memory section to constitution
7. Compile new policy rules that allow memory operations

### PR 2: System prompt migration

1. Update `buildPersonaSystemPromptAugmentation()` -- remove `memoryPath` parameter, replace file injection with memory server instructions
2. Update `buildCronSystemPromptAugmentation()` -- replace `workspace/memory.md` convention with memory server instructions
3. Update call sites in `buildSessionConfig()`
4. Keep `memory.md` files on disk (no deletion) for backward compatibility

### PR 3: Config editor

1. Add "Memory" section to `config-command.ts` interactive editor
2. Add memory toggle to first-start flow

### PR 4: Tests

1. Unit tests for `resolveMemoryFilePath()` namespace resolution
2. Unit tests for memory server injection in `buildSessionConfig()`
3. Integration test: spawn a session with memory enabled, verify the memory server is in the MCP server list
4. Policy engine test: verify memory tools are allowed
