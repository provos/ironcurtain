/** Hermetic protocol checks through the real TLS/credential boundary. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadOrCreateCA } from '../../src/docker/ca.js';
import { createMitmProxy } from '../../src/docker/mitm-proxy.js';
import type { MitmProxy } from '../../src/docker/mitm-proxy.js';
import { makeZaiProvider } from '../../src/docker/zai.js';
import type { ResolvedZaiProfile } from '../../src/config/user-config.js';
import { createFakeUpstream, localhostDnsLookup, makeHttpsRequest, sendConnect } from '../helpers/mitm-tls-harness.js';
import type { FakeUpstream } from '../helpers/mitm-tls-harness.js';

const profile: ResolvedZaiProfile = {
  type: 'zai',
  apiKey: 'host-only-key',
  model: 'glm-5.3',
  plan: 'api',
  modelMap: [{ match: '*', model: 'glm-5.3' }],
  usesDefaultMap: false,
  perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
};
let dir: string;
let proxy: MitmProxy | undefined;
let upstream: FakeUpstream | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zai-mitm-'));
});
afterEach(async () => {
  await proxy?.stop();
  proxy = undefined;
  if (upstream) await new Promise<void>((resolve) => upstream?.server.close(() => resolve()));
  upstream = undefined;
  rmSync(dir, { recursive: true, force: true });
});

it.each(['claude-code', 'codex', 'goose'] as const)(
  '%s forwards streaming tool calls/results only on its authorized Z.AI route',
  async (agent) => {
    const tool = { id: 'call-1', name: 'execute_code', arguments: '{"code":"1+1"}' };
    const sse =
      agent === 'claude-code'
        ? `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'glm-5.3', content: [], usage: { input_tokens: 1, output_tokens: 0 } } })}\n\nevent: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } })}\n\nevent: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: tool.arguments } })}\n\nevent: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n`
        : agent === 'codex'
          ? `event: response.output_item.done\ndata: ${JSON.stringify({ type: 'response.output_item.done', item: { type: 'function_call', id: tool.id, call_id: tool.id, name: tool.name, arguments: tool.arguments } })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { id: 'r', status: 'completed', model: 'glm-5.3', output: [], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`
          : `data: ${JSON.stringify({ id: 'r', model: 'glm-5.3', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`;
    upstream = await createFakeUpstream(() => ({ contentType: 'text/event-stream', body: sse }));
    const ca = loadOrCreateCA(join(dir, 'ca'));
    const socketPath = join(dir, 'proxy.sock');
    const provider = makeZaiProvider(profile, agent);
    const path = provider.completionEndpoints?.[0].path;
    expect(path).toBeDefined();
    proxy = createMitmProxy({
      socketPath,
      ca,
      allowPrivateDestinationsForTests: true,
      dnsLookup: localhostDnsLookup,
      providers: [
        {
          config: {
            ...provider,
            upstreamTarget: { hostname: '127.0.0.1', port: upstream.port, pathPrefix: '', useTls: false },
          },
          fakeKey: 'sentinel-key',
          realKey: 'host-only-key',
        },
      ],
    });
    await proxy.start();
    async function post(path: string, body: Record<string, unknown>, credential = 'sentinel-key') {
      const connection = await sendConnect(socketPath, 'api.z.ai', 443);
      if (!connection.socket) throw new Error('CONNECT failed');
      return makeHttpsRequest(connection.socket, ca, 'api.z.ai', {
        method: 'POST',
        path,
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    const request = {
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'Calculate 1+1' }],
      tools: [{ name: 'execute_code', input_schema: { type: 'object' } }],
      cache_control: { type: 'ephemeral' },
    };
    const response = await post(path as string, request);
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('execute_code');
    expect(response.body).not.toContain('host-only-key');
    expect(upstream.requests()[0]).toMatchObject({
      path,
      headers: { authorization: 'Bearer host-only-key' },
      body: { model: 'glm-5.3', tools: request.tools, cache_control: request.cache_control },
    });
    const resultBody =
      agent === 'claude-code'
        ? { messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: tool.id, content: '2' }] }] }
        : agent === 'codex'
          ? { input: [{ type: 'function_call_output', call_id: tool.id, output: '2' }] }
          : { messages: [{ role: 'tool', tool_call_id: tool.id, content: '2' }] };
    expect((await post(path as string, { model: 'glm-5.3', ...resultBody })).statusCode).toBe(200);
    expect(upstream.requests()[1].body).toMatchObject(resultBody);
    expect((await post('/api/unapproved', request)).statusCode).toBe(403);
    expect((await post(path as string, request, 'agent-owned-key')).statusCode).toBe(200);
    expect(upstream.requests()[2].headers.authorization).toBe('Bearer agent-owned-key');
    expect(upstream.requests()).toHaveLength(3);
    if (agent === 'goose') {
      expect(
        (await post(path as string, { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'Title' }] }))
          .statusCode,
      ).toBe(200);
      expect(upstream.requests()[3].body.model).toBe('glm-5.3');
    }
  },
);
