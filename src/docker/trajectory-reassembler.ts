/**
 * SSE → final-message reassembly for streaming LLM API responses.
 *
 * The reassembler reads SSE wire bytes and produces a body that is
 * byte-identical to the equivalent non-streaming response. The contract
 * is byte fidelity, not structural equivalence: see §6 invariants in
 * docs/designs/mitm-token-trajectory-capture.md.
 *
 * Critical invariant (§6 #1): the values concatenated into the assembled
 * body must be raw wire substrings. JSON.parse is allowed only to read
 * structural fields (`type`, `index`, `delta.type`); the values themselves
 * are spliced from the wire. There is exactly one JSON.stringify-style
 * serialization in this file — and even that is a substring extraction
 * helper for header/usage fields, not a JSON round-trip on captured
 * content.
 */

import { StringDecoder } from 'node:string_decoder';
import type { CaptureProvider, Reassembler, ReassemblyResult } from './trajectory-types.js';
import { OPENROUTER_HOST } from '../config/user-config.js';

/** Errors thrown by the reassemblers when the stream is unrecoverable. */
export class ReassemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReassemblyError';
  }
}

/**
 * Thrown by `finalize()` when the stream ended before the provider's
 * terminal event was parsed. This is a transport truncation / upstream
 * abort, NOT a reassembly bug — the caller should classify it as
 * `mid-stream-abort` rather than `reassembly-failure` so disconnects don't
 * pollute reassembly-failure metrics.
 */
export class TruncatedStreamError extends ReassemblyError {
  constructor(message: string) {
    super(message);
    this.name = 'TruncatedStreamError';
  }
}

export interface RawEvent {
  readonly eventType: string;
  readonly dataUtf8: string;
  readonly offsetMs: number;
}

/**
 * Provider-agnostic SSE line splitter. Mirrors the line discipline in
 * `sse-extractor.ts` (CRLF or LF treated as a single break) but emits
 * `(eventType, dataPayload)` tuples instead of parsed events. The data
 * payload is the exact bytes after `data: ` — no trim, no parse.
 *
 * Bytes are decoded through a `StringDecoder` so a multibyte UTF-8
 * sequence split across two `feed()` chunks (zlib emits chunks on
 * arbitrary boundaries) is held back until its continuation arrives,
 * rather than each chunk decoding independently to a `U+FFFD`
 * replacement and corrupting the captured body.
 */
export class SseLineSplitter {
  private readonly decoder = new StringDecoder('utf8');
  private buffer = '';
  private currentEventType = '';
  /** Pending `data:` payload for the in-flight event (multi-line dataspec). */
  private currentData: string | null = null;

  feed(chunk: Buffer, sink: (event: string, data: string) => void): void {
    this.buffer += this.decoder.write(chunk);
    let pos = 0;
    while (pos < this.buffer.length) {
      const nextLf = this.buffer.indexOf('\n', pos);
      const nextCr = this.buffer.indexOf('\r', pos);
      let lineEnd: number;
      if (nextLf === -1 && nextCr === -1) break;
      if (nextCr === -1) lineEnd = nextLf;
      else if (nextLf === -1) lineEnd = nextCr;
      else lineEnd = Math.min(nextLf, nextCr);

      const line = this.buffer.slice(pos, lineEnd);
      this.processLine(line, sink);
      pos = lineEnd + 1;
      if (this.buffer[lineEnd] === '\r' && pos < this.buffer.length && this.buffer[pos] === '\n') {
        pos++;
      }
    }
    this.buffer = this.buffer.slice(pos);
  }

  /** Force-flush a trailing line buffer (no terminator). */
  flush(sink: (event: string, data: string) => void): void {
    // Drain any bytes the decoder is still holding. For a complete stream
    // this is empty; for one truncated mid-multibyte it yields the U+FFFD
    // replacement — acceptable, since a truncated stream fails reassembly
    // anyway (the binary-session model discards it).
    this.buffer += this.decoder.end();
    if (this.buffer.length > 0) {
      this.processLine(this.buffer, sink);
      this.buffer = '';
    }
    // Emit any pending event on EOF.
    if (this.currentData !== null) {
      sink(this.currentEventType, this.currentData);
      this.currentData = null;
      this.currentEventType = '';
    }
  }

  private processLine(line: string, sink: (event: string, data: string) => void): void {
    if (line === '') {
      // Empty line = SSE event terminator
      if (this.currentData !== null) {
        sink(this.currentEventType, this.currentData);
      }
      this.currentEventType = '';
      this.currentData = null;
      return;
    }
    if (line.startsWith(':')) {
      // Comment line, ignore
      return;
    }
    if (line.startsWith('event:')) {
      // Per SSE spec, single leading space after `:` is optional and ignored
      let value = line.slice(6);
      if (value.startsWith(' ')) value = value.slice(1);
      this.currentEventType = value;
      return;
    }
    if (line.startsWith('data:')) {
      let value = line.slice(5);
      if (value.startsWith(' ')) value = value.slice(1);
      if (this.currentData === null) {
        this.currentData = value;
      } else {
        // Concatenate multi-line data with newline (per SSE spec, but
        // both Anthropic and OpenAI emit single-line data).
        this.currentData += '\n' + value;
      }
      return;
    }
    // Ignore id:, retry:, and other unknown fields.
  }
}

