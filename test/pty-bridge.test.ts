/**
 * Unit tests for `buildSpawnArgs` (mux PTY bridge child-argv construction, F6).
 *
 * The argv construction was extracted from `createPtyBridge` into a pure,
 * exported function so the flag-append behavior — including the new
 * `--provider-profile <name>` (G13) — is testable without spawning a process.
 */

import { describe, it, expect } from 'vitest';
import { buildSpawnArgs, type PtyBridgeOptions } from '../src/mux/pty-bridge.js';

/** Minimal always-required options; per-test flags are layered on top. */
function baseOptions(overrides: Partial<PtyBridgeOptions> = {}): PtyBridgeOptions {
  return {
    cols: 80,
    rows: 24,
    ironcurtainBin: 'ironcurtain',
    agent: 'claude-code',
    ...overrides,
  };
}

describe('buildSpawnArgs', () => {
  it('always emits the start --pty --agent base', () => {
    expect(buildSpawnArgs(baseOptions())).toEqual(['start', '--pty', '--agent', 'claude-code']);
  });

  it('prepends prefixArgs (tsx loader / script path) before the subcommand', () => {
    const args = buildSpawnArgs(baseOptions({ prefixArgs: ['--import', 'tsx', '/path/cli.ts'] }));
    expect(args.slice(0, 5)).toEqual(['--import', 'tsx', '/path/cli.ts', 'start', '--pty']);
  });

  it('appends --provider-profile <name> when providerProfileName is set', () => {
    const args = buildSpawnArgs(baseOptions({ providerProfileName: 'kimi' }));
    expect(args).toContain('--provider-profile');
    const flagIdx = args.indexOf('--provider-profile');
    expect(args[flagIdx + 1]).toBe('kimi');
  });

  it('omits --provider-profile when providerProfileName is unset', () => {
    expect(buildSpawnArgs(baseOptions())).not.toContain('--provider-profile');
  });

  it('omits --provider-profile when providerProfileName is empty string', () => {
    expect(buildSpawnArgs(baseOptions({ providerProfileName: '' }))).not.toContain('--provider-profile');
  });

  // --- Pin existing flag behavior so the extraction didn't regress it. ---

  it('appends --workspace <path> when set, omits when unset', () => {
    expect(buildSpawnArgs(baseOptions({ workspacePath: '/w/s' }))).toContain('--workspace');
    const args = buildSpawnArgs(baseOptions({ workspacePath: '/w/s' }));
    expect(args[args.indexOf('--workspace') + 1]).toBe('/w/s');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--workspace');
  });

  it('appends --persona <name> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ persona: 'exec-assistant' }));
    expect(args[args.indexOf('--persona') + 1]).toBe('exec-assistant');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--persona');
  });

  it('appends --resume <id> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ resumeSessionId: 'session-xyz' }));
    expect(args[args.indexOf('--resume') + 1]).toBe('session-xyz');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--resume');
  });

  it('appends --model <id> when set, omits when unset', () => {
    const args = buildSpawnArgs(baseOptions({ model: 'claude-opus-4' }));
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--model');
  });

  it('appends --capture-traces (a boolean flag) only when true', () => {
    expect(buildSpawnArgs(baseOptions({ captureTraces: true }))).toContain('--capture-traces');
    expect(buildSpawnArgs(baseOptions({ captureTraces: false }))).not.toContain('--capture-traces');
    expect(buildSpawnArgs(baseOptions())).not.toContain('--capture-traces');
  });

  it('emits all selection flags together in the documented order', () => {
    const args = buildSpawnArgs(
      baseOptions({
        prefixArgs: ['/cli.js'],
        resumeSessionId: 'sid',
        workspacePath: '/ws',
        persona: 'p',
        providerProfileName: 'glm-5.2',
        model: 'm',
        captureTraces: true,
      }),
    );
    expect(args).toEqual([
      '/cli.js',
      'start',
      '--pty',
      '--agent',
      'claude-code',
      '--resume',
      'sid',
      '--workspace',
      '/ws',
      '--persona',
      'p',
      '--provider-profile',
      'glm-5.2',
      '--model',
      'm',
      '--capture-traces',
    ]);
  });
});
