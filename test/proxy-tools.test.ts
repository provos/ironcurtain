import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  validateDomain,
  proxyAnnotations,
  proxyPolicyRules,
  proxyToolDefinitions,
  handleVirtualProxyTool,
  createControlApiClient,
  RESERVED_SERVER_NAMES,
  type ControlApiClient,
  type DomainListing,
} from '../src/docker/proxy-tools.js';
import { createMitmProxy, type MitmProxy, type DynamicHostController } from '../src/docker/mitm-proxy.js';
import { loadOrCreateCA, type CertificateAuthority } from '../src/docker/ca.js';
import { generateFakeKey } from '../src/docker/fake-keys.js';
import type { ProviderConfig } from '../src/docker/provider-config.js';

// ---------------------------------------------------------------------------
// Domain validation
// ---------------------------------------------------------------------------

describe('validateDomain', () => {
  it('accepts valid domains', () => {
    expect(() => validateDomain('api.example.com')).not.toThrow();
    expect(() => validateDomain('example.com')).not.toThrow();
    expect(() => validateDomain('sub.deep.example.co.uk')).not.toThrow();
    expect(() => validateDomain('a1.b2.c3')).not.toThrow();
  });

  it('rejects IP addresses', () => {
    expect(() => validateDomain('192.168.1.1')).toThrow('IP addresses are not allowed');
    expect(() => validateDomain('10.0.0.1')).toThrow('IP addresses are not allowed');
    expect(() => validateDomain('127.0.0.1')).toThrow('IP addresses are not allowed');
  });

  it('rejects wildcards', () => {
    expect(() => validateDomain('*.example.com')).toThrow('Invalid domain format');
    expect(() => validateDomain('sub.*.com')).toThrow('Invalid domain format');
  });

  it('rejects docker.internal domains', () => {
    expect(() => validateDomain('host.docker.internal')).toThrow('*.docker.internal is not allowed');
    expect(() => validateDomain('gateway.docker.internal')).toThrow('*.docker.internal is not allowed');
    expect(() => validateDomain('custom.docker.internal')).toThrow('*.docker.internal is not allowed');
  });

  it('rejects localhost', () => {
    expect(() => validateDomain('localhost')).toThrow('Blocked host');
    expect(() => validateDomain('LOCALHOST')).toThrow('Blocked host');
  });

  it('rejects domains exceeding 253 characters', () => {
    const longDomain = 'a'.repeat(250) + '.com';
    expect(() => validateDomain(longDomain)).toThrow('Domain too long');
  });

  it('rejects single-label domains', () => {
    expect(() => validateDomain('example')).toThrow('Invalid domain format');
  });

  it('rejects domains with invalid characters', () => {
    expect(() => validateDomain('exam ple.com')).toThrow('Invalid domain format');
    expect(() => validateDomain('exam_ple.com')).toThrow('Invalid domain format');
  });

  it('rejects empty string', () => {
    expect(() => validateDomain('')).toThrow('Invalid domain format');
  });

  it('rejects domains with leading hyphens in labels', () => {
    expect(() => validateDomain('-example.com')).toThrow('Invalid domain format');
  });

  it('rejects domains with trailing hyphens in labels', () => {
    expect(() => validateDomain('example-.com')).toThrow('Invalid domain format');
  });
});

// ---------------------------------------------------------------------------
// DynamicHostController behavior (via createMitmProxy)
// ---------------------------------------------------------------------------

