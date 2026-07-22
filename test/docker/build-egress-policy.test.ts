import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  authorizeBuildEgressRequest,
  authorizeValidatedBuildEgressRequest,
  loadBuildEgressManifest,
  validateBuildEgressManifest,
  verifyBuildEgressDockerfileSources,
  type BuildEgressManifest,
} from '../../src/docker-workload/build-egress-policy.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('narrow current-Dockerfile build egress', () => {
  it('authorizes one exact parent-proxied rule and owns its limits/header surface', () => {
    expect(
      authorizeBuildEgressRequest(manifest(), {
        seam: 'run',
        method: 'GET',
        url: 'https://downloads.example.com/artifacts/tool.tar.gz?version=1',
        headers: { host: 'attacker.invalid', accept: 'application/octet-stream', 'user-agent': 'fixture/1' },
      }),
    ).toEqual({
      policyId: 'ironcurtain-current-dockerfiles-v1',
      ruleId: 'artifact-download',
      destination: {
        protocol: 'https:',
        hostname: 'downloads.example.com',
        port: 443,
        addressPolicy: 'fixed-parent-only',
      },
      method: 'GET',
      path: '/artifacts/tool.tar.gz?version=1',
      headers: { accept: 'application/octet-stream', 'user-agent': 'fixture/1' },
      responseBytes: 10 * 1024 * 1024,
      timeoutMs: 30_000,
      redirectChain: [],
    });
  });

  it.each([
    [
      { seam: 'base-image', method: 'GET', url: 'https://downloads.example.com/artifacts/tool.tar.gz' },
      /not authorized/u,
    ],
    [{ seam: 'run', method: 'POST', url: 'https://downloads.example.com/artifacts/tool.tar.gz' }, /method/u],
    [{ seam: 'run', method: 'GET', url: 'https://evil.example/artifacts/tool.tar.gz' }, /not authorized/u],
    [{ seam: 'run', method: 'GET', url: 'https://downloads.example.com/private/tool.tar.gz' }, /not authorized/u],
    [
      // An encoded slash inside an otherwise-matching prefix is rejected because
      // the rule does not opt into it (matches the prefix, then fails post-match).
      { seam: 'run', method: 'GET', url: 'https://downloads.example.com/artifacts/sub%2Fprivate' },
      /encoded separator/u,
    ],
    [
      { seam: 'run', method: 'GET', url: 'https://downloads.example.com/artifacts/%252e%252e/private' },
      /nested escape/u,
    ],
    [
      {
        seam: 'run',
        method: 'GET',
        url: 'https://downloads.example.com/artifacts/tool.tar.gz',
        headers: { authorization: 'Bearer secret' },
      },
      /credential header/u,
    ],
    [
      {
        seam: 'run',
        method: 'GET',
        url: 'https://downloads.example.com/artifacts/tool.tar.gz',
        headers: { 'x-unreviewed': 'value' },
      },
      /not allowed/u,
    ],
  ] as const)('rejects undeclared request behavior %#', (request, message) => {
    expect(() => authorizeBuildEgressRequest(manifest(), request)).toThrow(message);
  });

  it('authorizes an encoded slash only for a rule that opts in', () => {
    // npm requests scoped-package metadata as `/@scope%2fname`; the opted-in rule allows it.
    expect(
      authorizeBuildEgressRequest(manifest(), {
        seam: 'run',
        method: 'GET',
        url: 'https://registry.example.com/@anthropic-ai%2fclaude-code',
      }).ruleId,
    ).toBe('npm-registry');
    // The same encoding on a rule that did not opt in is rejected.
    expect(() =>
      authorizeBuildEgressRequest(manifest(), {
        seam: 'run',
        method: 'GET',
        url: 'https://downloads.example.com/artifacts/pkg%2fsub',
      }),
    ).toThrow(/encoded separator/u);
    // Opting into `%2f` does not admit an encoded backslash or a double-encoding.
    for (const smuggle of ['%5cwin', '%252e%252e/x']) {
      expect(() =>
        authorizeBuildEgressRequest(manifest(), {
          seam: 'run',
          method: 'GET',
          url: `https://registry.example.com/pkg${smuggle}`,
        }),
      ).toThrow(/encoded separator|nested escape/u);
    }
  });

  it('allows only an acyclic, declared redirect graph within the first rule hop ceiling', () => {
    expect(
      authorizeBuildEgressRequest(manifest(), {
        seam: 'run',
        method: 'GET',
        url: 'https://cdn.example.com/releases/tool.tar.gz',
        redirectChain: ['artifact-download'],
      }).ruleId,
    ).toBe('artifact-cdn');
    expect(() =>
      authorizeBuildEgressRequest(manifest(), {
        seam: 'run',
        method: 'GET',
        url: 'https://cdn.example.com/releases/tool.tar.gz',
        redirectChain: ['artifact-cdn'],
      }),
    ).toThrow(/loop/u);
    expect(() =>
      authorizeBuildEgressRequest(manifest(), {
        seam: 'run',
        method: 'GET',
        url: 'https://downloads.example.com/artifacts/tool.tar.gz',
        redirectChain: ['artifact-cdn'],
      }),
    ).toThrow(/hop limit|not authorized/u);
  });

  it('rejects ambiguous overlapping rules rather than using rule order', () => {
    const value = manifest();
    value.rules.push({ ...structuredClone(value.rules[0]), id: 'artifact-download-copy' });
    expect(() =>
      authorizeBuildEgressRequest(value, {
        seam: 'run',
        method: 'GET',
        url: 'https://downloads.example.com/artifacts/tool.tar.gz',
      }),
    ).toThrow(/ambiguously/u);
  });

  it('authorizes against a pre-validated manifest without re-parsing on the hot path', () => {
    // The guard validates once at construction and calls the validated hot path
    // per request; prove that seam authorizes a loaded manifest identically.
    const directory = tempDirectory();
    const path = join(directory, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest()), { mode: 0o400 });
    const loaded = loadBuildEgressManifest(path);
    const authorized = authorizeValidatedBuildEgressRequest(loaded.manifest, {
      seam: 'run',
      method: 'GET',
      url: 'https://downloads.example.com/artifacts/tool.tar.gz',
    });
    expect(authorized.ruleId).toBe('artifact-download');
    // The public entry still validates raw objects fail-closed for untrusted callers.
    expect(() => validateBuildEgressManifest({ ...manifest(), rules: [] })).toThrow();
  });

  it('binds authorization to exact regular Dockerfile bytes', () => {
    const directory = tempDirectory();
    const dockerDirectory = join(directory, 'docker');
    const dockerfile = join(dockerDirectory, 'Dockerfile.fixture');
    const bytes = Buffer.from('FROM scratch\n');
    mkdirSync(dockerDirectory);
    writeFileSync(dockerfile, bytes, { mode: 0o600 });
    const value = manifest();
    value.sourceDockerfiles = [
      { path: 'docker/Dockerfile.fixture', sha256: createHash('sha256').update(bytes).digest('hex') },
    ];
    expect(verifyBuildEgressDockerfileSources(value, directory)).toEqual([
      { path: 'docker/Dockerfile.fixture', sha256: value.sourceDockerfiles[0].sha256, sizeBytes: bytes.length },
    ]);
    writeFileSync(dockerfile, 'FROM busybox\n');
    expect(() => verifyBuildEgressDockerfileSources(value, directory)).toThrow(/hash mismatch/u);
    rmSync(dockerfile);
    symlinkSync('/etc/hosts', dockerfile);
    expect(() => verifyBuildEgressDockerfileSources(value, directory)).toThrow(/non-symlink/u);
  });

  it('loads only a strict non-writable non-symlink manifest with valid redirect references', () => {
    const directory = tempDirectory();
    const path = join(directory, 'manifest.json');
    writeFileSync(path, JSON.stringify(manifest()), { mode: 0o400 });
    expect(loadBuildEgressManifest(path).manifest.rules).toHaveLength(3);
    chmodSync(path, 0o666);
    expect(() => loadBuildEgressManifest(path)).toThrow(/group\/world writable/u);
    chmodSync(path, 0o400);
    const invalid = manifest();
    invalid.rules[0].redirects.allowedRuleIds = ['missing-rule'];
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify(invalid), { mode: 0o400 });
    chmodSync(path, 0o400);
    expect(() => loadBuildEgressManifest(path)).toThrow(/unknown target/u);
  });
});