// =====================================================================
// Helpers for parsing JSON without losing byte fidelity
// =====================================================================

/**
 * Reads a JSON object at `start` of `data`, returning the substring that
 * makes up the value. Tracks brace depth while respecting string escapes
 * — we never need the parsed value, only the raw substring.
 */
export function readJsonValueSubstring(data: string, start: number): string | undefined {
  // Skip leading whitespace
  let i = start;
  while (i < data.length && /\s/.test(data[i] ?? '')) i++;
  if (i >= data.length) return undefined;
  const first = data[i];
  if (first === '"') {
    // String value
    const end = findJsonStringEnd(data, i);
    if (end < 0) return undefined;
    return data.slice(i, end + 1);
  }
  if (first === '{' || first === '[') {
    const close = first === '{' ? '}' : ']';
    let depth = 0;
    let j = i;
    while (j < data.length) {
      const ch = data[j];
      if (ch === '"') {
        const sEnd = findJsonStringEnd(data, j);
        if (sEnd < 0) return undefined;
        j = sEnd + 1;
        continue;
      }
      if (ch === first) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return data.slice(i, j + 1);
      }
      j++;
    }
    return undefined;
  }
  // Primitive (number, true/false/null)
  let j = i;
  while (j < data.length && !/[,}\]\s]/.test(data[j] ?? '')) j++;
  return data.slice(i, j);
}

