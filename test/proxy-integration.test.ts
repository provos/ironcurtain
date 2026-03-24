/**
 * Integration test for the proxy MCP server feature.
 *
 * Tests the end-to-end flow of:
 * 1. MITM proxy with control socket for dynamic domain management
 * 2. Control API client talking to the real control socket
 * 3. handleVirtualProxyTool dispatching through the control API
 * 4. MITM proxy accepting/rejecting CONNECT requests based on dynamic domains
 * 5. Policy evaluation for proxy tools (add escalates, remove/list allow)
 *
 * No internet access or Docker required -- we test the host-side components
 * by verifying CONNECT acceptance (200) vs rejection (403).
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as http from 'node:http';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { loadOrCreateCA, type CertificateAuthority } from '../src/docker/ca.js';
import { createMitmProxy, type MitmProxy } from '../src/docker/mitm-proxy.js';
import {
  createControlApiClient,
  handleVirtualProxyTool,
  proxyPolicyRules,
  proxyAnnotations,
  type ControlApiClient,
} from '../src/docker/proxy-tools.js';
import { PolicyEngine } from '../src/trusted-process/policy-engine.js';
import type { ProviderConfig } from '../src/docker/provider-config.js';
import type { CompiledPolicyFile, StoredToolAnnotationsFile } from '../src/pipeline/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Sends a CONNECT request to the proxy via UDS, returns status code. */
function sendConnect(
  socketPath: string,
  host: string,
  port: number,
): Promise<{ socket: import('node:net').Socket | null; statusCode: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath,
      method: 'CONNECT',
      path: `${host}:${port}`,
    });

    req.on('connect', (res, socket) => {
      resolve({ socket, statusCode: res.statusCode ?? 0 });
    });

    req.on('error', reject);

    req.on('response', (res) => {
      resolve({ socket: null, statusCode: res.statusCode ?? 0 });
    });

    req.end();
  });
}

/** Builds a compiled policy file from the proxy policy rules. */
function buildProxyPolicyRules(): CompiledPolicyFile {
  return {
    generatedAt: 'test-fixture',
    constitutionHash: 'test',
    inputHash: 'test',
    rules: proxyPolicyRules,
  };
}

/** Builds a PolicyEngine with proxy tool annotations and rules. */
function buildProxyPolicyEngine(): PolicyEngine {
  const compiledPolicy = buildProxyPolicyRules();

  // PolicyEngine expects StoredToolAnnotationsFile with servers.{name}.tools structure
  const toolAnnotations: StoredToolAnnotationsFile = {
    servers: {
      proxy: {
        inputHash: 'test-fixture',
        tools: proxyAnnotations,
      },
    },
  };

  return new PolicyEngine(compiledPolicy, toolAnnotations, []);
}

// ---------------------------------------------------------------------------
// Shared infrastructure -- started once for the entire describe block
// ---------------------------------------------------------------------------

