import { describe, expect, it } from 'vitest';
import {
  getBackendQualificationPlan,
  qualificationTimeoutMs,
  qualificationTerminationGraceMs,
} from '../../scripts/qualify-backend-plan.js';
import { PTY_CLEANUP_TIMEOUT_MS, PTY_GRACEFUL_EXIT_TIMEOUT_MS } from '../../scripts/pty-smoke-timeouts.js';
import { PTY_KILL_GRACE_MS } from '../../src/pty/pty-bridge.js';
import {
  WORKFLOW_CHILD_TIMEOUT_MS,
  WORKFLOW_CLEANUP_TIMEOUT_MS,
  WORKFLOW_GATE_TIMEOUT_MS,
} from '../../scripts/workflow-smoke-timeouts.js';
import {
  QUALIFICATION_TERM_GRACE_MS,
  QUALIFICATION_KILL_GRACE_MS,
} from '../../src/docker-workload/qualification-process.js';

describe('backend qualification plan', () => {
  it('lets PTY cancellation finish bridge termination and independent cleanup proof', () => {
    expect(PTY_GRACEFUL_EXIT_TIMEOUT_MS).toBe(PTY_KILL_GRACE_MS);
    for (const argument of ['--pty', '--docker-desktop-pty']) {
      expect(qualificationTerminationGraceMs({ arguments: [argument] })).toBeGreaterThan(
        PTY_KILL_GRACE_MS + 20_000 + PTY_CLEANUP_TIMEOUT_MS,
      );
    }
    expect(qualificationTerminationGraceMs({ arguments: [] })).toBeUndefined();
    expect(qualificationTerminationGraceMs({ arguments: ['--docker-desktop-offline'] })).toBeUndefined();
  });

  it('allows both workflow phases and their teardown before the outer deadline', () => {
    expect(qualificationTimeoutMs(undefined, 'smoke-nested-apple-workflow.ts')).toBe(WORKFLOW_GATE_TIMEOUT_MS);
    expect(WORKFLOW_GATE_TIMEOUT_MS).toBe(
      2 *
        (WORKFLOW_CHILD_TIMEOUT_MS +
          QUALIFICATION_TERM_GRACE_MS +
          QUALIFICATION_KILL_GRACE_MS +
          WORKFLOW_CLEANUP_TIMEOUT_MS) +
        10 * 60_000,
    );
    expect(qualificationTimeoutMs(undefined, 'smoke-nested-apple.ts')).toBe(30 * 60_000);
    expect(qualificationTimeoutMs(undefined)).toBe(30 * 60_000);
  });

  it.each([undefined, 'smoke-nested-apple.ts', 'smoke-nested-apple-workflow.ts'] as const)(
    'honors explicit timeout overrides for %s',
    (script) => expect(qualificationTimeoutMs('12345', script)).toBe(12345),
  );

  it.each(['', '99', 'NaN', '123.5', '86400001'])('rejects invalid timeout %j', (value) => {
    expect(() => qualificationTimeoutMs(value, 'smoke-nested-apple-workflow.ts')).toThrow(/timeout is invalid/);
  });

  it('runs every Apple network mode through the workflow gate, then the PTY transport gate', () => {
    const plan = getBackendQualificationPlan('apple');
    expect(plan.suiteId).toBe('apple');
    expect(plan.testFiles).toContain('test/apple-container.integration.test.ts');
    expect(plan.liveGates).toEqual([
      { script: 'smoke-nested-apple-workflow.ts', arguments: ['--packages'] },
      { script: 'smoke-nested-apple-workflow.ts', arguments: ['--images'] },
      { script: 'smoke-nested-apple-workflow.ts', arguments: ['--offline'] },
      { script: 'smoke-nested-apple.ts', arguments: ['--pty'] },
    ]);
  });

  it('runs crash recovery first, then feature-off and every Docker Desktop network mode', () => {
    const plan = getBackendQualificationPlan('docker-desktop');
    expect(plan.suiteId).toBe('docker-desktop');
    expect(plan.liveGates).toEqual([
      { script: 'smoke-nested-apple.ts', arguments: ['--docker-desktop-recovery'] },
      { script: 'smoke-nested-apple.ts', arguments: ['--docker-desktop-disabled'] },
      { script: 'smoke-nested-apple.ts', arguments: ['--docker-desktop-pty'] },
      { script: 'smoke-nested-apple.ts', arguments: ['--docker-desktop-offline'] },
      { script: 'smoke-nested-apple.ts', arguments: ['--docker-desktop-images'] },
      { script: 'smoke-nested-apple.ts', arguments: ['--docker-desktop-packages'] },
    ]);
    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        'test/docker/docker-workload-prepare-failure.test.ts',
        'test/proxy-router-mode.test.ts',
        'test/docker/desktop-relay.test.ts',
        'test/docker/pty-nested-ordering.test.ts',
        'test/docker/pty-cleanup.test.ts',
        'test/docker-workload/docker-desktop-sidecar.test.ts',
        'test/docker-workload/infrastructure-reconciliation.test.ts',
        'test/docker-workload/infrastructure-teardown.test.ts',
        'test/docker-workload/watchdog-sigkill.integration.test.ts',
      ]),
    );
  });

  it.each([undefined, '', 'docker', 'linux'])('rejects unsupported backend %j', (backend) => {
    expect(() => getBackendQualificationPlan(backend)).toThrow(/apple or docker-desktop/u);
  });

  it('qualifies WSL with shared Docker scenarios and workflow modes without requiring other live runners', () => {
    const plan = getBackendQualificationPlan('wsl-desktop');
    expect(plan.suiteId).toBe('wsl-desktop');
    expect(plan.testEnvironment).toEqual({ DESKTOP_RELAY_UDS_INTEGRATION: '1' });
    expect(plan.testFiles).toContain('test/smoke-environment.test.ts');
    expect(plan.testFiles).toEqual(
      expect.arrayContaining([
        'test/docker-workload/environment.test.ts',
        'test/docker/desktop-relay-uds.integration.test.ts',
        'test/docker-workload/profile-ceiling.test.ts',
        'test/docker-workload/nested-daemon-identity.test.ts',
        'test/uid-remap.integration.test.ts',
        'test/uid-remap.goose.integration.test.ts',
        'test/uid-remap.codex.integration.test.ts',
      ]),
    );
    expect(plan.testFiles).not.toContain('test/apple-container.integration.test.ts');
    expect(plan.liveGates.map((gate) => gate.arguments)).toEqual([
      ['--docker-desktop-recovery', '--environment', 'wsl-desktop'],
      ['--docker-desktop-disabled', '--environment', 'wsl-desktop'],
      ['--docker-desktop-pty', '--environment', 'wsl-desktop'],
      ['--docker-desktop-offline', '--environment', 'wsl-desktop'],
      ['--docker-desktop-images', '--environment', 'wsl-desktop'],
      ['--docker-desktop-packages', '--environment', 'wsl-desktop'],
      ['--offline', '--environment', 'wsl-desktop'],
      ['--images', '--environment', 'wsl-desktop'],
      ['--packages', '--environment', 'wsl-desktop'],
    ]);
    expect(plan.liveGates.slice(-3).every((gate) => gate.script === 'smoke-nested-apple-workflow.ts')).toBe(true);
  });
});
