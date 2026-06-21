import { describe, it, expect } from 'vitest';
import { resolveContainerSpawnCommand, commandExists } from '../src/trusted-process/container-command.js';

const GITHUB_ARGS = ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'];

function exists(bins: string[]): (bin: string) => boolean {
  return (bin) => bins.includes(bin);
}

describe('resolveContainerSpawnCommand', () => {
  it('translates docker run to container when only container exists', () => {
    const spec = resolveContainerSpawnCommand('docker', GITHUB_ARGS, exists(['container']));
    expect(spec.translated).toBe(true);
    expect(spec.command).toBe('container');
    // Argument array passes through untouched.
    expect(spec.args).toEqual(GITHUB_ARGS);
  });

  it('keeps docker when docker exists (even alongside container)', () => {
    const spec = resolveContainerSpawnCommand('docker', GITHUB_ARGS, exists(['docker', 'container']));
    expect(spec.translated).toBe(false);
    expect(spec.command).toBe('docker');
  });

  it('keeps docker when neither binary exists (connect failure handles it)', () => {
    const spec = resolveContainerSpawnCommand('docker', GITHUB_ARGS, exists([]));
    expect(spec.translated).toBe(false);
    expect(spec.command).toBe('docker');
  });

  it('never touches non-run docker subcommands', () => {
    const spec = resolveContainerSpawnCommand('docker', ['exec', 'c1', 'sh'], exists(['container']));
    expect(spec.translated).toBe(false);
    expect(spec.command).toBe('docker');
  });

  it('never touches non-docker commands', () => {
    const spec = resolveContainerSpawnCommand('npx', ['-y', 'some-server'], exists(['container']));
    expect(spec.translated).toBe(false);
    expect(spec.command).toBe('npx');
  });
});

describe('commandExists', () => {
  it('finds a binary that exists and caches the probe', () => {
    expect(commandExists('node')).toBe(true);
    expect(commandExists('node')).toBe(true);
  });

  it('reports a missing binary as absent', () => {
    expect(commandExists('ironcurtain-definitely-not-a-binary-xyz')).toBe(false);
  });
});
