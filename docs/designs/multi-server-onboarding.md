# TB1a: Git Server Integration & Role Extensibility

**Status:** Proposed
**Date:** 2026-02-19
**Author:** IronCurtain Engineering
**Depends on:** TB0 (Execution Containment) -- complete

## 1. Executive Summary

IronCurtain currently operates with a single MCP server (filesystem). TB1a adds a git server as the first Tier 1 (semantic inspection) expansion, and builds the extensibility framework for future servers. The core challenges are: (a) extending the `ArgumentRole` type system with a `category` discriminator to handle non-path resource identifiers like URLs, (b) extending the policy engine's structural invariants to enforce domain allowlists alongside path containment, (c) resolving named git remotes to URLs for domain policy enforcement, and (d) supporting user constitution customization via a separate file.

TB1b (separate design doc) covers the fetch server, user credential configuration, and the LLM-assisted constitution customizer CLI.

## 2. Git MCP Server: Research & Spike Validation

### 2.1 Server Selection

**Chosen:** `@cyanheads/git-mcp-server` v2.8.4 (Apache 2.0, TypeScript/Node.js).

Validated via spike test (`test/git-mcp-spike.ts`). Key findings:

- **28 tools** covering the full git surface: init, clone, status, add, commit, diff, log, show, blame, branch, checkout, merge, rebase, cherry-pick, remote, fetch, pull, push, tag, stash, reset, worktree, plus workflow helpers.
- **Entry point:** `node node_modules/.bin/git-mcp-server` with `MCP_TRANSPORT_TYPE=stdio` required as env var.
- **Repository path argument is `path`** (not `repo_path`), used on every tool, defaulting to `"."`.
- **`remote` is always a named remote** (e.g., `"origin"`), never a URL. Only `git_clone` has a `url` argument.
- **Structured JSON responses** (e.g., `git_status` returns `{ currentBranch, stagedChanges, untrackedFiles, ... }`).

**Rejected alternative:** Official `mcp-server-git` (Python, missing push/pull/fetch/remote tools).

### 2.2 Stateful Session Behavior

The server has `git_set_working_dir` / `git_clear_working_dir` tools that set server-side session state. Without calling `git_set_working_dir` or passing explicit `path`, tools fail.

**Decision:** The agent always passes `path` explicitly on each tool call. This ensures the policy engine sees the path for containment evaluation and keeps the proxy server-agnostic. The `git_set_working_dir` tool remains available but is not required.

**Session isolation:** Each `AgentSession` creates its own `Sandbox` → Code Mode client → MCP proxy → MCP server instances. MCP servers are per-session with no sharing, so the git server's internal session state is naturally scoped to one agent.

### 2.3 Workflow Tools

Two tools (`git_wrapup_instructions`, `git_changelog_analyze`) are AI workflow helpers, not standard git operations. The annotation pipeline will classify them naturally; no special handling needed.

### 2.4 Credential Requirements

- **SSH key auth:** Agent needs read access to `~/.ssh/`. The sandbox `denyRead` must not block it.
- **HTTPS token auth:** Injected via `GH_TOKEN` or similar env vars in the server config.
- **Recommendation:** SSH key auth for push operations (keys already on disk). Token-based auth deferred to TB1b's user credential configuration.

## 3. Argument Role Extensibility Design

### 3.1 Role Categories

Roles are organized into categories. A category determines which structural invariant applies in the policy engine. Adding a new category requires adding a corresponding validator.

```typescript
// src/types/argument-roles.ts

export type RoleCategory = 'path' | 'url' | 'opaque';

export type ArgumentRole =
  // Path roles (existing)
  | 'read-path'
  | 'write-path'
  | 'delete-path'
  // URL roles (new)
  | 'fetch-url'
  | 'git-remote-url'
  // Opaque roles (new -- semantic meaning but not resource identifiers)
  | 'branch-name'
  | 'commit-message'
  // Catch-all
  | 'none';
```

### 3.2 Extended RoleDefinition

```typescript
export interface RoleDefinition {
  readonly description: string;
  readonly isResourceIdentifier: boolean;
  readonly category: RoleCategory;
  readonly normalize: (value: string) => string;
  /** Extract the policy-relevant value (e.g., domain from URL). */
  readonly prepareForPolicy?: (value: string) => string;
  /**
   * Context-aware resolution for values that need sibling arguments.
   * E.g., resolving named git remote "origin" to its URL using the
   * `path` argument from the same tool call.
   */
  readonly resolveForPolicy?: (
    value: string,
    allArgs: Record<string, unknown>,
  ) => string;
  /**
   * Guidance for the LLM annotation prompt. Built into the prompt
   * dynamically from the registry -- no manual prompt maintenance.
   */
  readonly annotationGuidance: string;
}
```

