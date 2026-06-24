/**
 * src/persona/policy-mutation-audit.ts
 *
 * Tamper-evident audit log for persona policy mutations (Phase 1c, §7).
 *
 * Every mutating persona-service function (createPersona / setPersonaConstitution
 * / setPersonaMemory / deletePersona / setPersonaBroadPolicyOptIn) and the
 * persona-compile orchestrator append one record here, so CLI, cron, and the WS
 * dispatch are all captured at the service layer (not the WS boundary).
 *
 * On-disk format: append-only JSONL at
 *   $IRONCURTAIN_HOME/audit/policy-mutation.jsonl
 * opened with O_APPEND, mode 0600. Size-rotated at ~10 MB (current file moved to
 * `<name>.1`, the previous `.1` to `.2`, ... up to a small cap).
 *
 * Tamper-evidence: each record carries a monotonic `seq` and the `prevHash` of
 * the previous record's HMAC. The HMAC is keyed with a daemon-private secret
 * generated in process memory at startup (never persisted). This lets an
 * operator who holds the in-process secret detect any post-hoc edit / reorder /
 * deletion of the chain.
 *
 * HONEST SCOPE: this detects tampering by anyone WITHOUT the in-memory secret
 * (the common "someone edited the log after the fact" case). It does NOT defend
 * against a full-local-user filesystem attacker who can also read process memory
 * or write policy files directly — such an attacker can forge a consistent chain
 * or bypass the service entirely. See src/persona/CLAUDE.md.
 *
 * ZERO runtime value-imports from src/pipeline — type-only imports only.
 *
 * @see docs/designs/web-ui-policy-persona-management.md §7
 */

