# Persona System

## Overview

A persona is a named profile that bundles a constitution and compiled policy under a stable directory inside `~/.ironcurtain/personas/<name>/`. When a session is created with a persona, its `policyDir` points to the persona's `generated/` subdirectory, reusing the existing per-session policy override mechanism. Personas also support optional MCP server filtering -- each persona can declare which servers from the global `mcp-servers.json` are enabled or disabled, so an "exec-assistant" persona can operate with gmail and calendar servers while a "coder" persona operates with filesystem and github.

The design is deliberately thin: a persona is a named `policyDir` resolver plus an optional server filter. All compilation, loading, and enforcement infrastructure already exists.

## Motivation

Today IronCurtain has one global policy for interactive sessions and per-job policies for cron. Users who interact with IronCurtain across different contexts -- coding, email triage, research -- want different security postures without manually switching constitutions and recompiling. Cron jobs solve this for scheduled work, but interactive sessions (CLI, Signal, mux) have no equivalent. Personas fill this gap with minimal new machinery.

## Directory Layout

```
~/.ironcurtain/
  personas/
    exec-assistant/
      constitution.md          # persona-specific constitution text
      persona.json             # metadata + server filter config
      generated/
        compiled-policy.json   # output of persona compilation
        dynamic-lists.json     # optional, same as global pipeline
      workspace/               # persistent workspace across sessions
        memory.md              # agent-readable/writable memory file
    coder/
      constitution.md
      persona.json
      generated/
        compiled-policy.json
      workspace/
        memory.md
```

Personas live under `~/.ironcurtain/personas/`, which is already covered by the IronCurtain home directory's protected-path rule. The agent cannot modify persona configuration files (`constitution.md`, `persona.json`, `generated/`). However, `workspace/` (including `workspace/memory.md`) is writable by the agent — it is the persona's persistent state.

Tool annotations (`tool-annotations.json`) remain global -- they describe MCP tool schemas, not policy. Persona compilation reads annotations from the global generated directory, same as cron job compilation.

## Persona Definition

### persona.json

```jsonc
{
  "name": "exec-assistant",
  "description": "Email triage, calendar management, and document review",
  "createdAt": "2026-03-06T12:00:00.000Z",
  // Optional: only these MCP servers are available (allowlist)
  "servers": ["filesystem", "fetch", "gmail", "google-calendar"]
}
```

### PersonaDefinition type

```typescript
/**
 * Regex for valid persona names: 1-63 chars, lowercase alphanumeric,
 * hyphens, or underscores. Same rules as JobId.
 */
export const PERSONA_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** Branded persona name to prevent mixing with other string identifiers. */
export type PersonaName = string & { readonly __brand: 'PersonaName' };

export function createPersonaName(raw: string): PersonaName {
  if (!PERSONA_NAME_PATTERN.test(raw)) {
    throw new Error(
      `Invalid persona name "${raw}": must be 1-63 chars, ` +
        `lowercase alphanumeric, hyphens, or underscores, ` +
        `starting with a letter or digit`,
    );
  }
  return raw as PersonaName;
}

/**
 * Persisted persona definition. Stored as JSON at
 * ~/.ironcurtain/personas/{name}/persona.json.
 */
export interface PersonaDefinition {
  readonly name: PersonaName;
  readonly description: string;
  readonly createdAt: string;
  /**
   * Optional allowlist of MCP server names from the global
   * mcp-servers.json. When set, only these servers are available.
   * When omitted, all global servers are enabled (default).
   * The "filesystem" server is always included regardless.
   */
  readonly servers?: readonly string[];
}
```

### MCP Server Filtering

When a persona specifies a `servers` allowlist, the session factory filters the config's `mcpServers` map before spawning MCP server processes. The filtering happens in `buildSessionConfig()` after the existing deep-clone of `mcpServers`:

```typescript
function applyServerAllowlist(
  mcpServers: Record<string, MCPServerConfig>,
  allowlist: readonly string[],
): Record<string, MCPServerConfig> {
  const filtered: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(mcpServers)) {
    if (allowlist.includes(name) || name === 'filesystem') {
      filtered[name] = config;
    }
  }
  return filtered;
}
```

