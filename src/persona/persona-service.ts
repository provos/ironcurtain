/**
 * src/persona/persona-service.ts
 *
 * Headless persona lifecycle service (Phase 1a).
 *
 * Owns all file-system effects for persona CRUD. Called by the CLI
 * (persona-command.ts) and the WS dispatch (persona-dispatch.ts). The CLI keeps
 * its @clack prompts / $EDITOR / customizer as arg-gatherers and its own
 * "No changes made" diff; this module performs the writes.
 *
 * ZERO runtime value-imports from src/pipeline — type-only imports only. This is
 * enforced by the Phase-0 ESLint no-restricted-imports rule and
 * test/pipeline-import-boundary.test.ts.
 *
 * The `actor` parameter on the mutating functions is USED as of Phase 1c: each
 * mutation appends a tamper-evident record to the policy-mutation audit log
 * (src/persona/policy-mutation-audit.ts), so CLI / cron / WS callers are all
 * captured at the service layer.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §4.1
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicWriteJsonSync } from '../escalation/escalation-watcher.js';
import { atomicWriteTextSync } from '../util/atomic-write.js';
import { getIronCurtainHome } from '../config/paths.js';
import {
  getPersonaDir,
  getPersonaGeneratedDir,
  getPersonaConstitutionPath,
  getPersonaDefinitionPath,
  getPersonasDir,
  loadPersona,
} from './resolve.js';
import { createPersonaName } from './types.js';
import type { PersonaName, PersonaDefinition } from './types.js';
import { scanPersonas } from '../mux/persona-scanner.js';
import { policyMutationAuditLog } from './policy-mutation-audit.js';
// Type-only imports — no runtime edge to pipeline / web-ui layers.
import type { CompiledPolicyFile } from '../pipeline/types.js';
import type { PersonaDetailDto, PersonaListDto, PersonaEditResultDto } from '../web-ui/web-ui-types.js';

// PersonaListDto / PersonaEditResultDto were promoted into web-ui-types.ts in
// Phase 1b (the 1a follow-up) so backend and frontend build against a single
// declaration. Re-export them so existing CLI/test importers of this module are
// unaffected by the move.
export type { PersonaListDto, PersonaEditResultDto } from '../web-ui/web-ui-types.js';

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreatePersonaInput {
  /** Raw slug — branded and path-traversal-checked inside the service. */
  readonly name: string;
  /** Description (trimmed by the service). */
  readonly description: string;
  /**
   * Optional server allowlist. Both a full-set selection and an empty array
   * are normalized to omit the key (CLI "all = undefined" semantics, see
   * persona-command.ts server multiselect normalization). Caller passes the
   * already-normalized subset; the service only treats `[]`/absent as omit.
   */
  readonly servers?: readonly string[];
  /**
   * Whether memory is enabled. Absent/true = omit the memory key from
   * persona.json (default-on semantics). false = memory:{enabled:false}.
   */
  readonly memoryEnabled?: boolean;
  /**
   * Constitution text (WITHOUT trailing newline). Absent or '' = empty
   * persona (no compile needed). Written atomically as constitution.md with
   * exactly one trailing newline when non-empty.
   */
  readonly constitution?: string;
}

/**
 * Normalizes constitution text into the on-disk file content. Mirrors the
 * historical CLI convention: non-empty text gets exactly one trailing newline;
 * empty text writes an empty file.
 */
function constitutionFileContent(text: string): string {
  return text ? text + '\n' : '';
}

// ---------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------

/**
 * Creates the full persona directory tree atomically.
 *
 * Build order:
 *   1. personas/.tmp-<name>-<uuid>/  + generated/ + workspace/
 *   2. Write persona.json (atomicWriteJsonSync)
 *   3. Write constitution.md (atomicWriteTextSync, default '')
 *   4. renameSync tmp → personas/<name>/
 *
 * On any failure the temp dir is removed (no half-persona on disk).
 * Does NOT compile the policy — compilation remains the CLI's responsibility.
 *
 * @param actor caller identity ('cli' | WS connId). Recorded in the audit log.
 */