describe('DynamicHostController', () => {
  let tmpDir: string;
  let ca: CertificateAuthority;
  let proxy: MitmProxy;
  let hosts: DynamicHostController;

  const testProvider: ProviderConfig = {
    displayName: 'Anthropic Test',
    host: 'api.anthropic.com',
    fakeKeyPrefix: 'sk-ant-test',
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
  };

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'proxy-tools-test-'));
    ca = loadOrCreateCA(tmpDir);

    const fakeKey = generateFakeKey(testProvider.fakeKeyPrefix);
    proxy = createMitmProxy({
      socketPath: join(tmpDir, 'mitm.sock'),
      ca,
      providers: [{ config: testProvider, fakeKey, realKey: 'real-key-123' }],
    });
    hosts = proxy.hosts;
  });

  afterEach(async () => {
    await proxy.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds and lists dynamic domains', () => {
    expect(hosts.addHost('api.example.com')).toBe(true);
    const listing = hosts.listHosts();
    expect(listing.dynamic).toContain('api.example.com');
  });

  it('returns false when adding a domain that is already dynamic', () => {
    hosts.addHost('api.example.com');
    expect(hosts.addHost('api.example.com')).toBe(false);
  });

  it('returns false when adding a provider domain', () => {
    expect(hosts.addHost('api.anthropic.com')).toBe(false);
  });

  it('removes a dynamic domain', () => {
    hosts.addHost('api.example.com');
    expect(hosts.removeHost('api.example.com')).toBe(true);
    expect(hosts.listHosts().dynamic).not.toContain('api.example.com');
  });

  it('returns false when removing a non-existent domain', () => {
    expect(hosts.removeHost('nonexistent.example.com')).toBe(false);
  });

  it('cannot remove a provider domain', () => {
    expect(hosts.removeHost('api.anthropic.com')).toBe(false);
  });

  it('throws on invalid domain', () => {
    expect(() => hosts.addHost('*.example.com')).toThrow();
    expect(() => hosts.addHost('127.0.0.1')).toThrow();
  });

  it('lists providers in the listing', () => {
    const listing = hosts.listHosts();
    expect(listing.providers).toContain('api.anthropic.com');
  });
});

// ---------------------------------------------------------------------------
// Virtual tool handler dispatching
// ---------------------------------------------------------------------------

describe('handleVirtualProxyTool', () => {
  function createMockClient(overrides?: Partial<ControlApiClient>): ControlApiClient {
    return {
      addDomain: overrides?.addDomain ?? (async () => ({ added: true })),
      removeDomain: overrides?.removeDomain ?? (async () => ({ removed: true })),
      listDomains:
        overrides?.listDomains ??
        (async () => ({
          providers: ['api.anthropic.com'],
          dynamic: ['api.example.com'],
        })),
    };
  }

  it('dispatches add_proxy_domain', async () => {
    const client = createMockClient();
    const result = await handleVirtualProxyTool(
      'add_proxy_domain',
      { domain: 'api.example.com', justification: 'test' },
      client,
    );
    expect(result).toEqual({ status: 'added', domain: 'api.example.com' });
  });

  it('returns already_accessible when add returns false', async () => {
    const client = createMockClient({
      addDomain: async () => ({ added: false }),
    });
    const result = await handleVirtualProxyTool(
      'add_proxy_domain',
      { domain: 'api.anthropic.com', justification: 'test' },
      client,
    );
    expect(result).toEqual({
      status: 'already_accessible',
      message: 'Domain is already accessible (built-in provider)',
    });
  });

  it('dispatches remove_proxy_domain', async () => {
    const client = createMockClient();
    const result = await handleVirtualProxyTool('remove_proxy_domain', { domain: 'api.example.com' }, client);
    expect(result).toEqual({ status: 'removed', domain: 'api.example.com' });
  });

  it('returns not_found when remove returns false', async () => {
    const client = createMockClient({
      removeDomain: async () => ({ removed: false }),
    });
    const result = await handleVirtualProxyTool('remove_proxy_domain', { domain: 'nonexistent.com' }, client);
    expect(result).toEqual({ status: 'not_found', domain: 'nonexistent.com' });
  });

  it('dispatches list_proxy_domains', async () => {
    const client = createMockClient();
    const result = (await handleVirtualProxyTool('list_proxy_domains', {}, client)) as DomainListing;
    expect(result.providers).toContain('api.anthropic.com');
    expect(result.dynamic).toContain('api.example.com');
  });

  it('throws for unknown tool name', async () => {
    const client = createMockClient();
    await expect(handleVirtualProxyTool('unknown_tool', {}, client)).rejects.toThrow('Unknown virtual proxy tool');
  });

  it('validates domain format in add_proxy_domain', async () => {
    const client = createMockClient();
    await expect(
      handleVirtualProxyTool('add_proxy_domain', { domain: '*.bad.com', justification: 'test' }, client),
    ).rejects.toThrow('Invalid domain format');
  });

  it('rejects missing domain in add_proxy_domain', async () => {
    const client = createMockClient();
    await expect(handleVirtualProxyTool('add_proxy_domain', { justification: 'test' }, client)).rejects.toThrow(
      'Missing or invalid required argument: domain',
    );
  });

  it('rejects missing domain in remove_proxy_domain', async () => {
    const client = createMockClient();
    await expect(handleVirtualProxyTool('remove_proxy_domain', {}, client)).rejects.toThrow(
      'Missing or invalid required argument: domain',
    );
  });

  it('rejects non-string domain in add_proxy_domain', async () => {
    const client = createMockClient();
    await expect(
      handleVirtualProxyTool('add_proxy_domain', { domain: 123, justification: 'test' }, client),
    ).rejects.toThrow('Missing or invalid required argument: domain');
  });

  it('rejects missing justification in add_proxy_domain', async () => {
    const client = createMockClient();
    await expect(handleVirtualProxyTool('add_proxy_domain', { domain: 'api.example.com' }, client)).rejects.toThrow(
      'Missing or invalid required argument: justification',
    );
  });
});