The `filesystem` server is always included even if omitted from the allowlist. This is a hardcoded safety invariant: the agent sandbox requires filesystem access to function, and the policy engine's structural invariants (protected paths, sandbox containment) depend on the filesystem server being present.

Only allowlists are supported — no denylists. This simplifies security reasoning: when a new server is added to the global config, it is not available to any persona unless explicitly opted in. Denylists would silently grant access to newly added servers.

Server filtering only affects which MCP servers are spawned. It does not affect tool annotations (which remain global) or the policy engine's structural invariants (which apply regardless).

## Persistent Workspace and Memory

### Persistent Workspace

Each persona gets a persistent `workspace/` directory at `~/.ironcurtain/personas/<name>/workspace/`. When a session is created with a persona, this workspace is passed as `workspacePath` to `createSession()`, replacing the ephemeral per-session sandbox. This means:

- Files the agent creates persist across Signal sessions
- The agent always starts in a familiar working directory
- Downloaded documents, drafts, and working files survive session boundaries

The `workspace/` directory is created during `ironcurtain persona create`. The existing `workspacePath` override in `buildSessionConfig()` already handles this — it replaces `sandboxDir` as `allowedDirectory` and patches the filesystem MCP server args.

```typescript
// In resolvePersona(), also return the workspace path:
export function resolvePersona(nameRaw: string): {
  policyDir: string;
  persona: PersonaDefinition;
  workspacePath: string;
} {
  // ...
  return {
    policyDir: generatedDir,
    persona: loadPersona(name),
    workspacePath: resolve(getPersonaDir(name), 'workspace'),
  };
}
```

In `buildSessionConfig()`, when a persona is resolved, its workspace is used automatically:

```typescript
if (opts.persona) {
  const resolved = resolvePersona(opts.persona);
  policyDir = resolved.policyDir;
  serverAllowlist = resolved.persona.servers;
  // Use persona workspace unless an explicit workspacePath was provided
  if (!opts.workspacePath) {
    opts.workspacePath = resolved.workspacePath;
  }
}
```

### Memory File

Each persona has a `memory.md` file at `~/.ironcurtain/personas/<name>/memory.md`, created empty during `ironcurtain persona create`. The agent is instructed to use it via `systemPromptAugmentation`:

```typescript
function buildPersonaSystemPromptAugmentation(persona: PersonaDefinition, memoryPath: string): string {
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
`;
}
```

The memory file lives at `workspace/memory.md`. The system prompt augmentation reads it at session start and includes its contents, and the agent can also read and write it directly via filesystem tools during the session. This is simple, requires no extra hooks, and matches the actual implementation.

### Security Considerations for Workspace and Memory

- The persona workspace is writable by the agent — this is intentional. The policy engine's structural invariants (protected paths) still apply: `~/.ironcurtain/personas/<name>/constitution.md`, `persona.json`, and `generated/` are outside the workspace and protected.
- The `workspace/` directory is the persona's `allowedDirectory`. Path containment checks prevent the agent from escaping to other personas' workspaces or the parent `personas/` directory.
- Memory content is included in the system prompt, so it counts against context window limits. Large memory files should be summarized periodically by the agent.

## CLI Commands

New subcommand group: `ironcurtain persona <action>`.

### `ironcurtain persona create <name>`

Creates a new persona with an interactive flow mirroring `ironcurtain cron create`:

1. Prompt for description (or accept via `--description`)
2. Prompt for server allowlist (multi-select from available servers in `mcp-servers.json`)
3. Offer to auto-generate a constitution from the description (same as cron job flow)
4. If accepted, present the generated constitution for review: accept / customize / discard
5. If customized or discarded, open the interactive LLM customizer loop
6. Compile the final constitution into policy
7. Create `workspace/` directory and empty `workspace/memory.md`

```
$ ironcurtain persona create exec-assistant
◆ Description: Email triage, calendar management, and document review
◆ Select MCP servers:
  ◻ filesystem (always included)
  ◼ gmail
  ◼ google-calendar
  ◻ github
◆ Generate a constitution automatically from the description? Yes
◐ Generating constitution...
┌ Generated Constitution
│ ...
└
◆ What would you like to do?
  ● Accept
  ○ Customize interactively
  ○ Discard and write manually
