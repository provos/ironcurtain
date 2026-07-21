import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(resolve('docker/nested-daemon/Dockerfile'), 'utf8');

describe('purpose-built rootless nested daemon image', () => {
  it('uses one immutable stock rootfs input and resets inherited OCI metadata through scratch', () => {
    expect(dockerfile).toContain(
      'FROM docker@sha256:67c4114553192e9072969fc347426048cfe4192385dc762d8eb449c05e904255 AS stock',
    );
    expect(dockerfile).toMatch(/\nFROM scratch\n/u);
    expect(dockerfile).toContain('COPY --from=stock / /');
    expect(dockerfile).not.toMatch(/^VOLUME\b/mu);
    expect(dockerfile).not.toMatch(/^EXPOSE\b/mu);
  });

  it('restores only the pinned rootless identity, offline network mode, UDS runtime, and toolchain tuple', () => {
    expect(dockerfile).toMatch(/^USER rootless$/mu);
    expect(dockerfile).toMatch(/^ENTRYPOINT \["dockerd-entrypoint\.sh"\]$/mu);
    expect(dockerfile).toContain('DOCKERD_ROOTLESS_ROOTLESSKIT_NET=none');
    expect(dockerfile).toContain('XDG_RUNTIME_DIR=/run/ironcurtain-docker');
    expect(dockerfile).toContain('DOCKER_VERSION=29.2.1');
    expect(dockerfile).toContain('DOCKER_BUILDX_VERSION=0.31.1');
    expect(dockerfile).toContain('DOCKER_COMPOSE_VERSION=5.1.0');
    expect(dockerfile).not.toMatch(/tcp:\/\//u);
  });

  it('contains the complete catalog identity label surface and no credential material', () => {
    for (const label of [
      'ironcurtain.build-hash-schema',
      'ironcurtain.build-hash',
      'ironcurtain.architecture',
      'ironcurtain.docker-api-min',
      'ironcurtain.docker-api-max',
      'ironcurtain.runtime-trust-schema',
      'ironcurtain.toolchain-digest',
      'ironcurtain.provenance-digest',
      'ironcurtain.catalog-generation',
      'com.ironcurtain.docker-workload.image-role',
    ]) {
      expect(dockerfile).toContain(label);
    }
    expect(dockerfile).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|API_KEY|AUTH_TOKEN/u);
  });
});
