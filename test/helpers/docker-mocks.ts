/**
 * Shared mock factories for Docker-related tests. Kept in a dedicated
 * helper because both `docker-session.test.ts` and
 * `docker-infrastructure.test.ts` need the same shapes, and duplicating
 * them drifts as the underlying interfaces evolve.
 *
 * Per-file wrappers (e.g., `createTeardownSpies`, `makeInfrastructureBundle`,
 * `createMockInfra`) stay with their tests -- they are tightly coupled to
 * one test file's assertions and don't belong here.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAdapter, AgentId, AgentResponse } from '../../src/docker/agent-adapter.js';
import type { CertificateAuthority } from '../../src/docker/ca.js';
import type { DockerProxy } from '../../src/docker/code-mode-proxy.js';
import type { MitmProxy } from '../../src/docker/mitm-proxy.js';
import type { DockerContainerConfig, DockerExecResult, DockerManager } from '../../src/docker/types.js';

/**
 * Call-tracking for `createMockDocker`. When a tracker is passed in,
 * every relevant mock method pushes its arguments onto the tracker's
 * arrays so tests can assert on the full call history.
 */
export interface DockerCallTracker {
  readonly createCalls: DockerContainerConfig[];
  readonly startCalls: string[];
  readonly stoppedContainers: string[];
  readonly removedContainers: string[];
  readonly removedNetworks: string[];
  readonly createdNetworks: Array<{ name: string; options?: Record<string, unknown> }>;
}

export interface CreateMockDockerOptions {
  /** Optional tracker. When present, mock methods append call data to it. */
  readonly tracker?: DockerCallTracker;
  /** Script behavior of `docker.exec` (used for connectivity check). */
  readonly exec?: (container: string, cmd: readonly string[]) => Promise<DockerExecResult>;
  /** Intercept `docker.create` after tracking (lets tests return specific IDs). */
  readonly create?: (config: DockerContainerConfig) => Promise<string>;
}

export function createDockerCallTracker(): DockerCallTracker {
  return {
    createCalls: [],
    startCalls: [],
    stoppedContainers: [],
    removedContainers: [],
    removedNetworks: [],
    createdNetworks: [],
  };
}

/**
 * Builds a DockerManager mock suitable for both session and infrastructure
 * tests. When no tracker is passed, the mock behaves like a simple stub
 * (no call recording). When a tracker is passed, each relevant method
 * records its arguments so tests can assert on exact container
 * configuration and cleanup paths.
 *
 * Image labels are tracked internally so the `imageExists`/`getImageLabel`
 * pair mirrors real Docker: the first `buildImage` call stamps a hash,
 * subsequent `imageExists` checks return true, and `getImageLabel`
 * returns the stamped hash (enabling staleness-detection tests).
 */
export function createMockDocker(options: CreateMockDockerOptions = {}): DockerManager {
  const { tracker, exec: execOverride, create: createOverride } = options;

  // Track build-hash labels so ensureImage()'s staleness-detection path
  // is testable: first build stamps a hash; subsequent calls see it.
  const labels = new Map<string, Record<string, string>>();
  let createSeq = 0;

  return {
    async preflight() {},
    async create(config: DockerContainerConfig) {
      tracker?.createCalls.push(config);
      if (createOverride) return createOverride(config);
      createSeq++;
      return `container-${createSeq}`;
    },
    async start(id: string) {
      tracker?.startCalls.push(id);
    },
    async exec(container: string, cmd: readonly string[]) {
      if (execOverride) return execOverride(container, cmd);
      return { exitCode: 0, stdout: 'Task completed successfully', stderr: '' };
    },
    async stop(id: string) {
      tracker?.stoppedContainers.push(id);
    },
    async remove(id: string) {
      tracker?.removedContainers.push(id);
    },
    async isRunning() {
      return true;
    },
    async imageExists(image: string) {
      // alpine/socat is always available (no build needed).
      if (image === 'alpine/socat') return true;
      // Other images "exist" once they have been built (have labels).
      // Tests that want all images to exist without building pass a
      // tracker + don't exercise the build path.
      return labels.has(image);
    },
    async pullImage() {},
    async buildImage(tag: string, _df: string, _ctx: string, buildLabels?: Record<string, string>) {
      if (buildLabels) {
        labels.set(tag, buildLabels);
      }
    },
    async getImageLabel(image: string, label: string) {
      return labels.get(image)?.[label];
    },
    async createNetwork(name: string, networkOptions?: { internal?: boolean; subnet?: string; gateway?: string }) {
      tracker?.createdNetworks.push({ name, options: networkOptions });
    },
    async removeNetwork(name: string) {
      tracker?.removedNetworks.push(name);
    },
    async connectNetwork() {},
    async getContainerIp() {
      return '172.30.0.3';
    },
    async containerExists() {
      return false;
    },
    async getContainerLabel() {
      return undefined;
    },
    async removeStaleContainer() {
      return false;
    },
  };
}

