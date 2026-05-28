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

import type { Reassembler, ReassemblyResult } from './trajectory-types.js';

/** Errors thrown by the reassemblers when the stream is unrecoverable. */
export class ReassemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReassemblyError';
  }
}

interface RawEvent {
  readonly eventType: string;
  readonly dataUtf8: string;
  readonly offsetMs: number;
}

/**
 * Provider-agnostic SSE line splitter. Mirrors the line discipline in
 * `sse-extractor.ts` (CRLF or LF treated as a single break) but emits
 * `(eventType, dataPayload)` tuples instead of parsed events. The data
 * payload is the exact bytes after `data: ` — no trim, no parse.
 */
class SseLineSplitter {
  private buffer = '';
  private currentEventType = '';
  /** Pending `data:` payload for the in-flight event (multi-line dataspec). */
  private currentData: string | null = null;

  feed(text: string, sink: (event: string, data: string) => void): void {
    this.buffer += text;
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
function readJsonValueSubstring(data: string, start: number): string | undefined {
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
function findJsonStringEnd(data: string, start: number): number {
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
function findFieldValueSubstring(data: string, fieldName: string): string | undefined {
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
 * Decodes a JSON string literal (the substring including surrounding
 * quotes) into the raw string it represents. Used for `text` /
 * `thinking` / `signature` payloads where the wire bytes carry escapes
 * we must decode before appending to our concatenation buffer.
 */
function decodeJsonString(literal: string): string {
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
function encodeJsonString(value: string): string {
  return JSON.stringify(value);
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

export class AnthropicReassembler implements Reassembler {
  private readonly splitter = new SseLineSplitter();
  private readonly events: RawEvent[] = [];
  private readonly startedAt: number;

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
  private failed = false;
  private failureReason?: string;

  constructor() {
    this.startedAt = Date.now();
  }

  push(chunk: Buffer): void {
    if (this.failed) return;
    const text = chunk.toString('utf-8');
    this.splitter.feed(text, (eventType, data) => this.onEvent(eventType, data));
  }

  finalize(): ReassemblyResult {
    this.splitter.flush((eventType, data) => this.onEvent(eventType, data));
    if (this.failed) {
      throw new ReassemblyError(this.failureReason ?? 'anthropic reassembly failed');
    }
    if (!this.receivedMessageStop) {
      throw new ReassemblyError('anthropic stream ended without message_stop');
    }
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

  private dispatch(eventType: string, data: string): void {
    // The `type` field in `data` is the authoritative event identifier;
    // SSE `event:` lines are advisory.
    const type = this.peekTypeField(data) ?? eventType;
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

  private peekTypeField(data: string): string | undefined {
    const raw = findFieldValueSubstring(data, 'type');
    if (!raw) return undefined;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      return decodeJsonString(raw);
    }
    return undefined;
  }

  private onMessageStart(data: string): void {
    const messageRaw = findFieldValueSubstring(data, 'message');
    if (!messageRaw) {
      throw new ReassemblyError('message_start missing `message` field');
    }
    this.messageEnvelope = messageRaw;
    const id = this.peekStringField(messageRaw, 'id');
    if (id) this.providerRequestId = id;
  }

  private onContentBlockStart(data: string): void {
    const index = this.peekNumberField(data, 'index');
    const blockRaw = findFieldValueSubstring(data, 'content_block');
    if (index === undefined || blockRaw === undefined) {
      throw new ReassemblyError('content_block_start missing index or content_block');
    }
    const kind = this.peekStringField(blockRaw, 'type');
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
    const index = this.peekNumberField(data, 'index');
    const deltaRaw = findFieldValueSubstring(data, 'delta');
    if (index === undefined || deltaRaw === undefined) {
      throw new ReassemblyError('content_block_delta missing index or delta');
    }
    const block = this.blocks.get(index);
    if (!block) {
      throw new ReassemblyError(`content_block_delta for unknown index ${index}`);
    }
    const deltaType = this.peekStringField(deltaRaw, 'type');
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
    const index = this.peekNumberField(data, 'index');
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

  private peekStringField(data: string, name: string): string | undefined {
    const raw = findFieldValueSubstring(data, name);
    if (!raw || !raw.startsWith('"')) return undefined;
    return decodeJsonString(raw);
  }

  private peekNumberField(data: string, name: string): number | undefined {
    const raw = findFieldValueSubstring(data, name);
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
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
    body = this.replaceField(body, 'content', this.assembleContentArray());
    if (this.stopReason !== undefined) {
      body = this.replaceField(body, 'stop_reason', encodeJsonString(this.stopReason));
    }
    if (this.stopSequence !== undefined) {
      body = this.replaceField(body, 'stop_sequence', this.stopSequence);
    }
    if (this.usageRaw !== undefined) {
      body = this.replaceField(body, 'usage', this.usageRaw);
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

  /**
   * Replaces the value of a top-level field by substring. Locates
   * `"fieldName"` followed by `:`, finds the existing value's
   * substring, and splices in the new value. The new value MUST already
   * be a valid JSON expression (string-with-quotes, object, array,
   * primitive).
   */
  private replaceField(body: string, fieldName: string, newValue: string): string {
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
}

// =====================================================================
// OpenAI (stub — not implemented in v0)
// =====================================================================

/**
 * OpenAI SSE reassembler is intentionally deferred for v0. The Anthropic
 * variant is the target of the acceptance test; OpenAI capture is shaped
 * but not implemented. Calling `finalize()` throws.
 */
export class OpenAIReassembler implements Reassembler {
  push(): void {
    /* no-op until OpenAI is implemented */
  }
  finalize(): ReassemblyResult {
    throw new Error('OpenAI reassembler not implemented for v0');
  }
}

/**
 * Pick a reassembler by upstream host. Hosts the caller cannot classify
 * yield `undefined`; the caller should fall back to capturing raw bytes
 * verbatim.
 */
export function createReassembler(host: string): Reassembler | undefined {
  const normalized = host.toLowerCase();
  if (normalized === 'api.anthropic.com') return new AnthropicReassembler();
  if (normalized === 'api.openai.com') return new OpenAIReassembler();
  return undefined;
}
