import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  getDockerToolchainSourceReference,
  loadClientToolchainManifest,
} from '../../src/docker-workload/client-toolchain.js';

const arm64 = readFileSync(resolve('docker/Dockerfile.base.arm64'), 'utf8');
const amd64 = readFileSync(resolve('docker/Dockerfile.base'), 'utf8');
const daemon = readFileSync(resolve('docker/nested-daemon/Dockerfile'), 'utf8');
const installer = readFileSync(resolve('docker/install-docker-toolchain.sh'), 'utf8');
const compatibility = loadClientToolchainManifest(resolve('config/docker-workload/client-toolchain.json'), 'amd64');
const source = getDockerToolchainSourceReference(compatibility.manifest);

// These checks cover build wiring and security-relevant prerequisites. Tool execution,
// actual ownership, plugin discovery and sudo are checked against built images by
// live qualification; matching Dockerfile text does not establish those properties.
describe('shared Docker toolchain image inputs', () => {
  it('uses one versioned Docker source in both agent bases and the daemon', () => {
    for (const dockerfile of [amd64, arm64, daemon]) {
      expect(dockerfile).toContain(`ARG IRONCURTAIN_DOCKER_SOURCE=${source}`);
      expect(dockerfile).toMatch(/^FROM \$\{IRONCURTAIN_DOCKER_SOURCE\} AS /mu);
    }
  });

  it.each([
    ['amd64', amd64],
    ['arm64', arm64],
  ])('%s consumes the common toolchain assembly recipe', (_architecture, dockerfile) => {
    expect(dockerfile).toContain('COPY install-docker-toolchain.sh /tmp/install-docker-toolchain.sh');
    expect(dockerfile).toContain('RUN sh /tmp/install-docker-toolchain.sh /out');
    expect(dockerfile).toContain('COPY --from=docker-toolchain --chown=root:root /out/ /');
    expect(dockerfile).not.toMatch(/^ENV PATH=.*ironcurtain-docker\/bin/mu);
  });

  it('selects an explicit amd64 development base release', () => {
    expect(amd64).toMatch(/^FROM mcr\.microsoft\.com\/devcontainers\/universal:\d+\.\d+\.\d+-noble$/mu);
    expect(amd64).not.toContain('universal:latest');
  });

  it('uses versioned base sources without maintained source digest pins on either architecture', () => {
    expect(arm64).toMatch(/^FROM node:22-trixie$/mu);
    for (const dockerfile of [amd64, arm64, daemon]) {
      expect(dockerfile).not.toMatch(/^(?:FROM |# syntax=).*@sha256:/mu);
    }
  });

  it('keeps a canonical plugin installation and overrides inherited discovery entries', () => {
    expect(installer).toContain('/usr/local/libexec/docker/cli-plugins');
    expect(installer).toContain('/usr/local/lib/docker/cli-plugins');
    expect(installer).toContain('for plugin in docker-buildx docker-compose; do');
    expect(installer).toContain('chown -R 0:0 "$destination"');
    expect(installer).toContain('ln -s /usr/local/lib/ironcurtain-docker/bin/docker');
    expect(amd64).toContain(
      'rm -f /usr/local/bin/docker-compose && \\\n    ! command -v docker-compose && \\\n    ! command -v docker-buildx',
    );
    expect(arm64).not.toContain('rm -f /usr/local/bin/docker-compose');
  });
});

describe('preserved Apple agent rootless prerequisites', () => {
  it('keeps subordinate mappings and capability-based id-map helpers', () => {
    expect(arm64).toContain('uidmap iproute2 iptables libcap2-bin');
    expect(arm64).toContain('setcap cap_setuid+ep /usr/bin/newuidmap');
    expect(arm64).toContain('setcap cap_setgid+ep /usr/bin/newgidmap');
    expect(arm64).toContain('chmod u-s /usr/bin/newuidmap /usr/bin/newgidmap');
    expect(arm64).toContain("echo 'codespace:100000:65536' >> /etc/subuid");
    expect(arm64).toContain("echo 'codespace:100000:65536' >> /etc/subgid");
  });

  it('keeps Apple-only relay/bootstrap inputs and sudo', () => {
    expect(arm64).toContain('COPY --chown=root:root --chmod=0444 apple-vm-egress-relay.mjs');
    expect(arm64).toContain('ironcurtain-apple-vm-egress-relay/1');
    expect(arm64).toContain('install -d -o codespace -g codespace -m 0700 /run/ironcurtain-docker');
    expect(arm64).toContain('codespace ALL=(ALL) NOPASSWD:ALL');
    expect(arm64).toMatch(/^USER codespace$/mu);
  });
});