function manifest(): BuildEgressManifest {
  return {
    schemaVersion: 1,
    policyId: 'ironcurtain-current-dockerfiles-v1',
    sourceDockerfiles: [{ path: 'docker/Dockerfile.fixture', sha256: '1'.repeat(64) }],
    rules: [
      {
        id: 'artifact-download',
        seams: ['run'],
        destination: {
          protocol: 'https:',
          hostname: 'downloads.example.com',
          port: 443,
          addressPolicy: 'fixed-parent-only',
        },
        methods: ['GET', 'HEAD'],
        paths: [{ kind: 'prefix', value: '/artifacts/', allowQuery: true }],
        redirects: { maxHops: 1, allowedRuleIds: ['artifact-cdn'] },
        requestHeaders: { allow: ['accept', 'user-agent'], strip: ['host', 'connection'] },
        limits: { responseBytes: 10 * 1024 * 1024, timeoutMs: 30_000 },
      },
      {
        id: 'artifact-cdn',
        seams: ['run'],
        destination: {
          protocol: 'https:',
          hostname: 'cdn.example.com',
          port: 443,
          addressPolicy: 'fixed-parent-only',
        },
        methods: ['GET', 'HEAD'],
        paths: [{ kind: 'prefix', value: '/releases/', allowQuery: false }],
        redirects: { maxHops: 0, allowedRuleIds: [] },
        requestHeaders: { allow: ['accept', 'user-agent'], strip: ['host', 'connection'] },
        limits: { responseBytes: 10 * 1024 * 1024, timeoutMs: 30_000 },
      },
      {
        // npm-style host that opts into an encoded slash for scoped-package metadata.
        id: 'npm-registry',
        seams: ['run'],
        destination: {
          protocol: 'https:',
          hostname: 'registry.example.com',
          port: 443,
          addressPolicy: 'fixed-parent-only',
        },
        methods: ['GET', 'HEAD'],
        paths: [{ kind: 'prefix', value: '/', allowQuery: false }],
        redirects: { maxHops: 0, allowedRuleIds: [] },
        requestHeaders: { allow: ['accept', 'user-agent'], strip: ['host', 'connection'] },
        limits: { responseBytes: 10 * 1024 * 1024, timeoutMs: 30_000 },
        allowEncodedSlash: true,
      },
    ],
  };
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'build-egress-policy-'));
  temporaryDirectories.push(directory);
  return directory;
}
