/**
 * Pure logic for the claude.ai conversation-export corpus builder.
 *
 * Everything here is side-effect free and content-free in its outputs (no fact
 * text, no transcript text leaks into logs or progress artifacts). It is unit
 * tested in isolation with synthetic fixtures — no DB, no LLM, no filesystem.
 *
 * The I/O driver that wires these helpers to the memory engine lives in
 * `build-corpus.ts`.
 */

// ---------- Export shapes (subset of the claude.ai export schema) ----------

/** A single message inside a conversation export. Only the fields we read. */
export interface ExportMessage {
  uuid: string;
  /** SENSITIVE content. Never logged or written to an artifact. */
  text: string;
  sender: string;
}

/** A single conversation in the export array. Only the fields we read. */
export interface ExportConversation {
  uuid: string;
  /** SENSITIVE content. Never logged or written to an artifact. */
  created_at: string;
  /** Optional because it comes from untrusted JSON; absent ⇒ treated as empty. */
  chat_messages?: ExportMessage[];
}

// ---------- Transcript assembly ----------

/**
 * Build a transcript from a conversation's messages: one `${sender}: ${text}`
 * line per message with non-empty `text`, joined by newlines. Messages whose
 * `text` is empty/whitespace are dropped (some messages carry only structured
 * `content`/attachments). We deliberately use `text`, never `content`.
 */
export function assembleTranscript(conversation: ExportConversation): string {
  return nonEmptyMessages(conversation)
    .map((msg) => `${msg.sender}: ${msg.text}`)
    .join('\n');
}

function nonEmptyMessages(conversation: ExportConversation): ExportMessage[] {
  const messages = conversation.chat_messages ?? [];
  return messages.filter((msg) => typeof msg.text === 'string' && msg.text.trim().length > 0);
}

/**
 * A conversation is empty for our purposes when it has no messages with
 * non-empty `text`. These are skipped (recorded as `skipped-empty`).
 */
export function isEmptyConversation(conversation: ExportConversation): boolean {
  return nonEmptyMessages(conversation).length === 0;
}

/**
 * Provenance string stamped on every fact extracted from a conversation, e.g.
 * `claude-export:3f2a...`. The uuid is an opaque identifier, not content.
 */
export function buildSource(uuid: string): string {
  return `claude-export:${uuid}`;
}

/**
 * Resolve a conversation's `created_at` (ISO 8601) to an epoch-ms `as_of`.
 * Returns `undefined` for a missing/unparseable timestamp so the engine falls
 * back to `Date.now()` instead of stamping `NaN` into the INTEGER column (which
 * would corrupt the recency spread the corpus depends on). The timestamp is not
 * sensitive content, so the caller may warn with the uuid.
 */
export function resolveAsOf(createdAt: string | undefined): number | undefined {
  if (typeof createdAt !== 'string') return undefined;
  const epoch = Date.parse(createdAt);
  return Number.isFinite(epoch) ? epoch : undefined;
}

// ---------- Progress records (content-free) ----------

/**
 * Terminal status for one conversation. Every value is content-free.
 * - `ingested`  — facts written (no chunk failures)
 * - `partial`   — some chunks failed but others produced facts
 * - `skipped-empty`  — the conversation had no non-empty messages
 * - `skipped-failed` — extraction yielded nothing (on_extraction_failure='skip')
 */
export type ConversationStatus = 'ingested' | 'partial' | 'skipped-empty' | 'skipped-failed';

/** One line in `progress.jsonl`. COUNTS ONLY — never fact text or transcript. */
export interface ProgressRecord {
  uuid: string;
  status: ConversationStatus;
  created: number;
  merged: number;
  facts: number;
  failed_chunks: number;
  chunks: number;
}

/** The subset of an `IngestResult` the progress builder reads. */
export interface IngestResultLike {
  created: number;
  merged: number;
  facts: { length: number };
  chunks?: number;
  failed_chunks?: number;
  partial?: boolean;
  skipped?: boolean;
}

/**
 * Map an ingest result to a content-free progress record. `status` is
 * skipped-failed when the result is `skipped`, partial when `partial`, else
 * ingested. The fact count comes from `facts.length` (a count, never text).
 */
export function buildProgressRecord(uuid: string, result: IngestResultLike): ProgressRecord {
  const status: ConversationStatus = result.skipped ? 'skipped-failed' : result.partial ? 'partial' : 'ingested';
  return {
    uuid,
    status,
    created: result.created,
    merged: result.merged,
    facts: result.facts.length,
    failed_chunks: result.failed_chunks ?? 0,
    chunks: result.chunks ?? 1,
  };
}

