import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The infrastructure orchestrator is the mechanism the product wiring calls
 * ONLY after the temporary implementation fuse has already admitted the
 * session. It must never consult that fuse itself, or admission would
 * fail-closed on its own machinery.
 */
describe('Docker-workload infrastructure fuse independence', () => {
  it('does not reference the implementation fuse or the config module', () => {
    const source = readFileSync(resolve('src/docker-workload/infrastructure.ts'), 'utf8');
    expect(source).not.toContain('assertDockerWorkloadImplementationAvailable');
    expect(source).not.toMatch(/from '\.\/config\.js'/u);
  });
});