export function createPersona(input: CreatePersonaInput, actor: string): PersonaDetailDto {
  const name = createPersonaName(input.name); // throws on bad slug (path-traversal guard)
  const description = input.description.trim();

  const personasDir = getPersonasDir();
  const finalDir = getPersonaDir(name);

  if (existsSync(finalDir)) {
    throw Object.assign(new Error(`Persona "${name}" already exists.`), { code: 'PERSONA_EXISTS' });
  }

  // Server-allowlist normalization: empty/absent → omit key. The CLI performs
  // the full-set-selection → undefined collapse before calling; here we only
  // need to treat [] the same as absent.
  const servers: readonly string[] | undefined = input.servers && input.servers.length > 0 ? input.servers : undefined;

  const personaDef: PersonaDefinition = {
    name,
    description,
    createdAt: new Date().toISOString(),
    ...(servers ? { servers } : {}),
    ...(input.memoryEnabled === false ? { memory: { enabled: false } } : {}),
  };

  // Build the whole tree under a temp name first; rename atomically at the end.
  mkdirSync(personasDir, { recursive: true });
  const tmpDir = resolve(personasDir, `.tmp-${name}-${randomUUID()}`);
  mkdirSync(resolve(tmpDir, 'generated'), { recursive: true });
  mkdirSync(resolve(tmpDir, 'workspace'), { recursive: true });

  try {
    atomicWriteJsonSync(resolve(tmpDir, 'persona.json'), personaDef);
    atomicWriteTextSync(resolve(tmpDir, 'constitution.md'), constitutionFileContent(input.constitution ?? ''));
    // Final atomic rename: tmp → personas/<name>/
    renameSync(tmpDir, finalDir);
  } catch (err) {
    // Roll back — no half-persona.
    rmSync(tmpDir, { recursive: true, force: true });
    throw err;
  }

  policyMutationAuditLog.append(actor, 'createPersona', name, {
    constitutionHash: createHash('sha256')
      .update(constitutionFileContent(input.constitution ?? ''))
      .digest('hex'),
  });

  return getPersonaDetail(name);
}

/**
 * Writes (or overwrites) a persona's constitution.md atomically and returns
 * whether the compiled policy is now stale.
 *
 * Unified write+stale-detect used by ALL edit paths (customizer, editor,
 * generation). Note: the $EDITOR path writes the file in place first, then the
 * CLI reads it back and calls this; the resulting atomic re-write is idempotent
 * and produces byte-identical content.
 *
 * Stale detection: the pipeline computes constitutionHash as
 * sha256(rawConstitutionFileContent) (compile-persona-policy.ts reads the file
 * verbatim, no trim). We therefore hash the exact bytes we write. Missing or
 * unparseable policy → stale:true (conservative).
 *
 * @param actor caller identity. Recorded in the audit log.
 */
export function setPersonaConstitution(name: PersonaName, text: string, actor: string): PersonaEditResultDto {
  const personaDir = getPersonaDir(name);
  if (!existsSync(personaDir)) {
    throw Object.assign(new Error(`Persona "${name}" not found.`), { code: 'PERSONA_NOT_FOUND' });
  }

  const constitutionPath = getPersonaConstitutionPath(name);
  const content = constitutionFileContent(text);
  atomicWriteTextSync(constitutionPath, content);

  const newHash = createHash('sha256').update(content).digest('hex');
  policyMutationAuditLog.append(actor, 'setPersonaConstitution', name, { constitutionHash: newHash });

  // Stale detection: compare against the compiled policy's constitutionHash.
  const policyPath = resolve(getPersonaGeneratedDir(name), 'compiled-policy.json');
  if (!existsSync(policyPath)) return { stale: true };

  try {
    const compiled = JSON.parse(readFileSync(policyPath, 'utf-8')) as CompiledPolicyFile;
    if (!compiled.constitutionHash) return { stale: true };
    // Hash the raw file content — the pipeline hashes config.constitutionInput,
    // which is the verbatim file read (text + '\n' for non-empty).
    return { stale: newHash !== compiled.constitutionHash };
  } catch {
    return { stale: true };
  }
}

/**
 * Toggles persistent memory for a persona.
 *
 * Lifted verbatim from persona-command.ts (the destructure-omit pattern is
 * required under exactOptionalPropertyTypes):
 *   enable  → DROP the memory key entirely (default-on semantics)
 *   disable → memory: { enabled: false }
 *
 * @param actor caller identity. Recorded in the audit log.
 */
export function setPersonaMemory(name: PersonaName, enabled: boolean, actor: string): void {
  const persona = loadPersona(name); // throws 'not found' if missing
  // Verbatim destructure-omit from persona-command.ts.
  const { memory: _omit, ...rest } = persona;
  void _omit;
  const updated: PersonaDefinition = !enabled ? { ...rest, memory: { enabled: false } } : rest;
  atomicWriteJsonSync(getPersonaDefinitionPath(name), updated);
  policyMutationAuditLog.append(actor, 'setPersonaMemory', name, { enabled });
}

/** Options for {@link deletePersona}. */
export interface DeletePersonaOptions {
  /**
   * When true, the persona directory is HARD-removed (rmSync recursive+force),
   * permanently revoking the compiled policy. When false/absent (the DEFAULT),
   * the directory is SOFT-deleted: renamed into a trash dir OUTSIDE
   * getPersonasDir() so it is recoverable and is never listed/resolved.
   */
  readonly force?: boolean;
}

