import { describe, expect, it } from 'vitest';
import { getBackendQualificationPlan } from '../../scripts/qualify-backend-plan.js';

describe('backend qualification plan', () => {
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
});