### 3.3 New Registry Entries

```typescript
['fetch-url', {
  description: 'URL that will be fetched via HTTP(S)',
  isResourceIdentifier: true,
  category: 'url',
  normalize: normalizeUrl,
  prepareForPolicy: extractDomain,
  annotationGuidance:
    'Assign to arguments that are HTTP(S) URLs the tool will fetch. ' +
    'Typically applies to web-fetch server tools.',
}],

['git-remote-url', {
  description: 'Git remote URL or named remote for network operations',
  isResourceIdentifier: true,
  category: 'url',
  normalize: normalizeGitUrl,
  prepareForPolicy: extractGitDomain,
  resolveForPolicy: resolveGitRemote,
  annotationGuidance:
    'Assign to arguments that identify a git remote (URL or named remote like "origin"). ' +
    'Typically applies to git server tools like git_clone, git_push, git_pull, git_fetch, git_remote.',
}],

['branch-name', {
  description: 'Git branch name',
  isResourceIdentifier: false,
  category: 'opaque',
  normalize: identity,
  annotationGuidance:
    'Assign to arguments that are git branch names. ' +
    'Typically applies to git server tools like git_branch, git_checkout, git_merge, git_push.',
}],

['commit-message', {
  description: 'Git commit message text',
  isResourceIdentifier: false,
  category: 'opaque',
  normalize: identity,
  annotationGuidance:
    'Assign to arguments that are git commit messages. ' +
    'Typically applies to git_commit.',
}],
```

### 3.4 URL Normalization and Domain Extraction

```typescript
export function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.pathname === '/') url.pathname = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

export function extractDomain(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
}

export function normalizeGitUrl(value: string): string {
  // SSH format: git@host:path
  const sshMatch = value.match(/^(?:\w+@)?([^:]+):/);
  if (sshMatch && !value.includes('://')) return value;
  return normalizeUrl(value);
}

export function extractGitDomain(value: string): string {
  // SSH format: git@host:path
  const sshMatch = value.match(/^(?:\w+@)?([^:]+):/);
  if (sshMatch && !value.includes('://')) return sshMatch[1];
  return extractDomain(value);
}
```

### 3.5 Named Remote Resolution

The `remote` argument on `git_push`/`git_pull`/`git_fetch` is always a named remote (e.g., `"origin"`), never a URL. To enforce domain policy, we must resolve it to the actual URL.

```typescript
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Resolves a git remote value to a URL for policy evaluation.
 *
 * If the value is already a URL (contains :// or matches SSH pattern),
 * returns it as-is. Otherwise, treats it as a named remote and runs
 * `git remote get-url <name>` in the repository directory (found via
 * the `path` sibling argument).
 *
 * The policy engine runs in the trusted process (not sandboxed), so
 * it has full filesystem access for resolution -- same pattern as
 * realpathSync() for path resolution.
 *
 * Uses execFileSync (not execSync) to avoid command injection --
 * the value comes from agent-controlled tool call arguments.
 *
 * When resolution fails (repo doesn't exist, remote not found, git
 * not installed), returns the original value. This causes the domain
 * check to escalate (the value won't match any allowed domain),
 * which is the correct behavior -- escalate when we can't verify.
 */
export function resolveGitRemote(
  value: string,
  allArgs: Record<string, unknown>,
): string {
  // Already a URL -- return as-is
  if (value.includes('://') || /^[\w.+-]+@[^:]+:/.test(value)) {
    return value;
  }

  // Named remote -- resolve via git (no shell, no injection risk)
  const rawPath = typeof allArgs.path === 'string' ? allArgs.path : '.';
  const repoPath = resolve(rawPath); // Resolve relative paths before use as cwd
  try {
    return execFileSync('git', ['remote', 'get-url', value], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return value; // Resolution failed -- escalation will catch it
  }
}
```

The policy engine calls `resolveForPolicy` (when defined) before `prepareForPolicy`, giving it the fully resolved URL to extract the domain from.

**Integration point:** Resolution happens inside the policy engine only (the untrusted domain gate and compiled rule evaluation domain condition evaluation), not in `prepareToolArgs()`. This keeps `prepareToolArgs()` unchanged (it only handles path normalization) and co-locates resolution with the domain validation logic that needs it.

### 3.6 Annotation Pipeline Integration

The tool annotator prompt is dynamically built from the registry:

```typescript
function buildRoleDescriptions(): string {
  const lines: string[] = [];
  for (const [role, def] of ARGUMENT_ROLE_REGISTRY) {
    lines.push(`   - "${role}" -- ${def.description}. ${def.annotationGuidance}`);
  }
  return lines.join('\n');
}
```

Adding a new role to the registry automatically teaches the LLM annotator about it. No manual prompt maintenance.

### 3.7 Extended Accessors

```typescript
export function getRolesByCategory(category: RoleCategory): ArgumentRole[] {
  const roles: ArgumentRole[] = [];
  for (const [role, def] of ARGUMENT_ROLE_REGISTRY) {
    if (def.category === category) roles.push(role);
  }
  return roles;
}

/** Returns path-category roles only. Used by the protected path check and filesystem sandbox containment structural invariants. */
export function getPathRoles(): ArgumentRole[] {
  return getRolesByCategory('path');
}

export function getUrlRoles(): ArgumentRole[] {
  return getRolesByCategory('url');
}
```

**Critical: `getResourceRoles()` must NOT be used for the protected path check or filesystem sandbox containment.** Today `getResourceRoles()` returns all roles with `isResourceIdentifier: true`. Adding URL roles as resource identifiers would cause the protected path check and filesystem sandbox containment to feed URLs into `resolveRealPath()` and `isWithinDirectory()` — producing nonsensical results. The policy engine must switch to `getPathRoles()` (category-aware) for path containment checks and use `getUrlRoles()` for domain checks. `getResourceRoles()` remains available for contexts that genuinely need all resource identifiers regardless of category.

## 4. Policy Engine Extensions

### 4.1 Untrusted Domain Gate

Structural checks are extended with a URL domain check:

```
Structural Checks
  Protected path check (deny -- unchanged)
  Filesystem sandbox containment for path-category roles (allow/partial -- unchanged)
  Untrusted domain gate for url-category roles (escalate -- NEW)
  Unknown tool denial (deny -- unchanged)
```

**Domain violations escalate, not deny.** A URL targeting an unknown domain is not inherently destructive -- the user might legitimately want to push to a new remote. Escalation lets the human decide.

**Two-layer separation:** The srt sandbox `allowedDomains` controls what the process *can* reach at the OS level (containment backstop). The policy engine's domain check controls what the agent *may* do (semantic authority). The constitution is the source of policy authority; the srt allowlist is a defense-in-depth measure. For TB1a, the git server's srt config hardcodes `["github.com", "*.github.com", "gitlab.com", "*.gitlab.com"]` -- broad enough to avoid the "policy allows but srt blocks" mismatch for common remotes.

### 4.2 Resolution Pipeline

For URL-category arguments, the policy engine applies a three-step pipeline:

```
1. resolveForPolicy(value, allArgs)  -- resolve named remote → URL
2. normalize(resolvedValue)          -- canonicalize URL format
3. prepareForPolicy(normalizedValue) -- extract domain for allowlist check
```

```typescript
function resolveUrlForDomainCheck(
  value: string,
  roleDef: RoleDefinition,
  allArgs: Record<string, unknown>,
): string {
  const resolved = roleDef.resolveForPolicy?.(value, allArgs) ?? value;
  const normalized = roleDef.normalize(resolved);
  return roleDef.prepareForPolicy?.(normalized) ?? normalized;
}
```

### 4.3 PolicyEngine Constructor Extension

```typescript
export class PolicyEngine {
  private serverDomainAllowlists: ReadonlyMap<string, readonly string[]>;

  constructor(
    compiledPolicy: CompiledPolicyFile,
    toolAnnotations: ToolAnnotationsFile,
    protectedPaths: string[],
    allowedDirectory?: string,
    serverDomainAllowlists?: ReadonlyMap<string, readonly string[]>,
  ) {
    // ... existing initialization ...
    this.serverDomainAllowlists = serverDomainAllowlists ?? new Map();
  }
}
```

Domain allowlists are derived from `mcp-servers.json` sandbox network configuration. If a server has no allowlist, URL arguments are not structurally restricted (fall through to compiled rule evaluation).

### 4.4 Domain Matching

```typescript
function domainMatchesAllowlist(
  domain: string,
  allowedDomains: readonly string[],
): boolean {
  return allowedDomains.some(pattern => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) {
      const suffix = pattern.slice(1); // ".github.com"
      return domain === pattern.slice(2) || domain.endsWith(suffix);
    }
    return domain === pattern;
  });
}
```

### 4.5 Compiled Rule Condition Extension

```typescript
// src/pipeline/types.ts
export interface DomainCondition {
  roles: ArgumentRole[];
  allowed: string[];
}

export interface CompiledRuleCondition {
  roles?: ArgumentRole[];
  server?: string[];
  tool?: string[];
  sideEffects?: boolean;
  paths?: PathCondition;
  domains?: DomainCondition;  // NEW
}
```