◐ Compiling policy...
✔ Persona "exec-assistant" created and compiled.
```

Options:
- `--description <text>` -- set the description (skip prompt)
- `--servers <s1,s2>` -- set the server allowlist (skip multi-select)
- `--no-generate` -- skip auto-generation, open `$EDITOR` directly

### `ironcurtain persona list`

Lists all personas with their description and compilation status.

```
$ ironcurtain persona list
  exec-assistant   Email triage and calendar       compiled
  coder            Software development            not compiled
```

### `ironcurtain persona compile <name>`

Compiles the persona's `constitution.md` into policy rules, writing output to the persona's `generated/` directory. Reuses `compileTaskPolicy()` (or a thin wrapper) since the compilation pipeline is identical -- the only difference is the input directory.

```
$ ironcurtain persona compile exec-assistant
Compiling policy for persona "exec-assistant"...
Done.
```

### `ironcurtain persona edit <name>`

Opens the persona's `constitution.md` in `$EDITOR`. After the editor exits, prompts to recompile if the file changed.

### `ironcurtain persona delete <name>`

Removes the persona directory after confirmation.

### `ironcurtain persona show <name>`

Prints the persona's metadata and constitution to stdout.

### CLI Registration

In `src/cli.ts`, add a `persona` case:

```typescript
case 'persona': {
  const { main } = await import('./persona/persona-command.js');
  await main(process.argv.slice(3));
  break;
}
```

## Session Integration

### Resolving a persona to a policyDir

The core integration is a single utility function:

```typescript
// src/persona/resolve.ts

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';
import { createPersonaName, type PersonaName, type PersonaDefinition } from './types.js';

export function getPersonaDir(name: PersonaName): string {
  return resolve(getIronCurtainHome(), 'personas', name);
}

export function getPersonaGeneratedDir(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'generated');
}

export function getPersonaConstitutionPath(name: PersonaName): string {
  return resolve(getPersonaDir(name), 'constitution.md');
}

/**
 * Loads a persona definition from disk.
 * Throws if the persona directory or persona.json does not exist.
 */
export function loadPersona(name: PersonaName): PersonaDefinition { ... }

/**
 * Resolves a persona name to a validated policyDir, workspace path,
 * and persona definition.
 *
 * @throws if persona does not exist or has no compiled policy
 */
export function resolvePersona(nameRaw: string): {
  policyDir: string;
  persona: PersonaDefinition;
  workspacePath: string;
} {
  const name = createPersonaName(nameRaw);
  const personaDir = getPersonaDir(name);
  const generatedDir = getPersonaGeneratedDir(name);

  if (!existsSync(resolve(generatedDir, 'compiled-policy.json'))) {
    throw new Error(
      `Persona "${name}" has no compiled policy. ` +
        `Run: ironcurtain persona compile ${name}`,
    );
  }

  return {
    policyDir: generatedDir,
    persona: loadPersona(name),
    workspacePath: resolve(personaDir, 'workspace'),
  };
}
```

### SessionOptions extension

Add an optional `persona` field to `SessionOptions`:

```typescript
export interface SessionOptions {
  // ... existing fields ...

