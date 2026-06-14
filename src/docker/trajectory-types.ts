/**
 * MITM token-trajectory capture: shared types.
 *
 * Types backing the on-disk JSONL schema (see
 * docs/designs/mitm-token-trajectory-capture.md §4) and the dispatcher's
 * internal state. The schema is the source of truth for the corpus
 * downstream tooling consumes — keep field names byte-faithful with the
 * design doc.
 */

import type { SessionId } from '../session/types.js';

/**
 * Provider identity. `unknown` is reserved for hosts the capture sees but
 * cannot classify. Note: `'openai'` spans two wire formats —
 * `api.openai.com` Chat Completions and `chatgpt.com` Responses —
 * disambiguated downstream by the record's `host` field. A future schema
 * bump should prefer a dedicated `apiSurface` field over overloading
 * `provider` if the distinction needs to be first-class.
 */
export type CaptureProvider = 'anthropic' | 'openai' | 'unknown';

/** Reason a session was poisoned. See §9 for the full taxonomy. */
export type PoisonReason =
  | 'reassembly-failure'
  | 'disk-error'
  | 'queue-overflow'
  | 'mid-stream-abort'
  | 'infrastructure-teardown'
  | 'unsupported-encoding'
  | 'unknown';

/**
 * Single HTTP exchange captured by the MITM proxy. One line per
 * exchange in the on-disk JSONL.
 */
export interface ExchangeRecord {
  readonly schemaVersion: 1;
  readonly exchangeId: string;
  readonly sessionId: string;
  readonly persona?: string;
  readonly workflowRunId?: string;
  readonly bundleId?: string;
  readonly recordedAgentName?: string;

  readonly provider: CaptureProvider;
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly requestStartedAt: number;
  readonly requestFinishedAt: number;
  readonly responseFinishedAt: number;

  readonly request: {
    readonly headers: Readonly<Record<string, string>>;
    /** UTF-8 body when content-encoding is identity (or absent); empty otherwise. */
    readonly bodyUtf8: string;
    /** Present iff body is compressed or otherwise not valid UTF-8. */
    readonly bodyBase64?: string;
    readonly bodyBytes: number;
    readonly contentEncoding?: string;
  };

  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly streaming: boolean;
    readonly providerRequestId?: string;
    readonly stopReason?: string;
    readonly modelFingerprint?: string;
    readonly usage?: Readonly<Record<string, unknown>>;
    readonly bodyUtf8: string;
    readonly bodyBase64?: string;
    readonly bodyBytes: number;
    readonly streamRaw?: {
      readonly events: ReadonlyArray<{
        readonly eventType: string;
        readonly dataUtf8: string;
        readonly offsetMs: number;
      }>;
    };
  };

  readonly capture: {
    readonly reassemblyOk: boolean;
    readonly reassemblyDiagnostic?: string;
    readonly retried?: boolean;
  };
}

/**
 * Single line in `manifest.jsonl`. Always one `session-start` paired
 * with one `session-end` (modulo crash safety nets, where the start
 * may exist without a matching end — see §9).
 */
export type ManifestEntry =
  | {
      readonly schemaVersion: 1;
      readonly event: 'session-start';
      readonly seq: number;
      readonly sessionId: string;
      readonly persona?: string;
      readonly fsmState?: string;
      readonly ts: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly event: 'session-end';
      readonly seq: number;
      readonly sessionId: string;
      readonly persona?: string;
      readonly fsmState?: string;
      readonly ts: string;
      readonly exchanges: number;
      readonly bytesWritten: number;
      readonly poisoned: boolean;
      readonly poisonReason?: PoisonReason;
      readonly closedReason?: 'infrastructure-teardown';
    };

/**
 * Capture configuration. v0 surface is a single boolean — see §10 for
 * the rationale (no knobs that would silently produce partial captures).
 */
export interface CaptureConfig {
  readonly enabled: boolean;
}

/**
 * Inputs to `beginSession` / `beginCaptureSession`.
 */
export interface BeginCaptureSessionOptions {
  readonly sessionId: SessionId;
  readonly persona?: string;
  readonly fsmState?: string;
}

/**
 * Aggregate dispatcher diagnostics.
 */
export interface CaptureStats {
  /** Records successfully written to disk across all sessions. */
  readonly written: number;
  /**
   * Records dropped before disk (poisoned session, missing beginSession,
   * etc.). Individual records are never dropped on successful sessions;
   * this is for diagnostic visibility only.
   */
  readonly dropped: number;
  readonly queued: number;
  readonly bytesWritten: number;
  readonly openSessions: number;
}

/**
 * Reassembler interface. Each provider has its own state machine; the
 * dispatcher routes by host. See §5 for the byte-fidelity rules.
 */
export interface Reassembler {
  /** Feed raw response chunk bytes (verbatim). */
  push(chunk: Buffer): void;
  /**
   * Signal that the upstream response stream closed cleanly. Returns
   * the reassembled body plus structured fields. Throws (or marks the
   * reassembly as failed) if the stream did not finish in a well-formed
   * state. After `finalize()`, the reassembler MUST NOT be reused.
   */
  finalize(): ReassemblyResult;
  /**
   * True once the provider's terminal event has been parsed
   * (`message_stop` / `[DONE]` / `response.completed`). Lets the tap
   * finalize a complete-but-socket-aborted stream (write a faithful
   * record) instead of poisoning it as a mid-stream abort. When false,
   * a close/error before the terminal event is a genuine truncation.
   */
  canFinalize(): boolean;
}

/**
 * Output of a successful reassembly.
 */
export interface ReassemblyResult {
  /**
   * Reassembled body as a string. Constructed via raw substring
   * concatenation of wire bytes — never JSON.parse → JSON.stringify
   * on captured content. See §6 invariant #1.
   */
  readonly bodyUtf8: string;
  readonly providerRequestId?: string;
  readonly stopReason?: string;
  readonly modelFingerprint?: string;
  readonly usage?: Readonly<Record<string, unknown>>;
  /** Raw event log for diagnostics (`streamRaw.events`). */
  readonly events: ReadonlyArray<{
    readonly eventType: string;
    readonly dataUtf8: string;
    readonly offsetMs: number;
  }>;
}

/**
 * Headers/body redaction is centralized so the writer-input unit test
 * (§12 test #2(a)) can drive the redaction layer directly without a
 * proxy.
 */
export const REDACTED_HEADER_NAMES: ReadonlySet<string> = new Set([
  'authorization',
  'x-api-key',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

export const REDACTED_VALUE = '<redacted>';

/**
 * Drop / replace any header in the redaction set. Case-insensitive on
 * the name. Always emits the redaction sentinel so the schema shape is
 * preserved (downstream tooling can see that a header was present and
 * stripped, vs. truly absent).
 */
export function redactHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (REDACTED_HEADER_NAMES.has(lower)) {
      out[lower] = REDACTED_VALUE;
      continue;
    }
    out[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  return out;
}