import { closeSync, mkdirSync, openSync, renameSync, statSync, writeSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { getIronCurtainHome } from '../config/paths.js';

/** Mutation methods recorded in the audit log. */
export type PolicyMutationMethod =
  | 'createPersona'
  | 'setPersonaConstitution'
  | 'setPersonaMemory'
  | 'deletePersona'
  | 'setPersonaBroadPolicyOptIn'
  | 'compilePersonaPolicy';

/** Optional structured details about the mutation's effect. */
export interface PolicyMutationDetails {
  /** sha256 hex of the constitution file content (where applicable). */
  readonly constitutionHash?: string;
  /** Rule-count delta vs the previous compiled policy (compiles). */
  readonly ruleCountDelta?: number;
  /** True when the mutation broadened the policy (e.g. introduced '*'/out-of-workspace). */
  readonly broadened?: boolean;
  /** Operation id tying a compile record to its llm-interactions log. */
  readonly operationId?: string;
  /** Whether a delete was a hard (force) delete vs a soft (trash) delete. */
  readonly hardDelete?: boolean;
  /** New value for setPersonaMemory / setPersonaBroadPolicyOptIn. */
  readonly enabled?: boolean;
}

/** A single persisted audit record. */
export interface PolicyMutationRecord {
  readonly seq: number;
  readonly ts: string;
  readonly actor: string;
  readonly method: PolicyMutationMethod;
  readonly persona: string;
  readonly details: PolicyMutationDetails;
  /** HMAC of the previous record (empty string for the first record). */
  readonly prevHash: string;
  /** HMAC over this record's canonical content (seq..prevHash). */
  readonly hash: string;
}

/** ~10 MB rotation threshold. */
const ROTATION_BYTES = 10 * 1024 * 1024;
/** How many rotated files to keep (.1 .. .N). */
const MAX_ROTATIONS = 3;

/**
 * Encapsulates the audit chain. A module-level singleton is exported for the
 * daemon/CLI; tests instantiate their own to control the secret and avoid
 * cross-test bleed. The seq/prevHash continue across rotations within a single
 * process lifetime.
 */
export class PolicyMutationAuditLog {
  /** Daemon-private HMAC secret, generated in memory, never persisted. */
  private readonly secret: Buffer;
  private seq = 0;
  private prevHash = '';

  constructor(secret?: Buffer) {
    this.secret = secret ?? randomBytes(32);
  }

  /** Absolute path to the active log file. */
  private logPath(): string {
    return resolve(getIronCurtainHome(), 'audit', 'policy-mutation.jsonl');
  }

  /**
   * Computes the HMAC over the canonical (secret-keyed) serialization of a
   * record's content fields. Determinism matters: the verifier recomputes this.
   */
  private computeHash(
    seq: number,
    ts: string,
    actor: string,
    method: string,
    persona: string,
    details: PolicyMutationDetails,
    prevHash: string,
  ): string {
    const canonical = JSON.stringify({ seq, ts, actor, method, persona, details, prevHash });
    return createHmac('sha256', this.secret).update(canonical).digest('hex');
  }

  /**
   * Appends one audit record. Best-effort and non-throwing on IO errors: a
   * failed audit write must never block a persona mutation (the mutation has
   * already happened or is about to). Returns the written record (or undefined
   * if the write failed).
   */
  append(
    actor: string,
    method: PolicyMutationMethod,
    persona: string,
    details: PolicyMutationDetails = {},
  ): PolicyMutationRecord | undefined {
    const seq = this.seq + 1;
    const ts = new Date().toISOString();
    const prevHash = this.prevHash;
    const hash = this.computeHash(seq, ts, actor, method, persona, details, prevHash);
    const record: PolicyMutationRecord = { seq, ts, actor, method, persona, details, prevHash, hash };

    try {
      this.writeLine(record);
    } catch {
      // Never let an audit failure surface as a mutation failure.
      return undefined;
    }

    // Only advance the chain after a successful write so a failed write does
    // not leave a gap that the verifier would flag.
    this.seq = seq;
    this.prevHash = hash;
    return record;
  }

  /** Appends a single JSONL line (O_APPEND, mode 0600), rotating first if needed. */
  private writeLine(record: PolicyMutationRecord): void {
    const path = this.logPath();
    mkdirSync(resolve(getIronCurtainHome(), 'audit'), { recursive: true });
    this.rotateIfNeeded(path);
    const fd = openSync(path, 'a', 0o600);
    try {
      writeSync(fd, JSON.stringify(record) + '\n');
    } finally {
      closeSync(fd);
    }
  }

  /** Size-based rotation: current -> .1, .1 -> .2, ... up to MAX_ROTATIONS. */
  private rotateIfNeeded(path: string): void {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return; // No file yet — nothing to rotate.
    }
    if (size < ROTATION_BYTES) return;

    // Shift older files down: .2 -> .3, .1 -> .2, current -> .1.
    for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
      const from = `${path}.${i}`;
      const to = `${path}.${i + 1}`;
      if (existsSync(from)) {
        try {
          renameSync(from, to);
        } catch {
          // Best-effort.
        }
      }
    }
    try {
      renameSync(path, `${path}.1`);
    } catch {
      // Best-effort.
    }
  }
}

/**
 * Verifies a sequence of records forms an intact HMAC chain under `secret`.
 * Returns `{ ok: true }` or the index of the first broken/forged record. Used by
 * tests (and operator tooling) to detect post-hoc tampering.
 */
export function verifyAuditChain(
  records: readonly PolicyMutationRecord[],
  secret: Buffer,
): { ok: true } | { ok: false; brokenAt: number; reason: string } {
  let expectedPrev = '';
  let expectedSeq = 1;
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (r.seq !== expectedSeq) {
      return { ok: false, brokenAt: i, reason: `seq mismatch: expected ${expectedSeq}, got ${r.seq}` };
    }
    if (r.prevHash !== expectedPrev) {
      return { ok: false, brokenAt: i, reason: 'prevHash chain break' };
    }
    const canonical = JSON.stringify({
      seq: r.seq,
      ts: r.ts,
      actor: r.actor,
      method: r.method,
      persona: r.persona,
      details: r.details,
      prevHash: r.prevHash,
    });
    const recomputed = createHmac('sha256', secret).update(canonical).digest('hex');
    if (recomputed !== r.hash) {
      return { ok: false, brokenAt: i, reason: 'HMAC mismatch (record content was modified)' };
    }
    expectedPrev = r.hash;
    expectedSeq += 1;
  }
  return { ok: true };
}

/**
 * The daemon/CLI-wide audit singleton. The secret is regenerated each process
 * startup (held only in memory). Tests construct their own instance.
 */
export const policyMutationAuditLog = new PolicyMutationAuditLog();
