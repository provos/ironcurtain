import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Log entry types
// ---------------------------------------------------------------------------

interface BaseEntry {
  readonly ts: string;
  readonly workflowId: string;
  readonly state: string;
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

/** Discriminated union of all log entry types. */
export type MessageLogEntry =
  | AgentSentEntry
  | AgentReceivedEntry
  | AgentRetryEntry
  | GateRaisedEntry
  | GateResolvedEntry
  | ErrorEntry
  | StateTransitionEntry;

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
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
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
        entries.push(JSON.parse(line) as MessageLogEntry);
      } catch {
        // Skip malformed lines (e.g., truncated writes from crashes)
      }
    }
    return entries;
  }
}