// ---------------------------------------------------------------------------
// Control API client (with mock HTTP server)
// ---------------------------------------------------------------------------

describe('createControlApiClient', () => {
  let server: http.Server;
  let socketPath: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'control-api-test-'));
    socketPath = join(tmpDir, 'control.sock');
  });

  afterEach(async () => {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- server may not be assigned if beforeEach fails
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function startMockControlServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ): Promise<void> {
    server = http.createServer(handler);
    return new Promise((resolve) => {
      server.listen(socketPath, () => resolve());
    });
  }

  it('addDomain sends POST to correct endpoint', async () => {
    let receivedBody: string = '';
    let receivedUrl: string = '';

    await startMockControlServer((req, res) => {
      receivedUrl = req.url ?? '';
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        receivedBody = Buffer.concat(chunks).toString();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ added: true }));
      });
    });

    const client = createControlApiClient(`unix://${socketPath}`);
    const result = await client.addDomain('api.example.com');
    expect(result).toEqual({ added: true });
    expect(receivedUrl).toBe('/__ironcurtain/domains/add');
    expect(JSON.parse(receivedBody)).toEqual({ domain: 'api.example.com' });
  });

  it('removeDomain sends POST to correct endpoint', async () => {
    let receivedUrl: string = '';

    await startMockControlServer((req, res) => {
      receivedUrl = req.url ?? '';
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ removed: true }));
      });
    });

    const client = createControlApiClient(`unix://${socketPath}`);
    const result = await client.removeDomain('api.example.com');
    expect(result).toEqual({ removed: true });
    expect(receivedUrl).toBe('/__ironcurtain/domains/remove');
  });

  it('listDomains sends GET to correct endpoint', async () => {
    const mockListing: DomainListing = {
      providers: ['api.anthropic.com'],
      dynamic: ['api.example.com'],
    };

    await startMockControlServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockListing));
    });

    const client = createControlApiClient(`unix://${socketPath}`);
    const result = await client.listDomains();
    expect(result).toEqual(mockListing);
  });

  it('rejects on HTTP error status', async () => {
    await startMockControlServer((_req, res) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Bad request' }));
    });

    const client = createControlApiClient(`unix://${socketPath}`);
    await expect(client.addDomain('bad.com')).rejects.toThrow('Control API 400');
  });
});