/** Returns the persona trash base dir: {home}/.persona-trash/ (outside personas/). */
function getPersonaTrashDir(): string {
  return resolve(getIronCurtainHome(), '.persona-trash');
}

/**
 * Deletes a persona. SOFT by default (recoverable), HARD when `opts.force`.
 *
 * Soft delete renames the persona directory to
 *   {home}/.persona-trash/<name>-<ISO-ts>/
 * which lives OUTSIDE getPersonasDir(), so scanPersonas / resolvePersona (which
 * only look under personas/) never list or resolve a tombstoned persona. Hard
 * delete (`force: true`) permanently removes the directory (the legacy CLI
 * behavior), revoking the compiled policy.
 *
 * @param actor caller identity. Recorded in the audit log.
 */
export function deletePersona(name: PersonaName, actor: string, opts: DeletePersonaOptions = {}): void {
  const personaDir = getPersonaDir(name);
  if (!existsSync(personaDir)) {
    throw Object.assign(new Error(`Persona "${name}" not found.`), { code: 'PERSONA_NOT_FOUND' });
  }

  if (opts.force) {
    rmSync(personaDir, { recursive: true, force: true });
  } else {
    const trashDir = getPersonaTrashDir();
    mkdirSync(trashDir, { recursive: true });
    // Colons are invalid in some filesystems; use a filesystem-safe timestamp.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    renameSync(personaDir, resolve(trashDir, `${name}-${ts}`));
  }

  policyMutationAuditLog.append(actor, 'deletePersona', name, { hardDelete: opts.force === true });
}

/**
 * Sets the persona's `allowBroadPolicy` opt-in flag (Phase 1c). This is the ONLY
 * way to set the flag — it is NEVER inferred from the constitution text. When
 * true, the broad-policy validator permits the persona to compile a policy with
 * `'*'` domains/lists or out-of-workspace `paths.within`.
 *
 * @param actor caller identity. Recorded in the audit log.
 */
export function setPersonaBroadPolicyOptIn(name: PersonaName, enabled: boolean, actor: string): PersonaDetailDto {
  const persona = loadPersona(name); // throws 'not found' if missing
  // Drop the key when disabling (default-off semantics, exactOptionalPropertyTypes).
  const { allowBroadPolicy: _omit, ...rest } = persona;
  void _omit;
  const updated: PersonaDefinition = enabled ? { ...rest, allowBroadPolicy: true } : rest;
  atomicWriteJsonSync(getPersonaDefinitionPath(name), updated);
  policyMutationAuditLog.append(actor, 'setPersonaBroadPolicyOptIn', name, { enabled, broadened: enabled });
  return getPersonaDetail(name);
}

/**
 * Returns full detail for a persona, including constitution text and whether
 * the compiled policy exists. Lifted from persona-dispatch.ts and extended with
 * the `memory` flag (persona.memory?.enabled ?? true) and the `allowBroadPolicy`
 * flag (persona.allowBroadPolicy ?? false, Phase 1c).
 *
 * @throws if the persona does not exist.
 */
export function getPersonaDetail(name: PersonaName): PersonaDetailDto {
  const persona = loadPersona(name); // throws if missing

  let constitution = '';
  const constitutionPath = getPersonaConstitutionPath(name);
  try {
    constitution = readFileSync(constitutionPath, 'utf-8');
  } catch {
    // No constitution yet — return empty.
  }

  const policyPath = resolve(getPersonaGeneratedDir(name), 'compiled-policy.json');
  const hasPolicy = existsSync(policyPath);

  let policyRuleCount: number | undefined;
  if (hasPolicy) {
    try {
      const compiled = JSON.parse(readFileSync(policyPath, 'utf-8')) as CompiledPolicyFile;
      policyRuleCount = compiled.rules.length;
    } catch {
      // Ignore parse errors.
    }
  }

  return {
    name: persona.name,
    description: persona.description,
    createdAt: persona.createdAt,
    constitution,
    servers: persona.servers,
    hasPolicy,
    policyRuleCount,
    memory: persona.memory?.enabled ?? true,
    allowBroadPolicy: persona.allowBroadPolicy ?? false,
  };
}

/**
 * Lists all personas. Delegates to scanPersonas() (alphabetically sorted).
 * Both the CLI and the WS dispatch call this to prevent drift.
 */
export function listPersonas(): PersonaListDto[] {
  return scanPersonas().map((p) => ({
    name: p.name,
    description: p.description,
    compiled: p.compiled,
  }));
}