  /**
   * Persona name. When set, resolves to a policyDir and optional
   * server filter. Mutually exclusive with policyDir -- if both
   * are provided, persona takes precedence with a warning.
   */
  persona?: string;
}
```

In `buildSessionConfig()`, resolve the persona early:

```typescript
function buildSessionConfig(config, effectiveSessionId, sessionId, opts) {
  let { policyDir, workspacePath, systemPromptAugmentation } = opts;
  let serverAllowlist: readonly string[] | undefined;

  if (opts.persona) {
    const resolved = resolvePersona(opts.persona);
    if (policyDir) {
      logger.warn('Both persona and policyDir specified; using persona.');
    }
    policyDir = resolved.policyDir;
    serverAllowlist = resolved.persona.servers;

    // Use persona workspace unless an explicit workspacePath was provided
    if (!workspacePath) {
      workspacePath = resolved.workspacePath;
    }

    // Build persona system prompt augmentation (includes memory contents)
    const personaAugmentation = buildPersonaSystemPromptAugmentation(
      resolved.persona,
      resolve(resolved.workspacePath, 'memory.md'),
    );
    systemPromptAugmentation = systemPromptAugmentation
      ? `${personaAugmentation}\n\n${systemPromptAugmentation}`
      : personaAugmentation;
  }

  if (policyDir) validatePolicyDir(policyDir);

  // ... existing setup (uses workspacePath and systemPromptAugmentation) ...

  // Apply server allowlist if persona specifies one
  if (serverAllowlist) {
    sessionConfig.mcpServers = applyServerAllowlist(sessionConfig.mcpServers, serverAllowlist);
  }

  // ... rest of existing code ...
}
```

This is the only integration point in the session layer. All downstream code (policy loading, proxy spawning, MCP client connections) sees the filtered `mcpServers` map, the persona's workspace, and the memory-augmented system prompt transparently.

### CLI: `ironcurtain start --persona <name>`

Add a `--persona` option to `parseArgs` in `src/index.ts`:

```typescript
persona: { type: 'string', short: 'p' },
```

Pass it through to `createSession()`:

```typescript
const session = await createSession({
  config,
  mode,
  persona: values.persona as string | undefined,
  // ... existing options ...
});
```

### Signal: `/new <persona>`

Extend the `/new` command in `SignalBotDaemon.handleControlCommand()` to accept an optional persona argument:

```typescript
// Current: /new
// New:     /new [persona-name]
const newMatch = lower.match(/^\/new(?:\s+(\S+))?$/);
if (newMatch) {
  const personaName = newMatch[1]; // undefined if bare /new
  this.scheduleSessionOp(async () => {
    try {
      await this.startNewSession(personaName);
    } catch (err: unknown) { ... }
  });
  return true;
}
```

In `startNewSession()`, pass `persona` through to `createSession()`:

```typescript
private async startNewSession(persona?: string): Promise<number> {
  // ... existing concurrency check ...
  const session = await createSession({
    config,
    mode: this.mode,
    persona,
    // ... existing callbacks ...
  });
  // ... existing registration ...
}
```

Update the `/help` output to show: `/new [persona] - start a new session (optionally with a persona)`.

### Mux: deferred

Mux persona support is deferred to a follow-up PR. The mux uses a picker-mode state machine for session creation, requiring changes to `MuxInputHandler`, `MuxAction`, `PtyBridgeOptions`, and `createPtyBridge()`. Once `--persona` works on the CLI, the mux integration is straightforward but not blocking for the initial release.

### Cron: `persona` field in JobDefinition

Add an optional `persona` field to `JobDefinition`:

```typescript
export interface JobDefinition {
  // ... existing fields ...

  /**
   * Optional persona name. When set, the job uses this persona's
   * compiled policy instead of its inline taskConstitution.
   * Mutually exclusive with taskConstitution -- if persona is set,
   * taskConstitution is ignored for policy loading (but still used
   * as the system prompt augmentation if present).
   */
  readonly persona?: string;
}
```

When the daemon creates a cron session and `job.persona` is set, it resolves the persona and passes `persona` in `SessionOptions` instead of `policyDir: jobGeneratedDir`. This lets cron jobs share a persona's policy without maintaining a separate constitution.

The `taskConstitution` field remains the primary path for cron jobs. The `persona` field is a convenience for jobs that want to reuse an existing persona rather than defining their own policy inline.

## Constitution Authoring

Persona constitution authoring reuses the existing cron job infrastructure with minimal adaptation.

### Shared Components

The cron job flow already provides three reusable building blocks:

1. **`constitution-generator.ts`** — `generateConstitution()` runs an LLM under read-only policy to explore MCP servers and produce a draft constitution from a description. The generator currently has cron-specific framing baked into its system prompt (e.g., "this is an unattended cron job", "escalation effectively means block"). For personas (which are interactive sessions with a human present), escalation is meaningful.

   **Required refactor**: `buildConstitutionGeneratorSystemPrompt()` must accept a `generationContext` parameter that controls the framing:
   - `'cron'`: current behavior — unattended, escalation ≈ block, auto-allow task operations
   - `'persona'`: interactive session — escalation is valid for risky operations, human is present to approve

   The structural rules section (workspace auto-allow, default-deny) and the output format are shared. Only the "Critical Context" paragraph and the escalation guidance differ. `ConstitutionGeneratorOptions` gains an optional `context?: 'cron' | 'persona'` field (defaults to `'cron'` for backward compatibility). The persona context also makes workspace exploration optional since there may be no meaningful workspace at persona creation time.

2. **`constitution-customizer.ts`** (pipeline) — Shared utilities (`buildSystemPrompt`, `buildUserMessage`, `callLlm`, `applyChanges`, `computeLineDiff`, `formatDiff`) for the interactive LLM refinement loop. Already operates on in-memory strings.

3. **`job-customizer.ts`** (cron) — `runJobConstitutionCustomizer()` wraps the shared customizer with task-specific context in the system prompt. A persona equivalent (`runPersonaConstitutionCustomizer()`) follows the same pattern, replacing "task context" with "persona context" (description, server allowlist).

### Persona-Specific Adapter

```typescript
// src/persona/persona-customizer.ts