// ---------------------------------------------------------------------------
// Policy rules
// ---------------------------------------------------------------------------

describe('proxyPolicyRules', () => {
  it('has escalate rule for add_proxy_domain scoped to proxy server', () => {
    const addRule = proxyPolicyRules.find((r) => r.if.tool?.includes('add_proxy_domain'));
    expect(addRule).toBeDefined();
    expect(addRule!.then).toBe('escalate');
    expect(addRule!.if.server).toEqual(['proxy']);
  });

  it('has allow rule for remove_proxy_domain scoped to proxy server', () => {
    const removeRule = proxyPolicyRules.find((r) => r.if.tool?.includes('remove_proxy_domain'));
    expect(removeRule).toBeDefined();
    expect(removeRule!.then).toBe('allow');
    expect(removeRule!.if.server).toEqual(['proxy']);
  });

  it('has allow rule for list_proxy_domains scoped to proxy server', () => {
    const listRule = proxyPolicyRules.find((r) => r.if.tool?.includes('list_proxy_domains'));
    expect(listRule).toBeDefined();
    expect(listRule!.then).toBe('allow');
    expect(listRule!.if.server).toEqual(['proxy']);
  });
});

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

describe('proxyToolDefinitions', () => {
  it('defines three tools', () => {
    expect(proxyToolDefinitions).toHaveLength(3);
    const names = proxyToolDefinitions.map((t) => t.name);
    expect(names).toContain('add_proxy_domain');
    expect(names).toContain('remove_proxy_domain');
    expect(names).toContain('list_proxy_domains');
  });

  it('add_proxy_domain requires domain and justification', () => {
    const addTool = proxyToolDefinitions.find((t) => t.name === 'add_proxy_domain');
    expect(addTool!.inputSchema.required).toEqual(['domain', 'justification']);
  });

  it('remove_proxy_domain requires domain', () => {
    const removeTool = proxyToolDefinitions.find((t) => t.name === 'remove_proxy_domain');
    expect(removeTool!.inputSchema.required).toEqual(['domain']);
  });
});

// ---------------------------------------------------------------------------
// Annotations
// ---------------------------------------------------------------------------