describe('Proxy MCP Server Integration', { timeout: 30_000 }, () => {
  let tempDir: string;
  let ca: CertificateAuthority;
  let proxy: MitmProxy;
  let controlClient: ControlApiClient;
  let mitmSocketPath: string;
  let controlSocketPath: string;

  const testProvider: ProviderConfig = {
    host: 'api.anthropic.com',
    displayName: 'Anthropic',
    fakeKeyPrefix: 'sk-ant-test-',
    keyInjection: { type: 'header', headerName: 'x-api-key' },
    allowedEndpoints: [{ method: 'POST', path: '/v1/messages' }],
  };

  const fakeKey = 'sk-ant-test-fake-integration-key';
  const realKey = 'sk-ant-real-integration-key';

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'proxy-integ-'));
    ca = loadOrCreateCA(join(tempDir, 'ca'));
    mitmSocketPath = join(tempDir, 'mitm.sock');
    controlSocketPath = join(tempDir, 'control.sock');

    proxy = createMitmProxy({
      socketPath: mitmSocketPath,
      ca,
      providers: [{ config: testProvider, fakeKey, realKey }],
      controlSocketPath,
    });
    await proxy.start();

    controlClient = createControlApiClient(`unix://${controlSocketPath}`);
  });

  afterAll(async () => {
    await proxy.stop().catch(() => {});
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // Section 1: Control API + MITM proxy domain management end-to-end
  // -----------------------------------------------------------------------

  describe('control API + MITM proxy domain management', () => {
    it('lists initial domains (providers only, no dynamic)', async () => {
      const listing = await controlClient.listDomains();
      expect(listing.providers).toContain('api.anthropic.com');
      expect(listing.dynamic).toEqual([]);
    });

    it('adds a domain via control API and MITM proxy accepts CONNECT', async () => {
      const addResult = await controlClient.addDomain('api.github.com');
      expect(addResult.added).toBe(true);

      // Verify the domain appears in listings
      const listing = await controlClient.listDomains();
      expect(listing.dynamic).toContain('api.github.com');

      // Verify MITM proxy accepts CONNECT to the newly added domain
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'api.github.com', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });

    it('rejects CONNECT to domains not in any allowlist', async () => {
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'evil.example.com', 443);
      expect(statusCode).toBe(403);
      socket?.destroy();
    });

    it('removes a dynamic domain and MITM proxy rejects CONNECT', async () => {
      // Add then remove
      await controlClient.addDomain('temp.example.com');
      const removeResult = await controlClient.removeDomain('temp.example.com');
      expect(removeResult.removed).toBe(true);

      // Verify removal
      const listing = await controlClient.listDomains();
      expect(listing.dynamic).not.toContain('temp.example.com');

      // Verify MITM proxy now rejects CONNECT
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'temp.example.com', 443);
      expect(statusCode).toBe(403);
      socket?.destroy();
    });

    it('cannot add a provider domain as passthrough', async () => {
      const result = await controlClient.addDomain('api.anthropic.com');
      expect(result.added).toBe(false);
    });

    it('rejects invalid domains via control API', async () => {
      await expect(controlClient.addDomain('*.wildcard.com')).rejects.toThrow('Control API 400');
      await expect(controlClient.addDomain('127.0.0.1')).rejects.toThrow('Control API 400');
      await expect(controlClient.addDomain('host.docker.internal')).rejects.toThrow('Control API 400');
    });

    it('duplicate add returns false', async () => {
      await controlClient.addDomain('dup.example.com');
      const second = await controlClient.addDomain('dup.example.com');
      expect(second.added).toBe(false);
    });

    it('remove of non-existent domain returns false', async () => {
      const result = await controlClient.removeDomain('nonexistent.example.com');
      expect(result.removed).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Section 2: handleVirtualProxyTool through real control API
  // -----------------------------------------------------------------------

  describe('handleVirtualProxyTool with real control API', () => {
    it('add_proxy_domain adds domain via control API', async () => {
      const result = await handleVirtualProxyTool(
        'add_proxy_domain',
        { domain: 'api.newdomain.com', justification: 'integration test' },
        controlClient,
      );
      expect(result).toEqual({ status: 'added', domain: 'api.newdomain.com' });

      // Verify the domain was actually added to the MITM proxy
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'api.newdomain.com', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });

    it('remove_proxy_domain removes domain via control API', async () => {
      // First ensure the domain exists
      await controlClient.addDomain('api.removeme.com');

      const result = await handleVirtualProxyTool('remove_proxy_domain', { domain: 'api.removeme.com' }, controlClient);
      expect(result).toEqual({ status: 'removed', domain: 'api.removeme.com' });

      // Verify the MITM proxy now rejects
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'api.removeme.com', 443);
      expect(statusCode).toBe(403);
      socket?.destroy();
    });

    it('list_proxy_domains returns current state from control API', async () => {
      const result = (await handleVirtualProxyTool('list_proxy_domains', {}, controlClient)) as {
        providers: string[];
        dynamic: string[];
      };
      expect(result.providers).toContain('api.anthropic.com');
      expect(Array.isArray(result.dynamic)).toBe(true);
    });

    it('add_proxy_domain returns already_accessible for provider domains', async () => {
      const result = await handleVirtualProxyTool(
        'add_proxy_domain',
        { domain: 'api.anthropic.com', justification: 'test' },
        controlClient,
      );
      expect(result).toEqual({
        status: 'already_accessible',
        message: 'Domain is already accessible (built-in provider)',
      });
    });

    it('add_proxy_domain validates domain format', async () => {
      await expect(
        handleVirtualProxyTool('add_proxy_domain', { domain: '*.bad.com', justification: 'test' }, controlClient),
      ).rejects.toThrow('Invalid domain format');
    });

    it('add_proxy_domain rejects docker.internal domains', async () => {
      await expect(
        handleVirtualProxyTool(
          'add_proxy_domain',
          { domain: 'gateway.docker.internal', justification: 'test' },
          controlClient,
        ),
      ).rejects.toThrow('docker.internal');
    });

    it('add_proxy_domain rejects missing domain', async () => {
      await expect(
        handleVirtualProxyTool('add_proxy_domain', { justification: 'test' }, controlClient),
      ).rejects.toThrow('Missing or invalid required argument: domain');
    });

    it('add_proxy_domain rejects IP addresses', async () => {
      await expect(
        handleVirtualProxyTool('add_proxy_domain', { domain: '10.0.0.1', justification: 'test' }, controlClient),
      ).rejects.toThrow('IP addresses are not allowed');
    });
  });

  // -----------------------------------------------------------------------
  // Section 3: Policy evaluation for proxy tools
  // -----------------------------------------------------------------------

  describe('policy evaluation for proxy tools', () => {
    let policyEngine: PolicyEngine;

    beforeAll(() => {
      policyEngine = buildProxyPolicyEngine();
    });

    it('escalates add_proxy_domain', () => {
      const result = policyEngine.evaluate({
        requestId: 'test-1',
        serverName: 'proxy',
        toolName: 'add_proxy_domain',
        arguments: { domain: 'api.example.com', justification: 'need it' },
        timestamp: new Date().toISOString(),
      });
      expect(result.decision).toBe('escalate');
    });

    it('allows remove_proxy_domain', () => {
      const result = policyEngine.evaluate({
        requestId: 'test-2',
        serverName: 'proxy',
        toolName: 'remove_proxy_domain',
        arguments: { domain: 'api.example.com' },
        timestamp: new Date().toISOString(),
      });
      expect(result.decision).toBe('allow');
    });

    it('allows list_proxy_domains', () => {
      const result = policyEngine.evaluate({
        requestId: 'test-3',
        serverName: 'proxy',
        toolName: 'list_proxy_domains',
        arguments: {},
        timestamp: new Date().toISOString(),
      });
      expect(result.decision).toBe('allow');
    });
  });

  // -----------------------------------------------------------------------
  // Section 4: Full flow -- policy + virtual tool handler + MITM verification
  // -----------------------------------------------------------------------

  describe('full flow: policy -> handler -> MITM verification', () => {
    let policyEngine: PolicyEngine;

    beforeAll(() => {
      policyEngine = buildProxyPolicyEngine();
    });

    it('list -> allow -> handler returns domain listing from MITM', async () => {
      // Step 1: Policy evaluation
      const decision = policyEngine.evaluate({
        requestId: 'flow-list',
        serverName: 'proxy',
        toolName: 'list_proxy_domains',
        arguments: {},
        timestamp: new Date().toISOString(),
      });
      expect(decision.decision).toBe('allow');

      // Step 2: Handler dispatches to control API
      const result = (await handleVirtualProxyTool('list_proxy_domains', {}, controlClient)) as {
        providers: string[];
        dynamic: string[];
      };
      expect(result.providers).toContain('api.anthropic.com');
    });

    it('remove -> allow -> handler removes -> MITM rejects CONNECT', async () => {
      // Setup: add a domain first
      await controlClient.addDomain('api.flow-test.com');

      // Step 1: Policy allows remove
      const decision = policyEngine.evaluate({
        requestId: 'flow-remove',
        serverName: 'proxy',
        toolName: 'remove_proxy_domain',
        arguments: { domain: 'api.flow-test.com' },
        timestamp: new Date().toISOString(),
      });
      expect(decision.decision).toBe('allow');

      // Step 2: Handler removes via control API
      const result = await handleVirtualProxyTool(
        'remove_proxy_domain',
        { domain: 'api.flow-test.com' },
        controlClient,
      );
      expect(result).toEqual({ status: 'removed', domain: 'api.flow-test.com' });

      // Step 3: MITM proxy rejects CONNECT
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'api.flow-test.com', 443);
      expect(statusCode).toBe(403);
      socket?.destroy();
    });

    it('add -> escalate (would need human approval in real flow)', async () => {
      // Step 1: Policy escalates add
      const decision = policyEngine.evaluate({
        requestId: 'flow-add',
        serverName: 'proxy',
        toolName: 'add_proxy_domain',
        arguments: { domain: 'api.new-service.com', justification: 'need API access' },
        timestamp: new Date().toISOString(),
      });
      expect(decision.decision).toBe('escalate');
      expect(decision.reason).toContain('human review');

      // In a real flow, the escalation handler would get human approval.
      // After approval, the handler would be called:
      const result = await handleVirtualProxyTool(
        'add_proxy_domain',
        { domain: 'api.new-service.com', justification: 'need API access' },
        controlClient,
      );
      expect(result).toEqual({ status: 'added', domain: 'api.new-service.com' });

      // Verify MITM proxy now accepts CONNECT
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'api.new-service.com', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Section 5: MITM proxy provider domain isolation
  // -----------------------------------------------------------------------

  describe('MITM proxy provider vs passthrough isolation', () => {
    it('provider domain is always accessible via CONNECT', async () => {
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'api.anthropic.com', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });

    it('removing a provider domain via control API returns false', async () => {
      const result = await controlClient.removeDomain('api.anthropic.com');
      expect(result.removed).toBe(false);

      // Provider domain still accessible
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'api.anthropic.com', 443);
      expect(statusCode).toBe(200);
      socket?.destroy();
    });

    it('multiple dynamic domains can coexist', async () => {
      await controlClient.addDomain('svc-a.example.com');
      await controlClient.addDomain('svc-b.example.com');

      const listing = await controlClient.listDomains();
      expect(listing.dynamic).toContain('svc-a.example.com');
      expect(listing.dynamic).toContain('svc-b.example.com');

      // Both should be accessible
      const connA = await sendConnect(mitmSocketPath, 'svc-a.example.com', 443);
      expect(connA.statusCode).toBe(200);
      connA.socket?.destroy();

      const connB = await sendConnect(mitmSocketPath, 'svc-b.example.com', 443);
      expect(connB.statusCode).toBe(200);
      connB.socket?.destroy();

      // Remove one, the other should still work
      await controlClient.removeDomain('svc-a.example.com');

      const connA2 = await sendConnect(mitmSocketPath, 'svc-a.example.com', 443);
      expect(connA2.statusCode).toBe(403);
      connA2.socket?.destroy();

      const connB2 = await sendConnect(mitmSocketPath, 'svc-b.example.com', 443);
      expect(connB2.statusCode).toBe(200);
      connB2.socket?.destroy();
    });
  });

  // -----------------------------------------------------------------------
  // Section 6: Spawned mcp-proxy-server in virtual-only mode
  // -----------------------------------------------------------------------

  describe('spawned mcp-proxy-server in virtual-only mode', { timeout: 30_000 }, () => {
    let mcpClient: InstanceType<typeof import('@modelcontextprotocol/sdk/client/index.js').Client>;
    let transport: InstanceType<typeof import('@modelcontextprotocol/sdk/client/stdio.js').StdioClientTransport>;

    beforeAll(async () => {
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

      const auditLogPath = join(tempDir, 'section6-audit.jsonl');
      const generatedDir = resolve(__dirname, '..', 'src', 'config', 'generated');

      transport = new StdioClientTransport({
        command: 'npx',
        args: ['tsx', 'src/trusted-process/mcp-proxy-server.ts'],
        env: {
          ...process.env,
          SERVER_FILTER: 'proxy',
          MCP_SERVERS_CONFIG: '{}',
          MITM_CONTROL_ADDR: `unix://${controlSocketPath}`,
          AUDIT_LOG_PATH: auditLogPath,
          GENERATED_DIR: generatedDir,
          ALLOWED_DIRECTORY: tempDir,
          PROTECTED_PATHS: '[]',
        } as Record<string, string>,
        stderr: 'pipe',
      });

      mcpClient = new Client({ name: 'proxy-integ-section6', version: '0.1.0' }, { capabilities: {} });
      await mcpClient.connect(transport);
    });

    afterAll(async () => {
      try {
        await mcpClient.close();
      } catch {
        /* ignore */
      }
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
    });

    it('starts successfully and lists the 3 proxy tools', async () => {
      const { tools } = await mcpClient.listTools();
      const toolNames = tools.map((t) => t.name);
      expect(toolNames).toContain('add_proxy_domain');
      expect(toolNames).toContain('remove_proxy_domain');
      expect(toolNames).toContain('list_proxy_domains');
      expect(toolNames).toHaveLength(3);
    });

    it('list_proxy_domains returns data from the real control API', async () => {
      const result = await mcpClient.callTool({
        name: 'list_proxy_domains',
        arguments: {},
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0].text);
      expect(data.providers).toContain('api.anthropic.com');
      expect(Array.isArray(data.dynamic)).toBe(true);
    });

    it('remove_proxy_domain works end-to-end with a dynamically added domain', async () => {
      // Add a domain via the control client (bypassing policy)
      await controlClient.addDomain('section6-remove.example.com');

      // Verify it exists
      const beforeListing = await controlClient.listDomains();
      expect(beforeListing.dynamic).toContain('section6-remove.example.com');

      // Remove via MCP tool call through the spawned proxy server
      const result = await mcpClient.callTool({
        name: 'remove_proxy_domain',
        arguments: { domain: 'section6-remove.example.com' },
      });
      expect(result.isError).toBeFalsy();
      const content = result.content as Array<{ type: string; text: string }>;
      const data = JSON.parse(content[0].text);
      expect(data.status).toBe('removed');

      // Verify MITM proxy now rejects CONNECT to that domain
      const { socket, statusCode } = await sendConnect(mitmSocketPath, 'section6-remove.example.com', 443);
      expect(statusCode).toBe(403);
      socket?.destroy();
    });

    it('add_proxy_domain is escalated by the policy engine', async () => {
      // No ESCALATION_DIR is set, so escalation auto-denies with an error message
      const result = await mcpClient.callTool({
        name: 'add_proxy_domain',
        arguments: { domain: 'section6-add.example.com', justification: 'integration test' },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      expect(content[0].text).toContain('ESCALATION REQUIRED');
      expect(content[0].text).toContain('no escalation handler');
    });
  });
});