export function buildPersonaCustomizerSystemPrompt(
  baseConstitution: string,
  toolAnnotations: ToolAnnotation[],
  personaDescription: string,
  serverAllowlist?: readonly string[],
  githubIdentity?: GitHubIdentity | null,
): string {
  const basePrompt = buildSystemPrompt(baseConstitution, toolAnnotations, githubIdentity);

  const serverContext = serverAllowlist
    ? `\nThis persona only has access to these MCP servers: ${serverAllowlist.join(', ')}.`
    : '';

  return `${basePrompt}

## Persona Context

This constitution is for a persona with the following purpose:

${personaDescription}
${serverContext}

Focus your suggestions on what this persona needs. Grant the minimum
permissions required for the persona's purpose.`;
}

export async function runPersonaConstitutionCustomizer(
  initialConstitution: string,
  personaDescription: string,
  serverAllowlist?: readonly string[],
): Promise<string | undefined> {
  // Same structure as runJobConstitutionCustomizer, different system prompt
}
```

### Create Flow

The `persona create` command orchestrates these components in the same sequence as `job-commands.ts`:

```typescript
// In persona-command.ts, create subcommand:

// 1. Prompt for description and servers
// 2. Offer auto-generation
if (shouldGenerate) {
  const result = await generateConstitution({
    taskDescription: description,
    workspacePath: tempWorkspace,
    context: 'persona',  // interactive framing, escalation is meaningful
  });
  // 3. Present result: accept / customize / discard
  if (action === 'accept') {
    constitution = result.constitution;
  } else if (action === 'customize') {
    constitution = await runPersonaConstitutionCustomizer(
      result.constitution, description, servers,
    );
  }
}
// 4. Fallback: open $EDITOR
if (!constitution) {
  constitution = await openInEditor(constitutionPath);
}
// 5. Write constitution.md and compile
```

### Edit Flow

`ironcurtain persona edit <name>` also offers the customizer after editor exit:

```
$ ironcurtain persona edit exec-assistant
Opening constitution in editor...
◆ Constitution changed. What next?
  ● Compile now
  ○ Customize interactively first
  ○ Done (skip compilation)
```

## Policy Compilation

### compilePersonaPolicy()

A thin wrapper around `PipelineRunner`, similar to `compileTaskPolicy()`:

```typescript
// src/persona/compile-persona-policy.ts

import { resolve } from 'node:path';
import { PipelineRunner, createPipelineModels } from '../pipeline/pipeline-runner.js';
import { loadConfig } from '../config/index.js';
import { getUserGeneratedDir } from '../config/paths.js';
import { getPackageGeneratedDir } from '../config/index.js';
import { getPersonaConstitutionPath, getPersonaGeneratedDir } from './resolve.js';
import type { PersonaName } from './types.js';
import type { CompiledPolicyFile } from '../pipeline/types.js';