describe('proxyAnnotations', () => {
  it('has correct metadata for add_proxy_domain', () => {
    const addAnnotation = proxyAnnotations.find((a) => a.toolName === 'add_proxy_domain');
    expect(addAnnotation).toBeDefined();
    expect(addAnnotation!.serverName).toBe('proxy');
    expect(addAnnotation!.inputSchema).toBeDefined();
  });

  it('annotates domain arguments as proxy-domain for whitelist scoping', () => {
    const addAnnotation = proxyAnnotations.find((a) => a.toolName === 'add_proxy_domain');
    expect(addAnnotation!.args.domain).toEqual(['proxy-domain']);

    const removeAnnotation = proxyAnnotations.find((a) => a.toolName === 'remove_proxy_domain');
    expect(removeAnnotation!.args.domain).toEqual(['proxy-domain']);
  });

  it('has correct metadata for list_proxy_domains', () => {
    const listAnnotation = proxyAnnotations.find((a) => a.toolName === 'list_proxy_domains');
    expect(listAnnotation).toBeDefined();
    expect(listAnnotation!.inputSchema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Reserved server names
// ---------------------------------------------------------------------------

describe('RESERVED_SERVER_NAMES', () => {
  it('includes proxy', () => {
    expect(RESERVED_SERVER_NAMES.has('proxy')).toBe(true);
  });

  it('does not include arbitrary names', () => {
    expect(RESERVED_SERVER_NAMES.has('filesystem')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Control API server integration (via MITM proxy)
// ---------------------------------------------------------------------------

describe('MITM proxy control API', () => {
  let tmpDir: string;
  let ca: CertificateAuthority;
  let proxy: MitmProxy;

  const testProvider: ProviderConfig = {
    displayName: 'Anthropic Test',
    host: 'api.anthropic.com',
    fakeKeyPrefix: 'sk-ant-test',
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
  };

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'control-api-integ-'));
    ca = loadOrCreateCA(tmpDir);

    const fakeKey = generateFakeKey(testProvider.fakeKeyPrefix);
    proxy = createMitmProxy({
      socketPath: join(tmpDir, 'mitm.sock'),
      ca,
      providers: [{ config: testProvider, fakeKey, realKey: 'real-key-123' }],
      controlSocketPath: join(tmpDir, 'control.sock'),
    });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop().catch(() => {});
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function httpRequest(
    socketPath: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ statusCode: number; body: unknown }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          method,
          path,
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString();
            try {
              resolve({ statusCode: res.statusCode ?? 0, body: JSON.parse(text) });
            } catch {
              resolve({ statusCode: res.statusCode ?? 0, body: text });
            }
          });
        },
      );
      req.on('error', reject);
      if (body !== undefined) {
        req.end(JSON.stringify(body));
      } else {
        req.end();
      }
    });
  }

  it('lists domains via GET /__ironcurtain/domains', async () => {
    const controlSocket = join(tmpDir, 'control.sock');
    const result = await httpRequest(controlSocket, 'GET', '/__ironcurtain/domains');
    expect(result.statusCode).toBe(200);
    const listing = result.body as DomainListing;
    expect(listing.providers).toContain('api.anthropic.com');
    expect(listing.dynamic).toEqual([]);
  });

  it('adds a domain via POST /__ironcurtain/domains/add', async () => {
    const controlSocket = join(tmpDir, 'control.sock');
    const addResult = await httpRequest(controlSocket, 'POST', '/__ironcurtain/domains/add', {
      domain: 'api.example.com',
    });
    expect(addResult.statusCode).toBe(200);
    expect(addResult.body).toEqual({ added: true });

    const listResult = await httpRequest(controlSocket, 'GET', '/__ironcurtain/domains');
    const listing = listResult.body as DomainListing;
    expect(listing.dynamic).toContain('api.example.com');
  });

  it('removes a domain via POST /__ironcurtain/domains/remove', async () => {
    const controlSocket = join(tmpDir, 'control.sock');
    await httpRequest(controlSocket, 'POST', '/__ironcurtain/domains/add', { domain: 'api.example.com' });

    const removeResult = await httpRequest(controlSocket, 'POST', '/__ironcurtain/domains/remove', {
      domain: 'api.example.com',
    });
    expect(removeResult.statusCode).toBe(200);
    expect(removeResult.body).toEqual({ removed: true });
  });

  it('returns 400 for invalid domain', async () => {
    const controlSocket = join(tmpDir, 'control.sock');
    const result = await httpRequest(controlSocket, 'POST', '/__ironcurtain/domains/add', {
      domain: '*.bad.com',
    });
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: string }).error).toContain('Invalid domain format');
  });

  it('returns 400 for missing domain field', async () => {
    const controlSocket = join(tmpDir, 'control.sock');
    const result = await httpRequest(controlSocket, 'POST', '/__ironcurtain/domains/add', {});
    expect(result.statusCode).toBe(400);
    expect((result.body as { error: string }).error).toContain('Missing required field');
  });

  it('returns 404 for unknown endpoints', async () => {
    const controlSocket = join(tmpDir, 'control.sock');
    const result = await httpRequest(controlSocket, 'GET', '/unknown');
    expect(result.statusCode).toBe(404);
  });

  it('rejects adding a provider domain', async () => {
    const controlSocket = join(tmpDir, 'control.sock');
    const result = await httpRequest(controlSocket, 'POST', '/__ironcurtain/domains/add', {
      domain: 'api.anthropic.com',
    });
    expect(result.statusCode).toBe(200);
    expect(result.body).toEqual({ added: false });
  });
});