/** Progress record for a conversation skipped because it had no content. */
export function buildEmptyProgressRecord(uuid: string): ProgressRecord {
  return { uuid, status: 'skipped-empty', created: 0, merged: 0, facts: 0, failed_chunks: 0, chunks: 0 };
}

// ---------- Resume-set computation ----------

/** Statuses that count as "done" for resume — only `skipped-failed` is retried. */
const RESUME_DONE_STATUSES: ReadonlySet<ConversationStatus> = new Set<ConversationStatus>([
  'ingested',
  'partial',
  'skipped-empty',
]);

/**
 * Given the records already in the progress file, compute the set of conversation
 * uuids to skip on `--resume`. A uuid is skipped if any of its records has a
 * "done" status; `skipped-failed`-only uuids are retried (not in the set).
 */
export function computeResumeSet(records: readonly ProgressRecord[]): Set<string> {
  const skip = new Set<string>();
  for (const record of records) {
    if (RESUME_DONE_STATUSES.has(record.status)) {
      skip.add(record.uuid);
    }
  }
  return skip;
}

// ---------- Engine env wiring ----------

/**
 * Wire the `MEMORY_*` env vars that point the engine's LLM client at Anthropic's
 * Haiku, plus the namespace and a disabled reranker. Both drivers call this
 * BEFORE `loadConfig()`. Requires `ANTHROPIC_API_KEY` (we REQUIRE the LLM for the
 * corpus/diagnostic — no silent degrade) and throws a clear error if it's absent.
 *
 * The base URL and default model are pinned here so the two drivers can never
 * drift apart. Determinism vars (db path, maintenance interval, decay threshold)
 * are the build driver's concern and stay there.
 */
export function wireMemoryLlmEnv(namespace: string): void {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      'ANTHROPIC_API_KEY is required (the corpus needs the LLM). ' +
        'Run with `--import dotenv/config` or export it in the environment.',
    );
  }
  process.env.MEMORY_LLM_BASE_URL = 'https://api.anthropic.com/v1/';
  process.env.MEMORY_LLM_API_KEY = apiKey;
  process.env.MEMORY_LLM_MODEL = process.env.MEMORY_LLM_MODEL ?? 'claude-haiku-4-5-20251001';
  process.env.MEMORY_NAMESPACE = namespace;
  process.env.MEMORY_RERANKER_ENABLED = 'false';
}

// ---------- Argument parsing ----------

export interface CliArgs {
  exportPath: string;
  dbPath: string;
  namespace: string;
  /** Process only the first N non-empty conversations; undefined ⇒ all. */
  limit?: number;
  /** Process only this conversation uuid; undefined ⇒ all. */
  conversation?: string;
  dryRun: boolean;
  resume: boolean;
  help: boolean;
}

export const DEFAULT_ARGS: Readonly<Pick<CliArgs, 'exportPath' | 'dbPath' | 'namespace'>> = {
  exportPath: 'donotcommit/claude-export/conversations.json',
  dbPath: 'donotcommit/corpus/memories.memdb',
  namespace: 'claude-export',
};

/**
 * Parse the driver's CLI flags. Throws on a missing value for a flag that needs
 * one, or on an unrecognized flag, so a typo fails loudly instead of silently
 * running against the wrong target.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    exportPath: DEFAULT_ARGS.exportPath,
    dbPath: DEFAULT_ARGS.dbPath,
    namespace: DEFAULT_ARGS.namespace,
    dryRun: false,
    resume: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    switch (flag) {
      case '--export':
        args.exportPath = requireValue(argv, (i += 1), flag);
        break;
      case '--db':
        args.dbPath = requireValue(argv, (i += 1), flag);
        break;
      case '--namespace':
        args.namespace = requireValue(argv, (i += 1), flag);
        break;
      case '--limit':
        args.limit = parsePositiveInt(requireValue(argv, (i += 1), flag), flag);
        break;
      case '--conversation':
        args.conversation = requireValue(argv, (i += 1), flag);
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--resume':
        args.resume = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`Unknown flag: ${flag}`);
    }
  }

  return args;
}

/**
 * Read the value following a flag at `index`, or throw if absent / itself a flag.
 * Shared by both driver scripts' `parseArgs`.
 */
export function requireValue(argv: readonly string[], index: number, flag: string): string {
  if (index >= argv.length) {
    throw new Error(`Flag ${flag} requires a value`);
  }
  const value = argv[index];
  if (value.startsWith('--')) {
    throw new Error(`Flag ${flag} requires a value`);
  }
  return value;
}

/** Parse a strictly-positive integer flag value, or throw. Shared by both drivers. */
export function parsePositiveInt(raw: string, flag: string): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Flag ${flag} requires a positive integer, got: ${raw}`);
  }
  return parsed;
}