export async function compilePersonaPolicy(name: PersonaName): Promise<CompiledPolicyFile> {
  const config = loadConfig();
  const outputDir = getPersonaGeneratedDir(name);
  const constitutionPath = getPersonaConstitutionPath(name);
  const constitutionText = readFileSync(constitutionPath, 'utf-8');
  const annotationsDir = getUserGeneratedDir();
  const models = await createPipelineModels(outputDir);
  const runner = new PipelineRunner(models);

  return runner.run({
    constitutionInput: constitutionText,
    constitutionKind: 'constitution',
    outputDir,
    toolAnnotationsDir: annotationsDir,
    toolAnnotationsFallbackDir: getPackageGeneratedDir(),
    allowedDirectory: config.allowedDirectory,
    protectedPaths: config.protectedPaths,
    mcpServers: config.mcpServers,
    includeHandwrittenScenarios: false,
  });
}
```

The `constitutionInput` receives the file contents (not the path) — `PipelineRunner.run()` expects the constitution as text. The `constitutionKind` is `'constitution'` since persona constitutions are written as broad principles (like the global constitution), not as English task descriptions (`'task-policy'`). This means the compiler uses the full constitution prompt variant, which is the right fit for persona-level policy.

**Note on `allowedDirectory`:** Persona compilation uses the global default `allowedDirectory` from `loadConfig()`. At runtime, the session factory overrides this with the session-specific sandbox. Compiled path rules use the sandbox placeholder pattern, so the compiled policy works with any session sandbox.

### Server-scoped compilation

When a persona has a `servers` filter, only the filtered set of servers should be considered during policy compilation. The `PipelineRunner.run()` call receives `mcpServers`, which is used for structural invariant generation and domain allowlist extraction. Apply the server filter before passing:

```typescript
let mcpServers = config.mcpServers;
const persona = loadPersona(name);
if (persona.servers) {
  mcpServers = applyServerAllowlist(mcpServers, persona.servers);
}

return runner.run({
  // ...
  mcpServers,
});
```

This ensures the compiled policy only references tools from servers the persona will actually use, and the LLM does not generate rules for irrelevant tools.

## File Organization

```
src/persona/
  types.ts                    # PersonaName, PersonaDefinition, PERSONA_NAME_PATTERN
  resolve.ts                  # getPersonaDir, resolvePersona, loadPersona, applyServerAllowlist
  compile-persona-policy.ts   # compilePersonaPolicy wrapper
  persona-customizer.ts       # LLM-assisted constitution customizer (adapts job-customizer)
  persona-prompt.ts           # buildPersonaSystemPromptAugmentation (memory injection)
  persona-command.ts          # CLI entry point for `ironcurtain persona` subcommands
```

## Component Relationships

```
CLI (src/cli.ts)
  └─ persona-command.ts ──> resolve.ts, compile-persona-policy.ts, persona-customizer.ts

Constitution authoring (reused from cron)
  ├─ constitution-generator.ts  (src/cron/) ──> generateConstitution()
  ├─ constitution-customizer.ts (src/pipeline/) ──> shared LLM refinement utilities
  └─ persona-customizer.ts (src/persona/) ──> persona-specific system prompt adapter

Session factory (src/session/index.ts)
  └─ buildSessionConfig()
       ├─ resolvePersona()  ──> resolve.ts (policyDir + server allowlist)
       ├─ validatePolicyDir()  (existing)
       ├─ applyServerAllowlist()  ──> resolve.ts
       └─ loadGeneratedPolicy()  (existing, uses policyDir)

Signal (src/signal/signal-bot-daemon.ts)
  └─ startNewSession(persona?) ──> createSession({ persona })

Mux (src/mux/mux-app.ts)
  └─ (deferred — will thread --persona through picker UI in follow-up)

Daemon (src/daemon/ironcurtain-daemon.ts)
  └─ onJobTrigger(job)
       └─ if job.persona: createSession({ persona: job.persona })
          else: createSession({ policyDir: jobGeneratedDir })

Pipeline (src/persona/compile-persona-policy.ts)
  └─ PipelineRunner.run()  (existing pipeline infrastructure)
