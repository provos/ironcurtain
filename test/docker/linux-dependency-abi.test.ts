import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assertLinuxDependencyAbiCompatible,
  buildLinuxDependencyNativeProbeCommand,
  createLinuxDependencyAbiManifest,
  linuxDependencyVolumeName,
  loadLinuxDependencyAbiManifest,
  probeLinuxDependencyNativeModules,
  serializeLinuxDependencyAbiManifest,
  type LinuxDependencyAbiManifest,
} from '../../src/docker/linux-dependency-abi.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('Linux dependency ABI', () => {
  it('keys a dependency store on the full Linux ABI and lockfile tuple', () => {
    const first = manifest();
    const same = manifest();
    const changedLock = manifest({ lockfileBytes: Buffer.from('different lock') });

    expect(linuxDependencyVolumeName(first)).toBe(linuxDependencyVolumeName(same));
    expect(linuxDependencyVolumeName(first)).toMatch(/^ironcurtain-linux-deps-v1-[a-f0-9]{64}$/u);
    expect(linuxDependencyVolumeName(changedLock)).not.toBe(linuxDependencyVolumeName(first));
    expect(first.nativeModules).toEqual(['isolated-vm', 'node-pty']);
  });

  it('loads only a strict, non-writable, non-symlink manifest', () => {
    const directory = tempDirectory();
    const path = join(directory, '.ironcurtain-linux-dependencies.json');
    writeFileSync(path, serializeLinuxDependencyAbiManifest(manifest()), { mode: 0o444 });
    expect(loadLinuxDependencyAbiManifest(path)).toEqual(manifest());

    chmodSync(path, 0o666);
    expect(() => loadLinuxDependencyAbiManifest(path)).toThrow(/group\/world writable/u);
    chmodSync(path, 0o444);
    const link = join(directory, 'manifest-link.json');
    symlinkSync(path, link);
    expect(() => loadLinuxDependencyAbiManifest(link)).toThrow(/non-symlink/u);
  });

  it('reports every incompatible tuple field instead of accepting a nearby ABI', () => {
    const expected = manifest();
    const actual = {
      ...expected,
      architecture: 'amd64' as const,
      nodeAbi: '999',
      packageManager: { name: 'npm' as const, version: '99.0.0' },
    };
    expect(() => assertLinuxDependencyAbiCompatible(actual, expected)).toThrow(
      /architecture, nodeAbi, packageManager/u,
    );
  });

  it('builds a Linux-side probe that checks the runtime tuple and loads both native modules', () => {
    const command = buildLinuxDependencyNativeProbeCommand(manifest());
    expect(command.slice(0, 4)).toEqual(['node', '--no-warnings', '--input-type=module', '-e']);
    expect(command[4]).toContain("require('isolated-vm')");
    expect(command[4]).toContain("require('node-pty')");
    expect(command[4]).toContain('new ivm.Isolate');
    expect(command[4]).toContain('/workspace/package.json');
  });

  it('accepts only a schema-valid successful native result from the exact container/workspace', async () => {
    const expected = manifest();
    const exec = vi.fn(async () => ({
      exitCode: 0,
      stderr: '',
      stdout: JSON.stringify({
        platform: 'linux',
        architecture: 'arm64',
        nodeVersion: '24.4.0',
        nodeAbi: '137',
        libc: { family: 'glibc', version: '2.36' },
        isolatedVm: 'created',
        nodePty: 'loaded',
      }),
    }));
    await expect(probeLinuxDependencyNativeModules({ exec }, 'agent-id', expected)).resolves.toMatchObject({
      isolatedVm: 'created',
      nodePty: 'loaded',
    });
    expect(exec).toHaveBeenCalledWith('agent-id', expect.any(Array), 15_000, undefined, '/workspace');
  });

  it('fails closed on a native crash, malformed output, or reported tuple mismatch', async () => {
    const expected = manifest();
    await expect(
      probeLinuxDependencyNativeModules(
        { exec: async () => ({ exitCode: 139, stdout: '', stderr: 'segmentation fault' }) },
        'agent-id',
        expected,
      ),
    ).rejects.toThrow(/exit 139.*segmentation fault/u);
    await expect(
      probeLinuxDependencyNativeModules(
        { exec: async () => ({ exitCode: 0, stdout: 'not-json', stderr: '' }) },
        'agent-id',
        expected,
      ),
    ).rejects.toThrow(/invalid JSON/u);
    await expect(
      probeLinuxDependencyNativeModules(
        {
          exec: async () => ({
            exitCode: 0,
            stderr: '',
            stdout: JSON.stringify({
              platform: 'linux',
              architecture: 'amd64',
              nodeVersion: '24.4.0',
              nodeAbi: '137',
              libc: { family: 'glibc', version: '2.36' },
              isolatedVm: 'created',
              nodePty: 'loaded',
            }),
          }),
        },
        'agent-id',
        expected,
      ),
    ).rejects.toThrow(/architecture/u);
  });
});

function manifest(overrides: Partial<{ lockfileBytes: Uint8Array }> = {}): LinuxDependencyAbiManifest {
  return createLinuxDependencyAbiManifest({
    architecture: 'arm64',
    nodeVersion: '24.4.0',
    nodeAbi: '137',
    libc: { family: 'glibc', version: '2.36' },
    npmVersion: '11.4.2',
    lockfileBytes: overrides.lockfileBytes ?? Buffer.from('{"lockfileVersion":3}'),
  });
}

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'linux-dependency-abi-'));
  temporaryDirectories.push(directory);
  return directory;
}