/** Returns the index of the closing `"` of a JSON string starting at `start`. */
export function findJsonStringEnd(data: string, start: number): number {
  if (data[start] !== '"') return -1;
  let i = start + 1;
  while (i < data.length) {
    const ch = data[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') return i;
    i++;
  }
  return -1;
}

/**
 * Finds a top-level field by name in a JSON object and returns the raw
 * substring of its value. Returns `undefined` if not found.
 *
 * Naïve scan that respects string escapes; sufficient for the
 * well-formed Anthropic/OpenAI envelopes we capture.
 */
export function findFieldValueSubstring(data: string, fieldName: string): string | undefined {
  const needle = `"${fieldName}"`;
  let i = 0;
  while (i < data.length) {
    // Skip strings entirely so a quoted occurrence of fieldName doesn't fool us
    const ch = data[i];
    if (ch === '"') {
      const end = findJsonStringEnd(data, i);
      if (end < 0) return undefined;
      // Check whether this string is our key (followed by `:`)
      if (data.slice(i, end + 1) === needle) {
        let j = end + 1;
        while (j < data.length && /\s/.test(data[j] ?? '')) j++;
        if (data[j] !== ':') {
          // Not our key (some other string), keep scanning
          i = end + 1;
          continue;
        }
        j++;
        return readJsonValueSubstring(data, j);
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return undefined;
}

/**
 * Replaces the value of a top-level field by substring. Locates
 * `"fieldName"` followed by `:`, finds the existing value's substring,
 * and splices in the new value. The new value MUST already be a valid
 * JSON expression (string-with-quotes, object, array, primitive).
 *
 * A generic top-level-field splice — not provider-specific. Shared by
 * the Anthropic envelope-splice (`content`/`stop_reason`/`usage`) and the
 * Responses envelope-splice (`output`). Returns `body` unchanged if the
 * field is absent.
 */
export function replaceTopLevelField(body: string, fieldName: string, newValue: string): string {
  const needle = `"${fieldName}"`;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '"') {
      const end = findJsonStringEnd(body, i);
      if (end < 0) return body;
      if (body.slice(i, end + 1) === needle) {
        let j = end + 1;
        while (j < body.length && /\s/.test(body[j] ?? '')) j++;
        if (body[j] === ':') {
          j++;
          while (j < body.length && /\s/.test(body[j] ?? '')) j++;
          const existing = readJsonValueSubstring(body, j);
          if (existing !== undefined) {
            return body.slice(0, j) + newValue + body.slice(j + existing.length);
          }
        }
      }
      i = end + 1;
      continue;
    }
    i++;
  }
  return body;
}

/**
 * Decodes a JSON string literal (the substring including surrounding
 * quotes) into the raw string it represents. Used for `text` /
 * `thinking` / `signature` payloads where the wire bytes carry escapes
 * we must decode before appending to our concatenation buffer.
 */
export function decodeJsonString(literal: string): string {
  try {
    return JSON.parse(literal) as string;
  } catch {
    return '';
  }
}

/**
 * Re-encodes a string as a JSON string literal (including quotes).
 * Used when assembling the final body — we accept JSON.stringify of a
 * single string value because the captured `text` payload was decoded
 * from the same wire encoding; re-encoding restores byte fidelity to
 * the equivalent non-streaming response (which carries the standard
 * JSON encoding).
 *
 * This is the ONE place strings are JSON-encoded in this file.
 * `tool_use.input` and `tool_calls[].function.arguments` are NEVER
 * encoded this way — they're spliced as raw wire substrings.
 */
export function encodeJsonString(value: string): string {
  return JSON.stringify(value);
}

// =====================================================================
// Scalar-peek helpers (provider-neutral, pure substring readers)
// =====================================================================

/**
 * Reads the `type` discriminator of an SSE data payload. The `type`
 * field in `data` is the authoritative event identifier across both the
 * Anthropic typed-event and OpenAI named-event streams; the SSE
 * `event:` line is advisory.
 */
export function peekTypeField(data: string): string | undefined {
  return peekStringField(data, 'type');
}

/** Reads a top-level JSON string field, decoded. Returns `undefined` if absent or not a string. */
export function peekStringField(data: string, name: string): string | undefined {
  const raw = findFieldValueSubstring(data, name);
  if (raw === undefined || !raw.startsWith('"')) return undefined;
  return decodeJsonString(raw);
}

/** Reads a top-level JSON number field. Returns `undefined` if absent or non-finite. */
export function peekNumberField(data: string, name: string): number | undefined {
  const raw = findFieldValueSubstring(data, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// =====================================================================
// Abstract SSE reassembler base
// =====================================================================

/**
 * Shared SSE reassembler skeleton. Owns the boilerplate every provider's
 * state machine needs — splitter feeding, event log, started-at clock,
 * fail latching, and the finalize gating — and exposes three seams the
 * subclasses implement:
 *
 *   - `dispatch(eventType, data)`: route a single SSE event into provider
 *     state. May throw to latch a fatal reassembly failure.
 *   - `terminalSeen()`: true once the provider's terminal event was
 *     parsed (`message_stop`, `[DONE]`, or `response.completed`). Gates
 *     both finalize success and the `canFinalize()` lifecycle signal.
 *   - `assembleResult()`: build the final body + structured fields. May
 *     throw `ReassemblyError`; the base does NOT catch it so the tap can
 *     distinguish a reassembly failure from success.
 *
 * The base intentionally holds NO envelope-splice machinery — the
 * providers assemble differently (Anthropic splices a message envelope,
 * the OpenAI Responses reassembler assembles from item-done payloads), so
 * that logic stays subclass-private.
 */
export abstract class AbstractSseReassembler implements Reassembler {
  protected readonly splitter = new SseLineSplitter();
  protected readonly events: RawEvent[] = [];
  protected readonly startedAt: number = Date.now();
  protected failed = false;
  protected failureReason?: string;

  push(chunk: Buffer): void {
    if (this.failed) return;
    this.splitter.feed(chunk, (eventType, data) => this.onEvent(eventType, data));
  }

  finalize(): ReassemblyResult {
    this.splitter.flush((eventType, data) => this.onEvent(eventType, data));
    if (this.failed) {
      throw new ReassemblyError(this.failureReason ?? 'reassembly failed');
    }
    if (!this.terminalSeen()) {
      throw new TruncatedStreamError('stream ended without terminal event');
    }
    return this.assembleResult();
  }

  /**
   * True once the terminal event has been parsed. Lets the tap finalize a
   * complete-but-socket-aborted stream instead of poisoning it.
   */
  canFinalize(): boolean {
    return this.terminalSeen();
  }

  private onEvent(eventType: string, data: string): void {
    this.events.push({ eventType, dataUtf8: data, offsetMs: Date.now() - this.startedAt });
    if (this.failed) return;
    try {
      this.dispatch(eventType, data);
    } catch (err) {
      this.failed = true;
      this.failureReason = err instanceof Error ? err.message : String(err);
    }
  }

  protected abstract dispatch(eventType: string, data: string): void;
  protected abstract terminalSeen(): boolean;
  protected abstract assembleResult(): ReassemblyResult;
}

// =====================================================================
// Anthropic
// =====================================================================

type AnthropicBlockState =
  | { kind: 'text'; openRaw: string; textChunks: string[] }
  | { kind: 'tool_use'; openRaw: string; partialJsonChunks: string[]; idRaw?: string; nameRaw?: string }
  | { kind: 'thinking'; openRaw: string; thinkingChunks: string[]; signatureChunks: string[] }
  | { kind: 'redacted_thinking'; openRaw: string }
  | { kind: 'other'; openRaw: string; rawDeltas: string[] };

export class AnthropicReassembler extends AbstractSseReassembler {
  /**
   * Envelope captured from `message_start.message` — used to extract
   * top-level fields (id, type, role, model, etc.). We splice the
   * assembled content array between the message-envelope prefix and
   * suffix so the assembled body is byte-identical to a non-streaming
   * response.
   */
  private messageEnvelope?: string;
  private blocks = new Map<number, AnthropicBlockState>();
  private stopReason?: string;
  private stopSequence?: string;
  private usageRaw?: string;
  private providerRequestId?: string;
  private modelFingerprint?: string;
  private receivedMessageStop = false;

  protected terminalSeen(): boolean {
    return this.receivedMessageStop;
  }

  protected assembleResult(): ReassemblyResult {
    if (!this.messageEnvelope) {
      throw new ReassemblyError('anthropic stream missing message_start envelope');
    }
    const bodyUtf8 = this.assembleBody();
    const usage = this.parseUsage();
    return {
      bodyUtf8,
      providerRequestId: this.providerRequestId,
      stopReason: this.stopReason,
      modelFingerprint: this.modelFingerprint,
      usage,
      events: this.events,
    };
  }

  protected dispatch(eventType: string, data: string): void {
    // The `type` field in `data` is the authoritative event identifier;
    // SSE `event:` lines are advisory.
    const type = peekTypeField(data) ?? eventType;
    switch (type) {
      case 'message_start':
        this.onMessageStart(data);
        return;
      case 'content_block_start':
        this.onContentBlockStart(data);
        return;
      case 'content_block_delta':
        this.onContentBlockDelta(data);
        return;
      case 'content_block_stop':
        this.onContentBlockStop(data);
        return;
      case 'message_delta':
        this.onMessageDelta(data);
        return;
      case 'message_stop':
        this.receivedMessageStop = true;
        return;
      case 'ping':
      case 'error':
      default:
        // Other events (ping, error, unknown) are recorded in this.events
        // but don't affect reassembly. An error event leaves the stream
        // incomplete — message_stop is what gates success.
        return;
    }
  }

  private onMessageStart(data: string): void {
    const messageRaw = findFieldValueSubstring(data, 'message');
    if (!messageRaw) {
      throw new ReassemblyError('message_start missing `message` field');
    }
    this.messageEnvelope = messageRaw;
    const id = peekStringField(messageRaw, 'id');
    if (id) this.providerRequestId = id;
  }

  private onContentBlockStart(data: string): void {
    const index = peekNumberField(data, 'index');
    const blockRaw = findFieldValueSubstring(data, 'content_block');
    if (index === undefined || blockRaw === undefined) {
      throw new ReassemblyError('content_block_start missing index or content_block');
    }
    const kind = peekStringField(blockRaw, 'type');
    let state: AnthropicBlockState;
    if (kind === 'text') {
      state = { kind: 'text', openRaw: blockRaw, textChunks: [] };
    } else if (kind === 'tool_use') {
      const idRaw = findFieldValueSubstring(blockRaw, 'id');
      const nameRaw = findFieldValueSubstring(blockRaw, 'name');
      state = { kind: 'tool_use', openRaw: blockRaw, partialJsonChunks: [], idRaw, nameRaw };
    } else if (kind === 'thinking') {
      state = { kind: 'thinking', openRaw: blockRaw, thinkingChunks: [], signatureChunks: [] };
    } else if (kind === 'redacted_thinking') {
      state = { kind: 'redacted_thinking', openRaw: blockRaw };
    } else {
      state = { kind: 'other', openRaw: blockRaw, rawDeltas: [] };
    }
    this.blocks.set(index, state);
  }

  private onContentBlockDelta(data: string): void {
    const index = peekNumberField(data, 'index');
    const deltaRaw = findFieldValueSubstring(data, 'delta');
    if (index === undefined || deltaRaw === undefined) {
      throw new ReassemblyError('content_block_delta missing index or delta');
    }
    const block = this.blocks.get(index);
    if (!block) {
      throw new ReassemblyError(`content_block_delta for unknown index ${index}`);
    }
    const deltaType = peekStringField(deltaRaw, 'type');
    if (block.kind === 'text' && deltaType === 'text_delta') {
      const literal = findFieldValueSubstring(deltaRaw, 'text');
      if (literal) block.textChunks.push(decodeJsonString(literal));
      return;
    }
    if (block.kind === 'tool_use' && deltaType === 'input_json_delta') {
      const literal = findFieldValueSubstring(deltaRaw, 'partial_json');
      if (literal) {
        // partial_json is a JSON string literal on the wire whose decoded
        // value is a fragment of the final tool_use.input JSON object.
        // We decode to obtain the raw fragment and accumulate it verbatim
        // — concatenation reconstructs the original input bytes (§5).
        block.partialJsonChunks.push(decodeJsonString(literal));
      }
      return;
    }
    if (block.kind === 'thinking') {
      if (deltaType === 'thinking_delta') {
        const literal = findFieldValueSubstring(deltaRaw, 'thinking');
        if (literal) block.thinkingChunks.push(decodeJsonString(literal));
        return;
      }
      if (deltaType === 'signature_delta') {
        const literal = findFieldValueSubstring(deltaRaw, 'signature');
        if (literal) block.signatureChunks.push(decodeJsonString(literal));
        return;
      }
    }
    if (block.kind === 'other') {
      block.rawDeltas.push(deltaRaw);
      return;
    }
    // Unknown delta type for known block: record but don't fail (the
    // wire format may add new delta types over time).
  }

  private onContentBlockStop(data: string): void {
    const index = peekNumberField(data, 'index');
    if (index === undefined) {
      throw new ReassemblyError('content_block_stop missing index');
    }
    if (!this.blocks.has(index)) {
      throw new ReassemblyError(`content_block_stop for unknown index ${index}`);
    }
  }

  private onMessageDelta(data: string): void {
    const deltaRaw = findFieldValueSubstring(data, 'delta');
    if (deltaRaw) {
      const stopReasonRaw = findFieldValueSubstring(deltaRaw, 'stop_reason');
      if (stopReasonRaw !== undefined) {
        if (stopReasonRaw.startsWith('"')) {
          this.stopReason = decodeJsonString(stopReasonRaw);
        }
      }
      const stopSequenceRaw = findFieldValueSubstring(deltaRaw, 'stop_sequence');
      if (stopSequenceRaw !== undefined) {
        this.stopSequence = stopSequenceRaw;
      }
    }
    const usageRaw = findFieldValueSubstring(data, 'usage');
    if (usageRaw) this.usageRaw = usageRaw;
  }

  /**
   * Assembles the final non-streaming message body from the captured
   * state. Constructed via raw substring concatenation — see §6 invariant
   * #1.
   *
   * Strategy: the `message` envelope from `message_start` already has
   * the shape of a non-streaming response, but with empty content,
   * stop_reason: null, stop_sequence: null, and a partial usage. We
   * mutate three fields by substring replacement:
   *   - "content":[]  → "content":[<blocks>]
   *   - "stop_reason":null → "stop_reason":"<reason>"
   *   - "stop_sequence":null → "stop_sequence":<value>
   *   - "usage":{<initial>} → "usage":<final-from-message_delta>
   */
  private assembleBody(): string {
    if (!this.messageEnvelope) {
      throw new ReassemblyError('cannot assemble: missing envelope');
    }
    let body = this.messageEnvelope;
    body = replaceTopLevelField(body, 'content', this.assembleContentArray());
    if (this.stopReason !== undefined) {
      body = replaceTopLevelField(body, 'stop_reason', encodeJsonString(this.stopReason));
    }
    if (this.stopSequence !== undefined) {
      body = replaceTopLevelField(body, 'stop_sequence', this.stopSequence);
    }
    if (this.usageRaw !== undefined) {
      body = replaceTopLevelField(body, 'usage', this.usageRaw);
    }
    return body;
  }

  private assembleContentArray(): string {
    const sortedIndices = [...this.blocks.keys()].sort((a, b) => a - b);
    const parts: string[] = [];
    for (const idx of sortedIndices) {
      const block = this.blocks.get(idx);
      if (!block) continue;
      parts.push(this.assembleBlock(block));
    }
    return `[${parts.join(',')}]`;
  }

  private assembleBlock(block: AnthropicBlockState): string {
    if (block.kind === 'text') {
      const text = block.textChunks.join('');
      return `{"type":"text","text":${encodeJsonString(text)}}`;
    }
    if (block.kind === 'tool_use') {
      const inputJson = block.partialJsonChunks.join('') || '{}';
      // The block's openRaw carries id and name; reuse them as raw
      // substrings to preserve byte fidelity (e.g., id ordering).
      const idPart = block.idRaw ?? '""';
      const namePart = block.nameRaw ?? '""';
      return `{"type":"tool_use","id":${idPart},"name":${namePart},"input":${inputJson}}`;
    }
    if (block.kind === 'thinking') {
      const thinking = block.thinkingChunks.join('');
      const signature = block.signatureChunks.join('');
      return `{"type":"thinking","thinking":${encodeJsonString(thinking)},"signature":${encodeJsonString(signature)}}`;
    }
    if (block.kind === 'redacted_thinking') {
      return block.openRaw;
    }
    return block.openRaw;
  }

  private parseUsage(): Readonly<Record<string, unknown>> | undefined {
    if (!this.usageRaw) return undefined;
    try {
      const parsed = JSON.parse(this.usageRaw) as Record<string, unknown>;
      return parsed;
    } catch {
      return undefined;
    }
  }
}

// =====================================================================
// OpenAI Responses API (chatgpt.com /backend-api/codex/responses)
// =====================================================================

interface ResponsesItemState {
  outputIndex: number;
  /** Complete item JSON spliced verbatim from response.output_item.done. */
  doneRaw?: string;
  /** Per-content-index accumulated output_text fragments (cross-check). */
  readonly textChunksByContentIndex: Map<number, string[]>;
  /**
   * Per-content-index `text` from `response.output_text.done` (the
   * provider's own delta-join). Cross-checked against our delta-join.
   */
  readonly doneTextByContentIndex: Map<number, string>;
}

/**
 * Reassembler for the OpenAI Responses API stream that Codex emits on
 * chatgpt.com. Named `response.*` events; an item tree addressed by
 * `output_index` (and content parts by `content_index`).
 *
 * The terminal `response.completed` carries the FULL response envelope
 * (~35 fields: status, usage, instructions, tools, ...) but with its
 * `output` array EMPTY. So the final body is the VERBATIM terminal
 * envelope (zero re-encode, all fields preserved) with its empty
 * `"output":[]` spliced to the assembled `response.output_item.done`
 * payloads (each a COMPLETE item JSON object on the wire, spliced
 * VERBATIM, in output_index order). providerRequestId/stopReason/usage
 * derive from that same envelope. The accumulated `output_text` deltas
 * are cross-checked against the item-done text (delta-join must equal
 * the item text) — a mismatch throws so the binary-session model poisons
 * `reassembly-failure` rather than silently trusting item.done.
 */
export class ResponsesReassembler extends AbstractSseReassembler {
  private completedSeen = false;
  private status?: string;
  private usageRaw?: string;
  private providerRequestId?: string;
  private modelFingerprint?: string;
  /** Verbatim `response` envelope from the terminal event (output[] empty). */
  private responseEnvelopeRaw?: string;
  /**
   * Stop reason for the record. Equals `status` for a completed response;
   * for `incomplete`/`failed` prefers the more specific
   * `incomplete_details.reason` / `error` reason when present (FIX 4).
   */
  private stopReasonValue?: string;
  private readonly items = new Map<number, ResponsesItemState>();

  protected terminalSeen(): boolean {
    return this.completedSeen;
  }

  protected dispatch(eventType: string, data: string): void {
    const type = peekTypeField(data) ?? eventType;
    switch (type) {
      case 'response.created':
        this.onResponseCreated(data);
        return;
      case 'response.output_item.added':
        this.onOutputItemAdded(data);
        return;
      case 'response.output_text.delta':
        this.onOutputTextDelta(data);
        return;
      case 'response.output_text.done':
        this.onOutputTextDone(data);
        return;
      case 'response.output_item.done':
        this.onOutputItemDone(data);
        return;
      case 'response.completed':
      case 'response.failed':
      case 'response.incomplete':
        this.onTerminal(data);
        return;
      default:
        // response.in_progress, response.content_part.added/.done, and any
        // future events are recorded in this.events but don't change
        // assembly state.
        return;
    }
  }

  private onResponseCreated(data: string): void {
    const responseRaw = findFieldValueSubstring(data, 'response');
    if (!responseRaw) return;
    const id = peekStringField(responseRaw, 'id');
    if (id) this.providerRequestId = id;
    const model = peekStringField(responseRaw, 'model');
    if (model) this.modelFingerprint = model;
  }

  private getItem(outputIndex: number): ResponsesItemState {
    let item = this.items.get(outputIndex);
    if (!item) {
      item = {
        outputIndex,
        textChunksByContentIndex: new Map<number, string[]>(),
        doneTextByContentIndex: new Map<number, string>(),
      };
      this.items.set(outputIndex, item);
    }
    return item;
  }

  private onOutputItemAdded(data: string): void {
    const outputIndex = peekNumberField(data, 'output_index');
    if (outputIndex === undefined) {
      throw new ReassemblyError('response.output_item.added missing output_index');
    }
    this.getItem(outputIndex);
  }

  private onOutputTextDelta(data: string): void {
    const outputIndex = peekNumberField(data, 'output_index');
    const contentIndex = peekNumberField(data, 'content_index') ?? 0;
    if (outputIndex === undefined) return;
    const item = this.getItem(outputIndex);
    const literal = findFieldValueSubstring(data, 'delta');
    if (literal === undefined || !literal.startsWith('"')) return;
    let chunks = item.textChunksByContentIndex.get(contentIndex);
    if (!chunks) {
      chunks = [];
      item.textChunksByContentIndex.set(contentIndex, chunks);
    }
    chunks.push(decodeJsonString(literal));
  }

  private onOutputTextDone(data: string): void {
    const outputIndex = peekNumberField(data, 'output_index');
    const contentIndex = peekNumberField(data, 'content_index') ?? 0;
    if (outputIndex === undefined) return;
    const text = peekStringField(data, 'text');
    if (text === undefined) return;
    this.getItem(outputIndex).doneTextByContentIndex.set(contentIndex, text);
  }

  private onOutputItemDone(data: string): void {
    const outputIndex = peekNumberField(data, 'output_index');
    const itemRaw = findFieldValueSubstring(data, 'item');
    if (outputIndex === undefined || itemRaw === undefined) {
      throw new ReassemblyError('response.output_item.done missing output_index or item');
    }
    this.getItem(outputIndex).doneRaw = itemRaw;
  }

  private onTerminal(data: string): void {
    const responseRaw = findFieldValueSubstring(data, 'response');
    if (responseRaw) {
      // Capture the FULL envelope verbatim — assembleBody splices the
      // assembled item array into its empty output[] (zero re-encode).
      this.responseEnvelopeRaw = responseRaw;
      const status = peekStringField(responseRaw, 'status');
      if (status) this.status = status;
      this.stopReasonValue = deriveResponsesStopReason(responseRaw, status);
      const usageRaw = findFieldValueSubstring(responseRaw, 'usage');
      if (usageRaw !== undefined && usageRaw !== 'null') this.usageRaw = usageRaw;
    }
    this.completedSeen = true;
  }

  protected assembleResult(): ReassemblyResult {
    this.crossCheckDeltasAgainstItems();
    const bodyUtf8 = this.assembleBody();
    return {
      bodyUtf8,
      providerRequestId: this.providerRequestId,
      stopReason: this.stopReasonValue,
      modelFingerprint: this.modelFingerprint,
      usage: this.parseUsage(),
      events: this.events,
    };
  }

  /**
   * Cross-check (FIX 3): the per-content-index delta-join must equal the
   * text the provider reported in `response.output_text.done` and/or the
   * `output_item.done` message content. The verbatim-item-splice strategy
   * trusts `output_item.done` as self-contained; this guard fails LOUD
   * (throws → the binary-session model poisons `reassembly-failure`)
   * rather than silently emitting a body whose final text disagrees with
   * the streamed deltas.
   */
  private crossCheckDeltasAgainstItems(): void {
    for (const item of this.items.values()) {
      for (const [contentIndex, chunks] of item.textChunksByContentIndex) {
        const deltaJoin = chunks.join('');
        const doneText = item.doneTextByContentIndex.get(contentIndex);
        if (doneText !== undefined && doneText !== deltaJoin) {
          throw new ReassemblyError(
            `responses delta/done mismatch at output_index ${item.outputIndex} ` +
              `content_index ${contentIndex} (output_text.done)`,
          );
        }
        const itemText = item.doneRaw !== undefined ? extractItemContentText(item.doneRaw, contentIndex) : undefined;
        if (itemText !== undefined && itemText !== deltaJoin) {
          throw new ReassemblyError(
            `responses delta/item mismatch at output_index ${item.outputIndex} ` +
              `content_index ${contentIndex} (output_item.done)`,
          );
        }
      }
    }
  }

  /**
   * Byte-faithful body (FIX 2): the verbatim terminal `response` envelope
   * with its empty `"output":[]` spliced to the assembled item array.
   * Falls back to a minimal synthesized envelope only if the terminal
   * event carried no `response` (defensive; the stream-without-terminal
   * case is already gated by `terminalSeen()` before assembly).
   */
  private assembleBody(): string {
    const sorted = [...this.items.keys()].sort((a, b) => a - b);
    const itemParts: string[] = [];
    for (const idx of sorted) {
      const item = this.items.get(idx);
      if (!item?.doneRaw) continue;
      itemParts.push(item.doneRaw);
    }
    const outputArray = `[${itemParts.join(',')}]`;
    if (this.responseEnvelopeRaw !== undefined) {
      return replaceTopLevelField(this.responseEnvelopeRaw, 'output', outputArray);
    }
    // Defensive fallback: terminal lacked a `response` envelope. Synthesize
    // a minimal one from the captured leaves.
    const parts: string[] = [];
    if (this.providerRequestId !== undefined) {
      parts.push(`"id":${encodeJsonString(this.providerRequestId)}`);
    }
    parts.push('"object":"response"');
    parts.push(`"status":${this.status !== undefined ? encodeJsonString(this.status) : 'null'}`);
    parts.push(`"output":${outputArray}`);
    parts.push(`"usage":${this.usageRaw ?? 'null'}`);
    return `{${parts.join(',')}}`;
  }

  private parseUsage(): Readonly<Record<string, unknown>> | undefined {
    if (!this.usageRaw) return undefined;
    try {
      return JSON.parse(this.usageRaw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
}

/**
 * Derive the Responses stop reason (FIX 4). For a `completed` response
 * the status IS the stop reason. For `incomplete` / `failed` the status
 * alone is uninformative, so prefer the more specific
 * `incomplete_details.reason` (incomplete) or the `error` reason/code
 * (failed) when the envelope carries one. Falls back to status.
 */
function deriveResponsesStopReason(responseRaw: string, status: string | undefined): string | undefined {
  if (status === 'incomplete') {
    const details = findFieldValueSubstring(responseRaw, 'incomplete_details');
    if (details !== undefined && details !== 'null') {
      const reason = peekStringField(details, 'reason');
      if (reason !== undefined) return reason;
    }
  }
  if (status === 'failed') {
    const error = findFieldValueSubstring(responseRaw, 'error');
    if (error !== undefined && error !== 'null') {
      const reason = peekStringField(error, 'code') ?? peekStringField(error, 'type');
      if (reason !== undefined) return reason;
    }
  }
  return status;
}

/**
 * Extract the `text` of the `output_text` content part at `contentIndex`
 * from a verbatim `output_item.done` item substring, decoded. Returns
 * `undefined` if the item has no `content` array or no matching part —
 * the cross-check skips items it cannot read (e.g. non-message items).
 */
function extractItemContentText(itemRaw: string, contentIndex: number): string | undefined {
  const contentRaw = findFieldValueSubstring(itemRaw, 'content');
  if (contentRaw === undefined || !contentRaw.startsWith('[')) return undefined;
  const parts = splitJsonArrayElements(contentRaw);
  if (contentIndex < 0 || contentIndex >= parts.length) return undefined;
  return peekStringField(parts[contentIndex], 'text');
}

/**
 * Split a raw JSON array substring (including the surrounding brackets)
 * into its top-level element substrings, verbatim. Respects nested
 * objects/arrays and string escapes. Returns `[]` for an empty array.
 */
function splitJsonArrayElements(arrayRaw: string): string[] {
  const elements: string[] = [];
  let i = 1; // skip leading '['
  while (i < arrayRaw.length) {
    while (i < arrayRaw.length && /[\s,]/.test(arrayRaw[i] ?? '')) i++;
    if (i >= arrayRaw.length || arrayRaw[i] === ']') break;
    const element = readJsonValueSubstring(arrayRaw, i);
    if (element === undefined) break;
    elements.push(element);
    i += element.length;
  }
  return elements;
}

/**
 * Classify an upstream host into a capture provider. Single source of
 * truth for host → provider mapping across the capture pipeline (the
 * `ExchangeRecord.provider` field and reassembler selection).
 *
 * Note: `provider:'openai'` spans two wire formats — `api.openai.com`
 * Chat Completions and `chatgpt.com` Responses — disambiguated by the
 * record's `host` field. `auth.openai.com` intentionally stays
 * `'unknown'`: it is an OAuth/identity host, not a completion host, so
 * do NOT broaden this to map all `*.openai.com` to `'openai'` (that would
 * route a non-completion host to a reassembler).
 */
export function providerForHost(host: string, path?: string): CaptureProvider {
  const normalized = host.toLowerCase();
  if (normalized === 'api.anthropic.com') return 'anthropic';
  if (normalized === 'api.openai.com') return 'openai';
  if (normalized === 'chatgpt.com') return 'openai';
  // OpenRouter serves three wire formats on one host, disambiguated by path
  // (§11.2). The Anthropic skin is 'anthropic'; the OpenAI-shape Responses and
  // Chat Completions paths are 'openai' (Chat Completions is raw-capture-only —
  // see createReassembler).
  if (normalized === OPENROUTER_HOST) {
    const p = (path ?? '').split('?')[0];
    return p.endsWith('/messages') ? 'anthropic' : 'openai';
  }
  return 'unknown';
}

/**
 * Pick a reassembler by upstream host. Routing is BY HOST so a specific
 * wire format maps to its state machine. Both OpenAI Responses surfaces —
 * `chatgpt.com/backend-api/codex/responses` (Codex via ChatGPT OAuth) and
 * `api.openai.com/v1/responses` (the platform Responses API, e.g. Codex
 * authenticated with an API key) — share the same wire format, so both use
 * `ResponsesReassembler`. Note: the classic Chat Completions API
 * (`/v1/chat/completions`) is NOT a path any IronCurtain harness uses, so
 * `openaiProvider` does not capture it. Unclassifiable hosts yield
 * `undefined`; the caller falls back to capturing raw bytes verbatim.
 */
export function createReassembler(host: string, path?: string): Reassembler | undefined {
  const h = host.toLowerCase();
  if (h === 'api.anthropic.com') return new AnthropicReassembler();
  if (h === 'chatgpt.com' || h === 'api.openai.com') return new ResponsesReassembler();
  // OpenRouter, disambiguated by path (§11.2): the Anthropic skin reassembles
  // as Anthropic; `/api/v1/responses` reuses the Responses reassembler;
  // `/api/v1/chat/completions` has no reassembler (raw-bytes capture, v0).
  if (h === OPENROUTER_HOST) {
    const p = (path ?? '').split('?')[0];
    if (p.endsWith('/messages')) return new AnthropicReassembler();
    if (p.endsWith('/responses')) return new ResponsesReassembler();
    return undefined;
  }
  return undefined;
}
