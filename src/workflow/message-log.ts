import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TransientFailureKind } from '../docker/agent-adapter.js';
import type { TerminalWorkflowPhase } from './terminal-phase.js';

// ---------------------------------------------------------------------------
// Log entry types
// ---------------------------------------------------------------------------

interface BaseEntry {
  readonly ts: string;
  readonly workflowId: string;
  readonly state: string;
}

/** Declares that a newly-started attempt will emit a terminal phase barrier. */
interface RunStartedControlEntry extends BaseEntry {
  readonly type: 'run_started';
}

/**
 * Internal attempt boundary. It deliberately is not part of MessageLogEntry:
 * callers reading the public message history should not have to understand
 * workflow-control records.
 */
interface RunResumedControlEntry extends BaseEntry {
  readonly type: 'run_resumed';
  /** mtime of the checkpoint being resumed, used to reject stale terminal data. */
  readonly checkpointMtimeMs?: number;
  /** Exact digest of the checkpoint being resumed (preferred over mtimes). */
  readonly checkpointFingerprint?: string;
}

/** Durable ordering barrier written after the terminal checkpoint attempt. */
interface RunTerminalControlEntry extends BaseEntry {
  readonly type: 'run_terminal';
  readonly phase: TerminalWorkflowPhase;
}

export interface AgentSentEntry extends BaseEntry {
  readonly type: 'agent_sent';
  readonly role: string;
  readonly message: string;
}

export interface AgentReceivedEntry extends BaseEntry {
  readonly type: 'agent_received';
  readonly role: string;
  readonly message: string;
  readonly verdict: string | null;
  readonly confidence: string | null;
}

export type AgentRetryReason =
  | 'missing_status_block'
  | 'malformed_status_block'
  | 'missing_artifacts'
  | 'invalid_verdict'
  | 'upstream_stall';

export interface AgentRetryEntry extends BaseEntry {
  readonly type: 'agent_retry';
  readonly role: string;
  readonly reason: AgentRetryReason;
  readonly details: string;
  readonly retryMessage: string;
}

export interface GateRaisedEntry extends BaseEntry {
  readonly type: 'gate_raised';
  readonly acceptedEvents: readonly string[];
}

export interface GateResolvedEntry extends BaseEntry {
  readonly type: 'gate_resolved';
  readonly event: string;
  readonly prompt: string | null;
}

export interface ErrorEntry extends BaseEntry {
  readonly type: 'error';
  readonly error: string;
  readonly context?: string;
}

export interface StateTransitionEntry extends BaseEntry {
  readonly type: 'state_transition';
  readonly from: string;
  readonly event: string;
}

export interface FanOutJoinEntry extends BaseEntry {
  readonly type: 'fanout_join';
  readonly fanOutState: string;
  readonly workers: number;
  readonly verdict: string | null;
  readonly duplicateRate?: number;
  readonly duplicateCount?: number;
  readonly uniqueCandidates?: number;
  readonly candidateCount?: number;
  readonly children: readonly { readonly index: number; readonly status: string }[];
}

/**
 * Emitted when the adapter detected upstream quota exhaustion and the
 * orchestrator halted the run instead of retrying. `resetAt` is the
 * ISO-formatted provider-advertised reset time when the adapter could
 * parse one; absent when the provider did not supply a machine-readable
 * timestamp. `rawMessage` preserves the original provider/CLI text for
 * humans inspecting the log.
 */
export interface QuotaExhaustedEntry extends BaseEntry {
  readonly type: 'quota_exhausted';
  readonly role: string;
  readonly resetAt?: string;
  readonly rawMessage: string;
}

/**
 * Emitted when the orchestrator halted the run on
 * `AgentResponse.transientFailure`. `rawMessage` preserves the original
 * envelope/stdout for humans inspecting the log.
 */
export interface TransientFailureEntry extends BaseEntry {
  readonly type: 'transient_failure';
  readonly role: string;
  readonly kind: TransientFailureKind;
  readonly rawMessage: string;
}

/** Discriminated union of all log entry types. */
export type MessageLogEntry =
  | AgentSentEntry
  | AgentReceivedEntry
  | AgentRetryEntry
  | GateRaisedEntry
  | GateResolvedEntry
  | ErrorEntry
  | StateTransitionEntry
  | FanOutJoinEntry
  | QuotaExhaustedEntry
  | TransientFailureEntry;

type MessageLogRecord = MessageLogEntry | RunStartedControlEntry | RunResumedControlEntry | RunTerminalControlEntry;

// ---------------------------------------------------------------------------
// MessageLog
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL log for workflow message tracing.
 * Each line is a self-contained JSON object for easy grep/jq inspection.
 */
export class MessageLog {
  constructor(private readonly logPath: string) {
    mkdirSync(dirname(logPath), { recursive: true });
  }

  /** Append a single entry as a JSON line. */
  append(entry: MessageLogEntry): void {
    this.appendRecord(entry);
  }

  /** Declare the terminal-barrier protocol immediately before a new actor starts. */
  appendRunStarted(entry: Omit<RunStartedControlEntry, 'type'>): void {
    this.appendRecord({ ...entry, type: 'run_started' });
  }

  /** Append an internal boundary immediately before a resumed actor starts. */
  appendRunResumed(entry: Omit<RunResumedControlEntry, 'type'>): void {
    this.appendRecord({ ...entry, type: 'run_resumed' });
  }

  /** Append the authoritative terminal phase after terminal persistence. */
  appendRunTerminal(entry: Omit<RunTerminalControlEntry, 'type'>): void {
    this.appendRecord({ ...entry, type: 'run_terminal' });
  }

  /** Read and parse all entries. Skips blank and malformed lines. */
  readAll(): MessageLogEntry[] {
    if (!existsSync(this.logPath)) {
      return [];
    }
    const content = readFileSync(this.logPath, 'utf-8');
    const entries: MessageLogEntry[] = [];
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const record = JSON.parse(line) as MessageLogRecord;
        if (record.type !== 'run_started' && record.type !== 'run_resumed' && record.type !== 'run_terminal') {
          entries.push(record);
        }
      } catch {
        // Skip malformed lines (e.g., truncated writes from crashes)
      }
    }
    return entries;
  }

  private appendRecord(entry: MessageLogRecord): void {
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
  }
}