```

## Security Considerations

### Persona name validation

Persona names use the same validation pattern as job IDs (`PERSONA_NAME_PATTERN`): lowercase alphanumeric, hyphens, underscores, 1-63 characters. This prevents path traversal (no `/`, `..`, or special characters) and ensures the persona directory stays under `~/.ironcurtain/personas/`.

### Directory containment

`resolvePersona()` validates that the resolved persona directory is under `~/.ironcurtain/personas/`. The existing `validatePolicyDir()` in `buildSessionConfig()` provides a second layer of defense: it verifies the `policyDir` is under the IronCurtain home directory.

### Compiled policy required

`resolvePersona()` refuses to return a `policyDir` for a persona that has no `compiled-policy.json`. This prevents sessions from falling through to the global policy when the user intended a persona-specific policy. The error message tells the user exactly what command to run.

### Server filter safety

The `filesystem` server is never filtered out (hardcoded exception in `applyServerAllowlist`). If a persona's allowlist omits `filesystem`, it is silently added back. This preserves the sandbox invariant.

Server names in the allowlist are validated against the keys in `mcp-servers.json` at session creation time. Unknown server names produce a warning (not an error) to avoid breaking personas when servers are added or removed from the global config.

Only allowlists are supported. This ensures new servers added to the global config are never silently available to existing personas — each persona must explicitly opt in.

### Protected paths

Persona directories are already covered by the `~/.ironcurtain/` protected path. The agent cannot read or write persona constitutions or compiled policies.

### No privilege escalation

A persona's compiled policy is still evaluated by the same PolicyEngine with the same structural invariants (protected paths, unknown tool denial, SSRF blocking). A persona cannot grant permissions that structural invariants deny. The most a persona can do is relax the *compiled* rules (e.g., allow writes to broader paths), but structural invariants remain the floor.

## Testing Strategy

### Unit tests

- **resolve.ts**: Test `createPersonaName()` validation (rejects traversal attempts, accepts valid names), `resolvePersona()` error on missing directory, error on uncompiled persona, success with valid persona.
- **applyServerAllowlist()**: Test allowlist filtering, filesystem-always-included invariant, empty allowlist, unknown server names warning.
- **buildSessionConfig() with persona**: Test that persona's policyDir overrides global, server filter is applied, persona + policyDir conflict produces warning.

### Integration tests

- Create a persona, compile it, start a session with `--persona`, verify the session uses the persona's policy (tool calls are evaluated against persona rules, not global rules).
- Signal `/new exec-assistant` creates a session with the exec-assistant persona's policy.

All tests use the existing `SandboxFactory` mock pattern from `SessionOptions` -- no new test infrastructure needed.

## Migration Plan

### PR 1: Types and resolver

- Add `src/persona/types.ts` and `src/persona/resolve.ts`
- Add `getPersonaDir`, `getPersonaGeneratedDir` to `src/config/paths.ts`
- Unit tests for name validation and resolution

### PR 2: CLI commands and constitution authoring

- Add `src/persona/persona-command.ts` with create, list, compile, edit, delete, show
- Add `src/persona/persona-customizer.ts` adapting `job-customizer.ts` for persona context
- Add `src/persona/compile-persona-policy.ts`
- Wire `generateConstitution()` (from `src/cron/constitution-generator.ts`) into the create flow
- Register in `src/cli.ts`

### PR 3: Session integration

- Add `persona` field to `SessionOptions`
- Wire `resolvePersona()` + `applyServerFilter()` into `buildSessionConfig()`
- Add `--persona` flag to `ironcurtain start`
- Update Signal `/new` and cron `JobDefinition`
- Mux persona support deferred to follow-up PR

### PR 4: Documentation and polish

- User-facing docs, help text, examples
- Update `CLAUDE.md` with persona onboarding steps

## Future Extensions

- **Mux persona support**: Thread `--persona` through the mux picker-mode state machine (`MuxInputHandler`, `MuxAction`, `PtyBridgeOptions`, `createPtyBridge()`). Once CLI `--persona` works, this is a UI plumbing task.
- **Persona inheritance**: A persona could extend another persona's constitution, adding or overriding specific rules. Not needed now -- constitutions are small enough to copy.
- **Per-persona model override**: A persona could specify a different `agentModelId` (e.g., a cheaper model for routine tasks). This would be a field in `persona.json` that patches the session config.
- **Persona sharing**: Export/import personas as tarballs or from a central registry. The directory structure is self-contained, making this straightforward.
- **Auto-compile on constitution change**: Watch `constitution.md` for changes and trigger recompilation. The content-hash caching in the pipeline makes this cheap when nothing changed.
- **Default persona**: A `defaultPersona` field in `config.json` that applies when no persona is specified, replacing the global policy as the baseline.
- **Per-persona resource budgets**: Override `resourceBudget` fields per persona for cost control across different use cases.
