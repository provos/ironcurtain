# Explicit Agent Mode (no silent fallback)

## Motivation

Bishop Fox testers Aaron and Ben spent significant time debugging the wrong session mode because IronCurtain silently fell back from Docker to the builtin V8 sandbox when Docker detection failed. PR #213 already eliminated transient Docker-probe flakiness (10s per-attempt timeout, up to 2 retries). The remaining behavioral fix is to stop the silent fallback itself: builtin must be a deliberate choice, not a degraded default.

This design replaces auto-detect with an explicit `preferredMode` config field. The Docker path is the default; if Docker is unavailable, the session errors out with a remediation hint instead of dropping into builtin.

## Decisions (already settled, do not re-debate)

- Drop silent fallback. No `'auto'` mode.
- New `preferredMode: 'docker' | 'builtin'` in `UserConfig`. Default `'docker'`.
- `--agent` CLI flag wins over `preferredMode`.
- `preferredDockerAgent` (`'claude-code' | 'goose'`) continues to gate which Docker agent runs.
- No backward-compatibility carve-outs — single user, accepts churn.

## Naming

`preferredMode` is preferred over alternatives like `defaultAgent`, `runtimeMode`, or `sessionMode` because:

- It composes cleanly with the existing `preferredDockerAgent`. Reading the config, "preferred mode = docker, preferred docker agent = claude-code" parses left-to-right.
- "Mode" matches the existing `Mode: ...` print line and the `SessionMode` discriminated union in `src/session/types.ts`. The config field name and the runtime concept share vocabulary.
- "Preferred" telegraphs intent (this is the user's preference) without implying fallback semantics — important now that we've removed silent fallback. If Docker is unavailable, the preference is unmet and we error; we do not silently substitute.

## Control flow

`resolveSessionMode()` keeps its current top-level shape. Only `resolveAutoDetect()` changes: rename to `resolveDefaultMode()` (no auto-detection happens anymore) and dispatch on `preferredMode`.

```ts
async function resolveSessionMode(options: PreflightOptions): Promise<PreflightResult> {
  const { config, requestedAgent, credentialSources } = options;
  const isDockerAvailable = options.isDockerAvailable ?? checkDockerAvailable;

  if (requestedAgent !== undefined) {
    return resolveExplicit(requestedAgent, config, isDockerAvailable, credentialSources);
  }

  return resolveDefaultMode(config, isDockerAvailable, credentialSources);
}

async function resolveDefaultMode(
  config: IronCurtainConfig,
  isDockerAvailable: () => Promise<DockerAvailability>,
  credentialSources?: CredentialSources,
): Promise<PreflightResult> {
  const { preferredMode, preferredDockerAgent } = config.userConfig;

  if (preferredMode === 'builtin') {
    // Builtin requires an Anthropic API key; OAuth is unusable here.
    const apiKey = resolveApiKeyForProvider('anthropic', config.userConfig);
    if (apiKey.length === 0) {
      throw new PreflightError(builtinNeedsApiKeyMessage());
    }
    return { mode: { kind: 'builtin' }, reason: 'preferredMode = builtin' };
  }

  // preferredMode === 'docker' — the default branch.
  const dockerStatus = await isDockerAvailable();
  if (!dockerStatus.available) {
    throw new PreflightError(dockerUnavailableMessage(dockerStatus.detailedMessage));
  }

  const credKind = await detectCredentials(preferredDockerAgent, config, credentialSources);
  if (credKind === null) {
    throw new PreflightError(
      credentialErrorMessageForPreferredMode(preferredDockerAgent, config, credentialSources),
    );
  }

  return {
    mode: { kind: 'docker', agent: preferredDockerAgent, authKind: credKind },
    reason: `${preferredDockerAgent} (${credKind === 'oauth' ? 'OAuth' : 'API key'})`,
  };
}
```

The OAuth-only-without-Docker special case at `preflight.ts:244-250` collapses into the general `preferredMode === 'docker'` branch: Docker unavailable now errors unconditionally regardless of which credentials the user holds. The OAuth message becomes one variant of `dockerUnavailableMessage()` content rather than a separately-thrown branch.

`resolveExplicit()` is unchanged — explicit `--agent` already errors on missing prerequisites, and continues to call the existing `credentialErrorMessageForExplicit()` (renamed from `credentialErrorMessage`) so its `--agent ${agentId} requires authentication...` wording stays correct.

## `UserConfig` schema change

Field: `preferredMode: 'docker' | 'builtin'`, default `'docker'`. Lives in `src/config/user-config.ts` alongside `preferredDockerAgent`.

```ts
export const SESSION_MODES = ['docker', 'builtin'] as const;
export type SessionModeKind = (typeof SESSION_MODES)[number];

// In userConfigSchema:
preferredMode: z.enum(SESSION_MODES).optional(),

// In USER_CONFIG_DEFAULTS:
preferredMode: 'docker',

// In ResolvedUserConfig:
readonly preferredMode: SessionModeKind;

// In mergeWithDefaults:
preferredMode: config.preferredMode ?? USER_CONFIG_DEFAULTS.preferredMode,
```

The `SESSION_MODES` tuple deliberately mirrors the `DOCKER_AGENTS` / `GOOSE_PROVIDERS` pattern already used in this file — readable for the config editor, derivable as a Zod enum, exported for tests.

All touch-points the implementer must hit when adding `preferredMode` (omitting any of these breaks the field silently):

1. `SESSION_MODES` const tuple (new export at top of file).
2. `SessionModeKind` type alias derived from the tuple.
3. `userConfigSchema` Zod field — `preferredMode: z.enum(SESSION_MODES).optional()`.
4. `USER_CONFIG_DEFAULTS` value — `preferredMode: 'docker'`.
5. `ResolvedUserConfig` field — `readonly preferredMode: SessionModeKind`.
6. `mergeWithDefaults` merge line (around the `preferredDockerAgent` sibling, currently ~line 639) — `preferredMode: config.preferredMode ?? USER_CONFIG_DEFAULTS.preferredMode`.
7. `computeDiff` — extend the `topLevelKeys` tuple in `src/config/config-command.ts` so `preferredMode` is included when diffing pending changes against resolved config.

## Print-line behavior

On success, the existing `Mode: ...` line in `src/index.ts:127` continues to render with the `reason` field from `PreflightResult`. The reason strings change to reflect explicit selection. The line already starts with `Mode: <kind>`, so the parenthetical no longer needs to repeat the mode — instead we surface the agent (useful for PTY-mode users):

- `Mode: docker / claude-code (OAuth)`
- `Mode: docker / claude-code (API key)`
- `Mode: docker / goose (API key)`
- `Mode: builtin` (no parenthetical)

The corresponding `reason` strings produced by `resolveDefaultMode` (and consumed by the print formatter):

- Docker branch: `reason = "${preferredDockerAgent} (${credKind === 'oauth' ? 'OAuth' : 'API key'})"` — formatter renders `Mode: docker / ${reason}`.
- Builtin branch: `reason = "preferredMode = builtin"` — formatter detects builtin kind and prints just `Mode: builtin`.

`resolveExplicit()` should keep its current `reason` shape; the formatter is the only place that decides whether to append the parenthetical.

On `PreflightError`, no `Mode:` line is printed. The CLI catches the error in its top-level handler, writes the error message to stderr, and exits 1. (This is already the behavior for explicit `--agent` failures — the auto-detect path now joins it.)

## Error wording

All four error messages must be self-explanatory: include the failure cause, the one-shot CLI escape, and the permanent config escape.

### `dockerUnavailableMessage(detailedMessage: string)`

```
Cannot start IronCurtain.
preferredMode is "docker" but Docker is not available:

<dockerStatus.detailedMessage indented or rendered as-is>

To run this session in builtin mode, pass:
  --agent builtin

To make builtin the default permanently, run:
  ironcurtain config
and set Session Mode > Preferred mode to "builtin".

Run `ironcurtain doctor` for a full diagnostic.
```

### `builtinNeedsApiKeyMessage()`

```
Cannot start IronCurtain.
preferredMode is "builtin" but no ANTHROPIC_API_KEY is configured.
Builtin mode talks to Anthropic directly using an API key — Claude OAuth credentials are not usable in builtin mode.

To run this session in Docker mode, pass:
  --agent claude-code

To make Docker the default permanently, run:
  ironcurtain config
and set Session Mode > Preferred mode to "docker".

Set ANTHROPIC_API_KEY in your environment, or run `ironcurtain config`.
```

### `credentialErrorMessageForPreferredMode(agentId, config, credentialSources)`

A new variant that reads symmetric with the two helpers above. The existing helper hard-codes `--agent ${agentId} requires authentication...`, which mis-attributes the cause when the user never passed `--agent`. Splitting into two helpers keeps each call site honest:

- `credentialErrorMessageForExplicit(agentId, config)` — current wording, used only by `resolveExplicit()`.
- `credentialErrorMessageForPreferredMode(agentId, config, credentialSources)` — new, used by `resolveDefaultMode()`.

The preferred-mode variant:

```
Cannot start IronCurtain.
preferredMode is "docker" but no credentials are configured for "<agentId>".

<provider-specific guidance — e.g., 'Set ANTHROPIC_API_KEY' for claude-code,
 'Set <provider>_API_KEY' for goose>

To run this session in builtin mode, pass:
  --agent builtin

To make builtin the default permanently, run:
  ironcurtain config
and set Session Mode > Preferred mode to "builtin".
```

### Goose + OAuth-only addendum

When `preferredDockerAgent === 'goose'` and the only Anthropic credentials present are OAuth (no API key), the base message says `requires an API key for provider "anthropic". Set ANTHROPIC_API_KEY...` — which leaves a tester who just ran `claude login` wondering why their auth doesn't help. `credentialErrorMessageForPreferredMode` (and the explicit variant for symmetry) inspects `credentialSources` and, when goose is the agent and Anthropic OAuth is present, appends one extra line:

```
OAuth credentials are not usable with goose; provider "anthropic" requires an API key.
```

This is purely additive — the rest of the message is unchanged.

(The old `credentialErrorMessage()` helper is renamed to `credentialErrorMessageForExplicit()`; both call sites — old and new — are updated in the same patch.)

## Edge cases

| Scenario | Outcome |
| --- | --- |
| `--agent builtin` + `preferredMode: 'docker'` | CLI wins. `resolveExplicit('builtin', ...)` returns builtin without checking Docker or the API key (current behavior). Documented in the test plan to lock the gap in. |
| `--agent claude-code` + `preferredMode: 'builtin'` | CLI wins. `resolveExplicit('claude-code', ...)` checks Docker and errors with the existing message if unavailable. |
| `preferredMode: 'docker'` + `preferredDockerAgent: 'goose'` + only Anthropic OAuth credentials | `detectCredentials('goose', ...)` looks at the goose provider's API key, finds none, returns `null` → `credentialErrorMessageForPreferredMode('goose', config, credentialSources)` fires. The message names goose's provider explicitly and appends the "OAuth not usable with goose" line because Anthropic OAuth was detected. |
| `preferredMode: 'builtin'` + only OAuth (no `ANTHROPIC_API_KEY`) | New explicit check at the top of the builtin branch errors with `builtinNeedsApiKeyMessage()` before any Docker probe. Fast failure — no 10s docker probe wasted. |
| `preferredMode: 'docker'` + Docker available + `ANTHROPIC_API_KEY` set + OAuth credentials present | Unchanged from today: `detectAuthMethod()` prefers OAuth; session runs Docker mode with OAuth. |

## Interactive config editor

Add a top-level menu entry `Session Mode (<hint>)` between `Memory` and `Docker Agent`. Submenu has one prompt: "Preferred mode" with `Docker (recommended)` and `Builtin (V8 sandbox)` options.

```ts
{ value: 'sessionMode', label: `Session Mode (${sessionModeHint(resolved, pending)})` }
```

`sessionModeHint` returns `'Docker'` or `'Builtin'`. Implementation mirrors the existing `handleDockerAgent` shape (single-field submenu with a Back option). The new `preferredMode` field also joins the `topLevelKeys` array in `computeDiff()` (see schema touch-point #7).

The Docker Agent submenu remains a peer — `preferredDockerAgent` is still meaningful when `preferredMode === 'builtin'` because `--agent claude-code` overrides only mode, not which Docker agent.

## Doctor command impact

Two changes in `src/doctor/`:

1. **Surface the resolved preferred mode and treat declared-but-unmet preferences as failures.** Add `checkPreferredMode(config: IronCurtainConfig, dockerResult: CheckResult)` to the `Configuration` section, called immediately after `checkConfigLoad` so it consumes the already-loaded config (mirrors `checkPolicyArtifacts(config)` shape — no re-load, no second probe).

   The function reuses the prior `dockerResult` so Docker is probed exactly once per `doctor` run, and then maps the (preferredMode × dockerResult × api-key-presence) tuple to a status:

   | `preferredMode` | `dockerResult` | API key present | `checkPreferredMode` status |
   | --- | --- | --- | --- |
   | `docker` | `ok` | (any) | `ok` — `Preferred mode: docker` |
   | `docker` | `warn` (unavailable) | (any) | `fail` — `Preferred mode: docker, but Docker is unavailable. Sessions will refuse to start.` |
   | `builtin` | (any) | yes | `ok` — `Preferred mode: builtin` |
   | `builtin` | (any) | no | `warn` — `Preferred mode: builtin, but no ANTHROPIC_API_KEY configured. Sessions will fail.` |

   Doctor's overall exit code is the worst status across all checks, so a `fail` here makes `ironcurtain doctor` exit 1 in exactly the cases where a session would refuse to start. This is a deliberate change from the prior behavior — under deny-fallback semantics, a declared-but-unmet preference is a real diagnostic problem, not advisory.

2. **`checkDocker` itself is unchanged.** It continues to return `warn` (not `fail`) on unavailability — the contextual interpretation (`warn` is bad if `preferredMode === 'docker'`, fine if `preferredMode === 'builtin'`) is moved entirely into `checkPreferredMode`. Keeping `checkDocker` semantically agnostic preserves its reusability and concentrates the policy decision in one place.

(Optional DI seam: `checkPreferredMode` may also accept an `isDockerAvailable` injection for tests that want to drive both checks from a single fake. Not required if the doctor command always runs `checkDocker` first and threads the result.)

No changes to `--check-api`, MCP liveness probes, or the credential checks.

## Test plan

In `test/preflight.test.ts`, replace the auto-detect block with a `resolveDefaultMode` block covering:

- `preferredMode: 'docker'` + Docker available + Anthropic API key → `mode.kind === 'docker'`, agent `claude-code`, authKind `apikey`.
- `preferredMode: 'docker'` + Docker available + OAuth (no API key) → mode docker, authKind `oauth`.
- `preferredMode: 'docker'` + Docker available + `preferredDockerAgent: 'goose'` + goose provider key set → mode docker, agent `goose`.
- `preferredMode: 'docker'` + Docker available + `preferredDockerAgent: 'goose'` + only Anthropic OAuth → throws PreflightError matching `goose` credential message AND containing the `OAuth credentials are not usable with goose` line.
- `preferredMode: 'docker'` + Docker unavailable → throws PreflightError matching `Docker is not available`, includes `--agent builtin` hint and `ironcurtain config` hint.
- `preferredMode: 'docker'` + Docker available + no credentials at all → throws PreflightError from `credentialErrorMessageForPreferredMode` (NOT the explicit-mode helper — assert the message does not contain `--agent claude-code requires authentication`).
- `preferredMode: 'builtin'` + Anthropic API key → mode builtin, no Docker probe attempted (verify probe is never called).
- `preferredMode: 'builtin'` + OAuth only → throws PreflightError matching `no ANTHROPIC_API_KEY`.
- `preferredMode: 'builtin'` + nothing configured → same PreflightError as OAuth-only.
- `--agent builtin` + `preferredMode: 'docker'` → mode builtin (CLI overrides config).
- `--agent builtin` + `preferredMode: 'builtin'` + no API key → mode builtin returned successfully (the API-key check is intentionally skipped on the explicit path; agent loop fails later on the actual API call). This test exists to lock the asymmetry in — anyone "tightening" `resolveExplicit` to mirror the default path's API-key check should have to delete this test on purpose.
- `--agent claude-code` + `preferredMode: 'builtin'` + Docker unavailable → throws (existing explicit-mode message — assert it still uses `credentialErrorMessageForExplicit`'s `--agent claude-code requires...` wording).

Add one assertion-level test for `userConfigSchema`: rejects `preferredMode: 'auto'` with a clear message.

For the config editor (if it has tests), assert that toggling `preferredMode` lands a `preferredMode` field in the saved partial.

For `src/doctor/`, add tests covering `checkPreferredMode`:

- `preferredMode: 'docker'` + `dockerResult.status === 'warn'` → `checkPreferredMode` returns `fail`; full doctor run exits 1.
- `preferredMode: 'docker'` + `dockerResult.status === 'ok'` → `checkPreferredMode` returns `ok`.
- `preferredMode: 'builtin'` + no API key → `checkPreferredMode` returns `warn`; full doctor run still exits 0 (warn alone doesn't fail).
- `preferredMode: 'builtin'` + API key present → `checkPreferredMode` returns `ok`.

## Files touched

- `src/config/user-config.ts` — add `SESSION_MODES`/`SessionModeKind`, schema field, default, resolved field, merge (touch-points 1–6 in the schema section).
- `src/config/config-command.ts` — new `Session Mode` menu entry, handler, hint, and `topLevelKeys` update (touch-point 7).
- `src/session/preflight.ts` — rename `resolveAutoDetect` → `resolveDefaultMode`, replace body, drop OAuth-only special case, add `dockerUnavailableMessage` / `builtinNeedsApiKeyMessage` helpers, rename `credentialErrorMessage` → `credentialErrorMessageForExplicit`, add `credentialErrorMessageForPreferredMode` (with goose+OAuth addendum).
- `src/index.ts` (or wherever the `Mode:` print line lives) — update the formatter to render `Mode: <kind> / <reason>` for docker and `Mode: builtin` for builtin.
- `src/doctor/checks.ts` — new `checkPreferredMode(config, dockerResult)` function.
- `src/doctor/doctor-command.ts` — call `checkPreferredMode` in the `Configuration` section, threading the prior `dockerResult`.
- `test/preflight.test.ts` — replace auto-detect cases per the test plan above; add the `--agent builtin` no-API-key lock-in test and the goose+OAuth message-content test.
- `test/user-config.test.ts` (or equivalent) — add `preferredMode` schema assertions.
- `test/doctor.test.ts` (or equivalent) — add `checkPreferredMode` tests including the `docker-required-but-down → exit 1` case.

## Out of scope

- Auditing Docker detection technique. PR #213 already addressed flakiness; this design only changes what we do with the result.
- Adding a third `preferredMode` value (e.g., `'auto'`, `'pty'`). The whole point is to remove ambiguity.
- Changing `--agent` semantics. The flag continues to override config and to skip auto-selection logic entirely.
- Migrating existing config files. The user-base accepts churn; missing `preferredMode` resolves to the `'docker'` default automatically via `mergeWithDefaults`, which is the same as the prior auto-detect behavior on a Docker-up host.
- Cross-cutting changes to `ironcurtain doctor` exit codes beyond the targeted change in `checkPreferredMode`. Other checks' `warn`/`fail` semantics are unchanged.
- Tightening the `--agent builtin` explicit path to require an API key. Today `resolveExplicit('builtin', ...)` succeeds without an API-key check and the agent loop fails later on the actual API call; the test plan locks this gap in deliberately so a future "symmetry" refactor doesn't silently regress it. If that asymmetry needs to go, it's a separate design.
- Removing `preferredDockerAgent` or merging it into `preferredMode`. The agent dimension (which Docker agent) is orthogonal to the mode dimension (Docker vs builtin); collapsing them into a single `preferredAgent: 'docker-claude-code' | 'docker-goose' | 'builtin'` would re-introduce the ambiguity this design is meant to remove.
