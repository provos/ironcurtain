import { lstatSync, realpathSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertSmokeSocketPathBudget,
  createSmokeRoot,
  parseSmokeTarget,
  withIronCurtainHome,
  workflowSmokePlacement,
} from '../scripts/smoke-environment.js';

describe('portable nested Docker smoke environment', () => {
  it('creates a short canonical private root independently of long TMPDIR values', () => {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = `/tmp/${'long-session-temp-directory-'.repeat(8)}`;
    const root = createSmokeRoot('ic-na-');
    try {
      expect(root).toBe(realpathSync(root));
      expect(root.startsWith(`${realpathSync('/tmp')}/ic-na-`)).toBe(true);
      expect(lstatSync(root).mode & 0o777).toBe(0o700);
      expect(() => assertSmokeSocketPathBudget(resolve(root, 'home'), 'darwin')).not.toThrow();
      expect(() => assertSmokeSocketPathBudget(resolve(root, 'home'), 'linux')).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  });

  it('rejects paths by encoded bytes and restores the caller home on failure', () => {
    const before = process.env.IRONCURTAIN_HOME;
    expect(() => assertSmokeSocketPathBudget(`/tmp/${'é'.repeat(50)}`, 'linux')).toThrow(/108 bytes/);
    expect(process.env.IRONCURTAIN_HOME).toBe(before);
    expect(() =>
      withIronCurtainHome('/tmp/smoke-home', () => {
        throw new Error('path failure');
      }),
    ).toThrow('path failure');
    expect(process.env.IRONCURTAIN_HOME).toBe(before);
  });

  it('accepts one explicit environment without consuming scenario arguments', () => {
    expect(parseSmokeTarget(['--offline', '--environment', 'wsl-desktop'])).toEqual({
      target: 'wsl-desktop',
      arguments: ['--offline'],
    });
    expect(parseSmokeTarget(['--environment', 'apple', '--pty'])).toEqual({
      target: 'apple',
      arguments: ['--pty'],
    });
    expect(parseSmokeTarget([])).toEqual({ target: undefined, arguments: [] });
  });

  it.each([
    ['--environment'],
    ['--environment', 'native-linux'],
    ['--environment', 'wsl-desktop', '--environment', 'apple'],
  ])('rejects missing, unsupported or repeated environments: %j', (...arguments_) => {
    expect(() => parseSmokeTarget(arguments_)).toThrow(/usage/);
  });

  it('uses the existing Docker runtime for WSL and separates daemon placement from runtime naming', () => {
    expect(workflowSmokePlacement('wsl-desktop')).toEqual({ runtimeKind: 'docker', daemonPlacement: 'sidecar' });
    expect(workflowSmokePlacement('docker-desktop')).toEqual({ runtimeKind: 'docker', daemonPlacement: 'sidecar' });
    expect(workflowSmokePlacement('apple')).toEqual({ runtimeKind: 'apple-container', daemonPlacement: 'same-vm' });
  });
});
