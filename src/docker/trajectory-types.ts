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
 * cannot classify (and is captured raw). `'openai'` is the OpenAI Responses
 * API stream Codex emits on `chatgpt.com`.
 */
export type CaptureProvider = 'anthropic' | 'openai' | 'unknown';

/**
 * Reason a session was poisoned. See §9 for the full taxonomy.
 *
 * `mid-stream-abort` is retained for backward compatibility with manifests
 * written before transport truncation was demoted to exchange scope. The
 * current writer never emits it as a poison reason: an upstream stream that
 * ends before its terminal event costs exactly ONE exchange, which is
 * dropped and counted in `session-end.abortedExchanges` instead.
 */
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
 * may exist without a matching end — see §9). A `session-poisoned`
 * entry may appear between them, emitted the moment a session is
 * poisoned so the condition is durable on disk before teardown.
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
      readonly event: 'session-poisoned';
      readonly seq: number;
      readonly sessionId: string;
      readonly persona?: string;
      readonly fsmState?: string;
      readonly ts: string;
      readonly poisonReason: PoisonReason;
      /** Records already durable on disk when the session was poisoned. */
      readonly exchanges: number;
      readonly bytesWritten: number;
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
      /**
       * Exchanges lost to an upstream transport truncation (the stream
       * ended before its terminal event, so no faithful record could be
       * built). The rest of the session is unaffected and usable; this
       * counter makes the gap explicit instead of silent. `0` means the
       * session is verifiably gap-free; the field being ABSENT means the
       * manifest predates the counter and gaps are unknown.
       */
      readonly abortedExchanges?: number;
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
  /**
   * Exchanges abandoned before reaching `write()` because their upstream
   * stream truncated. Bundle-wide counterpart of
   * `session-end.abortedExchanges`.
   */
  readonly abortedExchanges: number;
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