/**
 * Builds a scripted `exec` function for `createMockDocker`. Each call
 * to `exec` returns the next `DockerExecResult` from `results`; once the
 * list is exhausted, the last result is repeated (so long-running tests
 * don't have to pre-compute an exact call count).
 *
 * Also records every invocation's command array in `calls`, enabling
 * assertions on flag rotation (e.g., that a retry uses `--session-id`
 * with a DIFFERENT UUID than the initial attempt).
 */
export function scriptedExec(results: readonly DockerExecResult[]): {
  readonly exec: (container: string, cmd: readonly string[]) => Promise<DockerExecResult>;
  readonly calls: readonly string[][];
} {
  if (results.length === 0) throw new Error('scriptedExec requires at least one result');
  const calls: string[][] = [];
  let i = 0;
  return {
    exec: async (_container, cmd) => {
      calls.push([...cmd]);
      const result = results[Math.min(i, results.length - 1)];
      i++;
      return result;
    },
    calls,
  };
}

/** Minimal AgentAdapter mock with deterministic, assertable outputs. */
export function createMockAdapter(): AgentAdapter {
  return {
    id: 'test-agent' as AgentId,
    displayName: 'Test Agent',
    async getImage() {
      return 'ironcurtain-claude-code:latest';
    },
    generateMcpConfig() {
      return [{ path: 'test-config.json', content: '{}' }];
    },
    generateOrientationFiles() {
      return [];
    },
    buildCommand(message: string, systemPrompt: string) {
      return ['test-agent', '--prompt', systemPrompt, message];
    },
    buildSystemPrompt() {
      return 'You are a test agent.';
    },
    getProviders() {
      return [];
    },
    buildEnv() {
      return { TEST_KEY: 'test-value' };
    },
    extractResponse(exitCode: number, stdout: string): AgentResponse {
      if (exitCode !== 0) return { text: `Error: exit ${exitCode}` };
      return { text: stdout.trim() };
    },
  };
}

/** Minimal DockerProxy mock. Optional port simulates TCP mode. */
export function createMockProxy(socketPath: string, port?: number): DockerProxy {
  return {
    socketPath,
    port,
    async start() {},
    getHelpData() {
      return {
        serverDescriptions: { filesystem: 'Read, write, and manage files' },
        toolsByServer: {
          filesystem: [{ callableName: 'filesystem.read_file', params: '{ path }' }],
        },
      };
    },
    async stop() {},
  };
}

/** Minimal MitmProxy mock. */
export function createMockMitmProxy(): MitmProxy {
  return {
    async start() {
      return { socketPath: '/tmp/test-mitm-proxy.sock' };
    },
    async stop() {},
  };
}

/**
 * Builds a mock CertificateAuthority, writing a stub cert/key pair into
 * `tempDir` so code paths that read `certPath`/`keyPath` don't crash.
 */
export function createMockCA(tempDir: string): CertificateAuthority {
  const certPem = '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----';
  const keyPem = '-----BEGIN RSA PRIVATE KEY-----\nMOCK\n-----END RSA PRIVATE KEY-----';
  const certPath = join(tempDir, 'mock-ca-cert.pem');
  const keyPath = join(tempDir, 'mock-ca-key.pem');
  writeFileSync(certPath, certPem);
  writeFileSync(keyPath, keyPem);
  return { certPem, keyPem, certPath, keyPath };
}
