import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(resolve('docker/nested-daemon/Dockerfile'), 'utf8');

describe('purpose-built rootless nested daemon image', () => {
  it('accepts the common resolved stock source and resets inherited OCI metadata through scratch', () => {
    expect(dockerfile).toContain('ARG IRONCURTAIN_DOCKER_SOURCE=docker:29.2.1-dind-rootless');
    expect(dockerfile).toContain('FROM ${IRONCURTAIN_DOCKER_SOURCE} AS stock');
    expect(dockerfile).toMatch(/\nFROM scratch\n/u);
    expect(dockerfile).toContain('COPY --from=stock / /');
    expect(dockerfile).not.toMatch(/^VOLUME\b/mu);
    expect(dockerfile).not.toMatch(/^EXPOSE\b/mu);
  });

  it('starts the bounded identity initializer, offline network mode, UDS runtime, and toolchain tuple', () => {
    expect(dockerfile).toMatch(/^USER 0:0$/mu);
    expect(dockerfile).toContain('ENTRYPOINT ["/usr/local/lib/ironcurtain/daemon-entrypoint.sh"]');
    expect(dockerfile).toContain('DOCKERD_ROOTLESS_ROOTLESSKIT_NET=none');
    expect(dockerfile).toContain('XDG_RUNTIME_DIR=/run/ironcurtain-docker');
    expect(dockerfile).toContain('DOCKER_VERSION=29.2.1');
    expect(dockerfile).toContain('DOCKER_BUILDX_VERSION=0.31.1');
    expect(dockerfile).toContain('DOCKER_COMPOSE_VERSION=5.1.0');
    expect(dockerfile).not.toMatch(/tcp:\/\//u);
  });

  it('bakes the private API root and no-new-keyring runc wrapper with exact metadata', () => {
    expect(dockerfile).toContain('install -d -o 0 -g 0 -m 0755 /out/api');
    expect(dockerfile).toContain('COPY --from=shim-build --chown=0:0 --chmod=0755 /out/api/ /run/ironcurtain-docker/');
    expect(dockerfile).toContain(
      'COPY --from=shim-build --chown=0:0 --chmod=0555 /out/runc /usr/local/lib/ironcurtain/runc',
    );
    expect(dockerfile.indexOf('/run/ironcurtain-docker/')).toBeLessThan(dockerfile.indexOf('USER 0:0'));
  });

  it('keeps the image role without unused provenance arguments or static builder digests', () => {
    expect(dockerfile).toContain('LABEL com.ironcurtain.docker-workload.image-role="nested-daemon"');
    expect(dockerfile).not.toContain('IRONCURTAIN_PROVENANCE_DIGEST');
    expect(dockerfile).not.toMatch(/^FROM .*@sha256:/mu);
    expect(dockerfile).not.toContain('IRONCURTAIN_TOOLCHAIN_DIGEST');
  });
});
