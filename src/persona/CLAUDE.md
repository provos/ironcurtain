# Persona module (`src/persona/`)

Named profiles bundling a constitution + compiled policy under
`~/.ironcurtain/personas/<name>/`. The headless `persona-service.ts` owns all
filesystem effects for persona CRUD; the CLI (`persona-command.ts`) and the WS
dispatch (`web-ui/dispatch/persona-dispatch.ts`) both call it so behavior never
drifts between surfaces.

## Layering

ZERO runtime value-imports from `src/pipeline`. Only `import type { ... } from
'../pipeline/types.js'` (the compiled-policy / annotation shapes) is allowed.
The only sanctioned pipeline VALUE seam is `compile-persona-policy.ts`, reached
EXCLUSIVELY via `await import(...)` from `persona-compile-orchestrator.ts`.
Enforced by `test/pipeline-import-boundary.test.ts` + the ESLint
`no-restricted-imports` rule.

## Phase 1c policy-mutation safety (`docs/designs/web-ui-policy-persona-management.md` §7)

- **Kill switch.** Persona mutations over the web UI are gated behind the daemon
  `--allow-policy-mutation` flag (default OFF, CLI-only, not config-persisted).
  When off, every mutation method returns `POLICY_MUTATION_FORBIDDEN`; read
  methods stay ungated. Surfaced to the UI via
  `DaemonStatusDto.allowPolicyMutation`.

- **Broad-policy validator** (`broad-policy-validator.ts`). Passed as the
  `validateCompiled` hook to `compilePersonaPolicy`. LLM-independent: inspects the
  COMPILED rules (not the constitution text), so it defeats constitution
  prompt-injection. Rejects any BROAD wildcard in `domains.allowed` /
  `lists[].allowed` — the literal `*`, the empty-suffix `*.`, or a TLD-level
  prefix wildcard like `*.com` / `*.gov` (a wildcard whose suffix has <= 1
  label); a per-registered-domain wildcard like `*.github.com` is narrow and
  allowed. It also rejects any `paths.within` resolving outside the persona's
  workspace dir — UNLESS `persona.allowBroadPolicy === true`. The exact-`*`-only
  check was widened (see `isBroadDomainPattern`) because the runtime matcher
  `domainMatchesAllowlist` treats every `*.`-prefixed pattern as a suffix match,
  so `*.com` would otherwise grant near-wildcard egress. The opt-in is set ONLY via the gated
  `setPersonaBroadPolicyOptIn` flow; it is NEVER inferred from the constitution.
  Rejection -> `BROAD_POLICY_REJECTED` terminal `persona.compile.failed` event.

- **Soft delete.** `deletePersona` defaults to SOFT: it renames the persona dir
  into `~/.ironcurtain/.persona-trash/<name>-<ts>/`, which is OUTSIDE
  `getPersonasDir()`, so `scanPersonas` / `resolvePersona` (which only scan
  `personas/`) never list or resolve a tombstone. `force: true` hard-removes
  (revokes the policy). The CLI passes `force: true` to keep its existing
  "permanently delete" contract.

### Audit log (`policy-mutation-audit.ts`) — honest scope

Every mutating persona-service fn and the compile orchestrator append a record
to `~/.ironcurtain/audit/policy-mutation.jsonl` (append-only, O_APPEND, mode
0600, size-rotated ~10 MB). Records carry a monotonic `seq` + `prevHash` chain,
each HMAC'd with a daemon-private secret generated in process memory at startup
(never persisted, regenerated each run).

**What it detects:** any post-hoc edit, reorder, or deletion of the log by
anyone WITHOUT the in-process secret (`verifyAuditChain` flags the first broken
record). This covers the common "someone edited the audit trail after the fact"
case.

**What it does NOT defend:** a full-local-user filesystem attacker who can read
process memory (recovering the secret to forge a consistent chain) or who writes
persona policy files directly, bypassing the service layer entirely. The audit
log is tamper-EVIDENT, not tamper-PROOF, and is not a substitute for OS-level
file permissions on `~/.ironcurtain`.
