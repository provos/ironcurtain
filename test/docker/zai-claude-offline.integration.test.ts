/** Opt-in installed-client check; every API exchange terminates on loopback. */
import { expect, it } from 'vitest';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createClaudeCodeAdapter } from '../../src/docker/adapters/claude-code.js';
import { loadOrCreateCA } from '../../src/docker/ca.js';
import { createMitmProxy } from '../../src/docker/mitm-proxy.js';
import type { IronCurtainConfig } from '../../src/config/types.js';
import { ZAI_HOST } from '../../src/config/zai.js';
import type { ResolvedZaiProfile } from '../../src/config/user-config.js';
import { createFakeUpstream, localhostDnsLookup } from '../helpers/mitm-tls-harness.js';

const execFile = promisify(execFileCallback);
const enabled = process.env.ZAI_CLAUDE_OFFLINE_TEST === '1';

it.skipIf(!enabled)(
  'installed Claude Code accepts the Z.AI profile and receives a completion through the MITM',
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zai-claude-'));
    const socketDir = join(dir, 'sockets');
    mkdirSync(socketDir);
    const ca = loadOrCreateCA(join(dir, 'ca'));
    const certPath = join(dir, 'ca-cert.pem');
    writeFileSync(certPath, ca.certPem);
    const mcpConfigPath = join(dir, 'claude-mcp-config.json');
    writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    const profile: ResolvedZaiProfile = {
      type: 'zai',
      apiKey: 'offline-host-key',
      plan: 'api',
      model: 'glm-5.3',
      modelMap: [],
      usesDefaultMap: false,
      perAgent: { 'claude-code': undefined, codex: undefined, goose: undefined },
    };
    const config = { activeProviderProfile: profile, agentModelId: 'glm-5.3' } as IronCurtainConfig;
    const adapter = createClaudeCodeAdapter();
    const upstream = await createFakeUpstream((req) => {
      if (new URL(req.path, 'http://fixture').pathname.endsWith('/count_tokens')) return { body: '{"input_tokens":1}' };
      const message = {
        id: 'offline-message',
        type: 'message',
        role: 'assistant',
        model: 'glm-5.3',
        content: [{ type: 'text', text: 'OFFLINE_ZAI_OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      };
      if (req.body.stream !== true) return { body: JSON.stringify(message) };
      const event = (type: string, data: unknown) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
      return {
        contentType: 'text/event-stream',
        body:
          event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }) +
          event('content_block_start', {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          }) +
          event('content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'OFFLINE_ZAI_OK' },
          }) +
          event('content_block_stop', { type: 'content_block_stop', index: 0 }) +
          event('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: 1 },
          }) +
          event('message_stop', { type: 'message_stop' }),
      };
    });
    const provider = adapter.getProviders(config)[0];
    const proxy = createMitmProxy({
      ...(process.platform === 'linux' ? { socketPath: join(socketDir, 'mitm-proxy.sock') } : { listenPort: 0 }),
      ca,
      dnsLookup: localhostDnsLookup,
      allowPrivateDestinationsForTests: true,
      providers: [
        {
          config: {
            ...provider,
            upstreamTarget: { hostname: '127.0.0.1', port: upstream.port, pathPrefix: '', useTls: false },
          },
          fakeKey: 'offline-sentinel',
          realKey: profile.apiKey,
        },
      ],
    });
    const name = `ironcurtain-zai-offline-${randomUUID()}`;
    try {
      const address = await proxy.start();
      if (address.socketPath) chmodSync(address.socketPath, 0o666);
      const proxyUrl =
        process.platform === 'linux' ? 'http://127.0.0.1:18080' : `http://host.docker.internal:${address.port}`;
      const env = adapter.buildEnv(config, new Map([[ZAI_HOST, 'offline-sentinel']]));
      const { stdout } = await execFile(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--network',
          process.platform === 'linux' ? 'none' : 'bridge',
          '-v',
          `${socketDir}:/run/ironcurtain`,
          '-v',
          `${certPath}:/etc/ironcurtain/ca-cert.pem:ro`,
          '-v',
          `${mcpConfigPath}:/etc/ironcurtain/claude-mcp-config.json:ro`,
          ...Object.entries({ ...env, HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }).flatMap(([key, value]) => [
            '-e',
            `${key}=${value}`,
          ]),
          'ironcurtain-claude-code:latest',
          ...adapter.buildCommand('Reply with OFFLINE_ZAI_OK', '', {
            firstTurn: true,
            sessionId: randomUUID(),
            providerProfile: profile,
            modelOverride: 'glm-5.3',
          }),
        ],
        { timeout: 30000, maxBuffer: 1024 * 1024 },
      );
      expect(stdout).toContain('OFFLINE_ZAI_OK');
      const completions = upstream
        .requests()
        .filter((req) => new URL(req.path, 'http://fixture').pathname.endsWith('/messages'));
      expect(completions.length).toBeGreaterThan(0);
      for (const request of completions) {
        expect(request.headers.authorization).toBe('Bearer offline-host-key');
        expect(request.body.model).toBe('glm-5.3');
      }
    } finally {
      await execFile('docker', ['rm', '-f', name]).catch(() => {});
      await proxy.stop();
      await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
  45000,
);