The constitution compiler prompt is updated to document the new `domains` condition. The compiler response schema is extended accordingly.

### 4.6 Extended Evaluation Diagram

```
Tool Call Request (e.g., git_push with remote="origin", path="/sandbox/repo")
  |
  v
Structural Checks
  |-- Protected path check on path="/sandbox/repo" → not protected, continue
  |-- Filesystem sandbox containment on path="/sandbox/repo" → within sandbox, resolve read-path
  |-- Untrusted domain gate on remote="origin":
  |       resolveForPolicy("origin", {path: "/sandbox/repo"})
  |         → git remote get-url origin → "git@github.com:user/repo.git"
  |       extractGitDomain("git@github.com:user/repo.git") → "github.com"
  |       domainMatchesAllowlist("github.com", ["github.com", "*.github.com"]) → pass
  |-- Unknown tool denial → tool known, continue
  |
  v
Compiled Rule Evaluation
  |-- Match "escalate git_push" rule → escalate
```

## 5. User Constitution Support

### 5.1 Separate User Constitution File

User policy customizations live in a separate file that won't be overwritten by base updates:

```
src/config/constitution.md          -- base (version-controlled)
~/.ironcurtain/constitution-user.md -- user additions (per-installation)
```

The pipeline loads both and concatenates them (base first, user second). User guidance in the "Concrete Guidance" section supersedes base principles, matching the existing convention.

```markdown
<!-- ~/.ironcurtain/constitution-user.md -->
## User-Specific Guidance

- The agent must receive human approval before any git push operation.
- The agent may read git log and status without approval.
```

### 5.2 Pipeline Integration

```typescript
// src/pipeline/compile.ts
function loadConstitution(): string {
  const base = readFileSync(constitutionPath, 'utf-8');
  const userPath = getUserConstitutionPath();
  if (existsSync(userPath)) {
    const user = readFileSync(userPath, 'utf-8');
    return `${base}\n\n${user}`;
  }
  return base;
}
```

The combined constitution is hashed for cache invalidation. Changes to either file trigger recompilation.

## 6. Git Server Configuration

### 6.1 Server Config

```jsonc
// src/config/mcp-servers.json
"git": {
  "command": "node",
  "args": ["node_modules/.bin/git-mcp-server"],
  "env": {
    "MCP_TRANSPORT_TYPE": "stdio"
  },
  "sandbox": {
    "filesystem": {
      "denyRead": []   // Need ~/.ssh for auth, .gitconfig for identity
    },
    "network": {
      "allowedDomains": ["github.com", "*.github.com", "gitlab.com", "*.gitlab.com"]
    }
  }
}
```

### 6.2 Constitution Updates

```markdown
## Concrete Guidance which supersedes the guiding principles
 ...existing filesystem rules...
 - The agent may perform read-only git operations (status, diff, log, show, blame) within the sandbox without approval.
 - The agent may stage files (git add) and commit within the sandbox without approval.
 - The agent must receive human approval before git push, git pull, git fetch, or any remote-contacting operation.
 - The agent must receive human approval before git reset, git rebase, git merge, or any history-rewriting operation.
 - The agent must receive human approval before git branch deletion or force operations.
```

### 6.3 Handwritten Scenarios

New scenarios in `src/pipeline/handwritten-scenarios.ts`:

```typescript
// Git read operations in sandbox → allow
'Git status in sandbox'
'Git log in sandbox'
'Git diff in sandbox'

// Git write operations in sandbox → allow
'Git add in sandbox'
'Git commit in sandbox'

// Git remote/destructive operations → escalate
'Git push from sandbox'
'Git pull to sandbox'
'Git reset in sandbox'
'Git merge in sandbox'
'Git branch delete in sandbox'

// Unknown tool → deny
'Unknown git tool'
```

## 7. Developer Onboarding Workflow

Step-by-step for adding a new MCP server to the codebase:

```
[ ] 1. Add server to mcp-servers.json (with sandbox config)
[ ] 2. npm install <server-package>
[ ] 3. Add new argument roles to argument-roles.ts (if needed)
[ ] 4. npx tsc --noEmit (verify types compile)
[ ] 5. npm run compile-policy (annotate new tools)
[ ] 6. Review tool-annotations.json for new server
[ ] 7. Update constitution.md for new tool categories
[ ] 8. npm run compile-policy (recompile rules with new constitution)
[ ] 9. Add handwritten scenarios to handwritten-scenarios.ts
[ ] 10. npm run compile-policy (verify with new scenarios)
[ ] 11. npm test (all tests pass)
```

