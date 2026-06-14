/**
 * Trajectory-capture endpoint gate + manifest FSM-state tagging.
 *
 * Covers two surgical fixes from docs/designs/mitm-token-trajectory-capture.md:
 *   - §13 item 20 / §3 integration point 4: `isCapturableEndpoint` allowlist
 *     — only completion endpoints are captured; host-shared housekeeping
 *     traffic (registry pagination, telemetry batches, settings/eval pings)
 *     is excluded so it never pollutes the corpus.
 *   - §13 item 21 / §7 / §11: the `session-start` manifest entry must carry
 *     `fsmState` and `persona` (omitted, not null, when undefined) so the
 *     manifest is the canonical FSM-state-to-session mapping.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anthropicProvider,
  anthropicOAuthProvider,
  claudePlatformProvider,
  codexChatGptProvider,
  googleProvider,
  isCapturableEndpoint,
  openaiProvider,
  type ProviderConfig,
} from '../../src/docker/provider-config.js';
import { createTrajectoryCaptureWriter, type TrajectoryCaptureWriter } from '../../src/docker/trajectory-capture.js';
import type { ManifestEntry } from '../../src/docker/trajectory-types.js';
import type { SessionId } from '../../src/session/types.js';

describe('isCapturableEndpoint: capture-endpoint allowlist', () => {
  it('captures Anthropic POST /v1/messages (with and without query string)', () => {
    expect(isCapturableEndpoint(anthropicProvider, 'POST', '/v1/messages')).toBe(true);
    expect(isCapturableEndpoint(anthropicProvider, 'POST', '/v1/messages?beta=true')).toBe(true);
    // Method is case-insensitive on the request side.
    expect(isCapturableEndpoint(anthropicProvider, 'post', '/v1/messages')).toBe(true);
  });

  it('does NOT capture Anthropic housekeeping endpoints', () => {
    expect(isCapturableEndpoint(anthropicProvider, 'GET', '/mcp-registry/v0/servers')).toBe(false);
    expect(isCapturableEndpoint(anthropicProvider, 'POST', '/api/event_logging/v2/batch')).toBe(false);
    expect(isCapturableEndpoint(anthropicProvider, 'GET', '/api/claude_code/settings')).toBe(false);
    expect(isCapturableEndpoint(anthropicProvider, 'GET', '/api/claude_code/policy_limits')).toBe(false);
    expect(isCapturableEndpoint(anthropicProvider, 'POST', '/api/eval/sdk-abc123')).toBe(false);
  });

  it('does NOT capture token-counting (a non-completion POST that IS otherwise allowed)', () => {
    // /v1/messages/count_tokens is in allowedEndpoints but not captureEndpoints.
    expect(isCapturableEndpoint(anthropicProvider, 'POST', '/v1/messages/count_tokens')).toBe(false);
  });

  it('captures the same completion endpoint under the OAuth Anthropic provider', () => {
    expect(isCapturableEndpoint(anthropicOAuthProvider, 'POST', '/v1/messages')).toBe(true);
    expect(isCapturableEndpoint(anthropicOAuthProvider, 'POST', '/api/event_logging/v2/batch')).toBe(false);
  });

  it('captures OpenAI POST /v1/responses only (not chat/completions or models)', () => {
    expect(isCapturableEndpoint(openaiProvider, 'POST', '/v1/responses')).toBe(true);
    expect(isCapturableEndpoint(openaiProvider, 'POST', '/v1/responses?stream=true')).toBe(true);
    // /v1/chat/completions is forwardable (goose) but NOT captured.
    expect(isCapturableEndpoint(openaiProvider, 'POST', '/v1/chat/completions')).toBe(false);
    expect(isCapturableEndpoint(openaiProvider, 'GET', '/v1/models')).toBe(false);
  });

  it('captures Codex POST /backend-api/codex/responses only', () => {
    // The completion stream Codex sends is POST /backend-api/codex/responses
    // (verified against a live codex exec run) — NOT the bare /backend-api/codex.
    expect(isCapturableEndpoint(codexChatGptProvider, 'POST', '/backend-api/codex/responses')).toBe(true);
    expect(isCapturableEndpoint(codexChatGptProvider, 'POST', '/backend-api/codex/responses?stream=true')).toBe(true);
    expect(isCapturableEndpoint(codexChatGptProvider, 'post', '/backend-api/codex/responses')).toBe(true);
    // The bare path (the old, never-matching capture target) and the GET poll /
    // model-list housekeeping calls must NOT be captured.
    expect(isCapturableEndpoint(codexChatGptProvider, 'POST', '/backend-api/codex')).toBe(false);
    expect(isCapturableEndpoint(codexChatGptProvider, 'GET', '/backend-api/codex/responses')).toBe(false);
    expect(isCapturableEndpoint(codexChatGptProvider, 'GET', '/backend-api/codex/models')).toBe(false);
  });

  it('captures Google generateContent / streamGenerateContent globs', () => {
    // The built-in glob `/v1beta/models/*/generateContent` matches a single
    // model-name path segment followed by the literal action segment.
    expect(isCapturableEndpoint(googleProvider, 'POST', '/v1beta/models/gemini-2.0-flash/generateContent')).toBe(true);
    expect(isCapturableEndpoint(googleProvider, 'POST', '/v1beta/models/gemini-2.0-flash/streamGenerateContent')).toBe(
      true,
    );
    expect(isCapturableEndpoint(googleProvider, 'POST', '/v1beta/models')).toBe(false);
  });

  it('captures nothing for a provider without captureEndpoints (default empty)', () => {
    // claudePlatformProvider has allowedEndpoints but no captureEndpoints.
    expect(claudePlatformProvider.captureEndpoints).toBeUndefined();
    expect(isCapturableEndpoint(claudePlatformProvider, 'GET', '/v1/oauth/hello')).toBe(false);

    const custom: ProviderConfig = {
      host: 'api.example.com',
      displayName: 'Custom',
      allowedEndpoints: [{ method: 'POST', path: '/v1/anything' }],
      keyInjection: { type: 'bearer' },
      fakeKeyPrefix: 'x-',
    };
    expect(isCapturableEndpoint(custom, 'POST', '/v1/anything')).toBe(false);

    const explicitlyEmpty: ProviderConfig = { ...custom, captureEndpoints: [] };
    expect(isCapturableEndpoint(explicitlyEmpty, 'POST', '/v1/anything')).toBe(false);
  });

  it('returns false for undefined method/path', () => {
    expect(isCapturableEndpoint(anthropicProvider, undefined, '/v1/messages')).toBe(false);
    expect(isCapturableEndpoint(anthropicProvider, 'POST', undefined)).toBe(false);
  });
});

describe('manifest session-start carries fsmState and persona', () => {
  let dir: string;
  let writer: TrajectoryCaptureWriter;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), 'tj-gate-'));
  });

  afterEach(async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (writer) await writer.close();
    } catch {
      /* swallow */
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function readManifest(): ManifestEntry[] {
    return readFileSync(resolve(dir, 'manifest.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as ManifestEntry);
  }

  it('workflow session: session-start includes fsmState and persona', async () => {
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = 'sess-wf' as SessionId;
    writer.beginSession({ sessionId: sid, fsmState: 'fetch', persona: 'exec-assistant' });
    // endSession drains the manifest queue to disk (session-start + session-end).
    await writer.endSession(sid);

    const start = readManifest().find((e) => e.event === 'session-start');
    expect(start).toBeDefined();
    expect(start?.fsmState).toBe('fetch');
    expect(start?.persona).toBe('exec-assistant');
  });

  it('standalone session: session-start omits fsmState and persona (no null/undefined keys)', async () => {
    writer = createTrajectoryCaptureWriter({ capturesDir: dir });
    const sid = 'sess-standalone' as SessionId;
    writer.beginSession({ sessionId: sid });
    await writer.endSession(sid);

    const entries = readManifest();
    const start = entries.find((e) => e.event === 'session-start');
    expect(start).toBeDefined();
    // The keys must be ABSENT, not present-with-null/undefined.
    expect(Object.prototype.hasOwnProperty.call(start, 'fsmState')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(start, 'persona')).toBe(false);
    // And the serialized line must not contain the tokens at all.
    const startLine = readFileSync(resolve(dir, 'manifest.jsonl'), 'utf-8')
      .split('\n')
      .find((l) => l.includes('"session-start"'));
    expect(startLine).toBeDefined();
    expect(startLine).not.toContain('fsmState');
    expect(startLine).not.toContain('persona');
  });
});