Each step has a natural validation gate. The compile-time completeness check on `ArgumentRole` catches forgotten roles. The pipeline's verify step catches incorrect rules. Handwritten scenarios catch missing coverage.

## 8. Implementation Phases

### Phase 1: Role Extensibility + Policy Engine Domain Support (merged)

These must land together. Adding URL roles with `isResourceIdentifier: true` immediately breaks the policy engine if the protected path check and filesystem sandbox containment still use `getResourceRoles()` (see Section 3.7). The category-aware accessors and the engine's domain support must be co-committed.

**Files changed:**
- `src/types/argument-roles.ts` -- add `RoleCategory`, `resolveForPolicy`, `annotationGuidance` to `RoleDefinition`; add `category` and `annotationGuidance` to existing role entries; add new roles (`fetch-url`, `git-remote-url`, `branch-name`, `commit-message`); add URL normalizers and `resolveGitRemote`; add `getRolesByCategory()`, `getPathRoles()`, `getUrlRoles()`
- `src/trusted-process/policy-engine.ts` -- switch the protected path check and filesystem sandbox containment from `getResourceRoles()` to `getPathRoles()`; add `serverDomainAllowlists` constructor param; add `extractAnnotatedUrls()`, `domainMatchesAllowlist()`, untrusted domain gate; add `ruleMatches()` domains condition; add resolution pipeline (`resolveForPolicy` → `normalize` → `prepareForPolicy`)
- `src/trusted-process/mcp-proxy-server.ts` -- extract domain allowlists from deserialized `mcp-servers.json` sandbox configs, pass to `PolicyEngine` constructor
- `src/pipeline/types.ts` -- add `DomainCondition` to `CompiledRuleCondition`
- `src/pipeline/tool-annotator.ts` -- generate role descriptions from registry in prompt
- `src/pipeline/constitution-compiler.ts` -- `domains` condition in prompt and response schema
- `src/pipeline/scenario-generator.ts` -- domain scenarios in prompt

**Tests:** URL normalization, domain extraction, git URL handling, git remote resolution (mock `execFileSync`), category accessors, domain matching, untrusted domain gate behavior, multi-role evaluation (path + URL), backward compatibility (all existing `policy-engine.test.ts` tests pass unchanged with `getPathRoles()` swap).

### Phase 2: Git Server Integration + User Constitution

**Files changed:**
- `src/config/mcp-servers.json` -- add git server
- `src/config/constitution.md` -- add git-specific guidance
- `src/pipeline/handwritten-scenarios.ts` -- add git scenarios
- `src/pipeline/compile.ts` -- load user constitution alongside base
- `src/config/paths.ts` -- add `getUserConstitutionPath()`
- `package.json` -- `@cyanheads/git-mcp-server` dependency (already installed as devDep from spike)

**Pipeline run:** `npm run compile-policy` generates annotations, rules, and scenarios for git. Note: first run after Phase 1 will invalidate all annotation caches (prompt text changed) and force full re-annotation of all servers.

**Verification:** Review `tool-annotations.json` for git tools after pipeline run. Confirm `remote` arguments get `git-remote-url` role and `path` arguments get appropriate path roles.

## 9. Test Strategy

### Unit Tests

- URL normalization edge cases (missing protocol, trailing slashes, ports, invalid URLs)
- SSH URL domain extraction (`git@github.com:user/repo.git` → `github.com`)
- Named remote resolution (mock `execSync` for `git remote get-url`)
- `domainMatchesAllowlist()` (exact, wildcard, `*`, no match)
- `getRolesByCategory()` returns correct roles per category
- `isArgumentRole()` accepts new roles
- Resolution pipeline: `resolveForPolicy` → `normalize` → `prepareForPolicy`

### Policy Engine Tests

- Untrusted domain gate escalates when URL domain not in allowlist
- Untrusted domain gate passes when domain matches (including wildcards)
- Untrusted domain gate skipped when server has no domain allowlist
- Untrusted domain gate with named remote resolution (mock)
- Compiled rule evaluation `domains` condition matches/doesn't match
- Multi-role: tool with path + URL roles evaluates both independently
- All existing `policy-engine.test.ts` tests pass without modification

### Integration Tests

- Connect to git server, list tools, verify expected tools
- Full compile-policy run with git server succeeds
- Policy engine correctly evaluates git tool calls

### Handwritten Scenarios

Ground truth for the compile-verify-repair loop. Cover read ops (allow), write ops (allow in sandbox), remote ops (escalate), destructive ops (escalate), unknown tools (deny).
