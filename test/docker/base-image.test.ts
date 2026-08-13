import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const dockerfile = readFileSync(resolve('docker/Dockerfile.base.arm64'), 'utf8');
const nestedDaemonDockerfile = readFileSync(resolve('docker/nested-daemon/Dockerfile'), 'utf8');

const DOCKER_TOOLCHAIN_DIGEST = 'sha256:67c4114553192e9072969fc347426048cfe4192385dc762d8eb449c05e904255';
const TOOLCHAIN_BIN_DIR = '/usr/local/lib/ironcurtain-docker/bin';
const CLI_PLUGIN_DIR = '/usr/local/libexec/docker/cli-plugins';

/** Every `FROM` reference, in file order. */
function fromReferences(): readonly string[] {
  return [...dockerfile.matchAll(/^FROM\s+(\S+)/gmu)].map(([, reference]) => reference);
}

/** Every non-empty, non-comment line, trimmed, in file order. */
function instructionLines(): readonly string[] {
  return dockerfile
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Non-comment instruction lines naming either id-map helper, trimmed, in file order. */
function helperInstructionLines(): readonly string[] {
  return instructionLines().filter((line) => /new[ug]idmap/u.test(line));
}

/**
 * Every `ln` invocation, whatever its flag spelling. Matching `ln -s ` alone
 * would miss `ln -sf` and `ln --symbolic` — and a hard link entirely — so this
 * collects whole commands and lets the assertion pin them verbatim.
 */
function lnInvocations(): readonly string[] {
  return instructionLines()
    .flatMap((line) => line.replace(/^RUN\s+/u, '').split(/\s*(?:&&|\|\||;)\s*/u))
    .map((segment) => segment.replace(/\s*\\$/u, '').trim())
    .filter((segment) => /^ln(?:\s|$)/u.test(segment));
}

/** Every COPY instruction, including ones with no `--from` (which build-context copies lack). */
function copyInstructions(): readonly string[] {
  return instructionLines().filter((line) => /^COPY(?:\s|$)/u.test(line));
}

/** Declared values of every `ENV PATH=` line, in file order. */
function declaredPathValues(): readonly string[] {
  return [...dockerfile.matchAll(/^ENV\s+PATH=(.*)$/gmu)].map(([, value]) => value.trim());
}

describe('arm64 agent base image inputs', () => {
  it('pins every build stage to an immutable digest', () => {
    expect(fromReferences()).toEqual([
      `docker@${DOCKER_TOOLCHAIN_DIGEST}`,
      'node:22-trixie@sha256:8433642fe11d391a7ff1f702352ac1b0ea3e378d3fb2c22de2b292036d79cd2c',
    ]);
    for (const reference of fromReferences()) expect(reference).toMatch(/@sha256:[0-9a-f]{64}$/u);
  });

  it('single-sources the toolchain digest with the nested-daemon image', () => {
    expect(dockerfile).toContain(`FROM docker@${DOCKER_TOOLCHAIN_DIGEST} AS docker-toolchain`);
    expect(nestedDaemonDockerfile).toContain(`FROM docker@${DOCKER_TOOLCHAIN_DIGEST} AS stock`);
  });
});

describe('arm64 agent base image rootless prerequisites', () => {
  it('installs the rootlesskit and embedded-DNS prerequisites in one apt layer', () => {
    expect(dockerfile).toMatch(/^\s+uidmap iproute2 iptables libcap2-bin \\$/mu);
    // One apt layer, one cleanup: no second unpinned package source.
    expect(dockerfile).toMatch(
      /apt-get install -y --no-install-recommends[\s\S]*?uidmap iproute2 iptables libcap2-bin/u,
    );
  });

  it('grants the id-map helpers file capabilities rather than setuid-root', () => {
    expect(dockerfile).toContain('setcap cap_setuid+ep /usr/bin/newuidmap');
    expect(dockerfile).toContain('setcap cap_setgid+ep /usr/bin/newgidmap');
    expect(dockerfile).toContain('chmod u-s /usr/bin/newuidmap /usr/bin/newgidmap');
  });

  it('never leaves the id-map helpers setuid: euid 0 forfeits the userns capability grant', () => {
    // Debian ships them 4755. The image strips that bit and must never re-grant
    // it in any form, so the ONLY instructions naming the helpers are the three
    // in the re-cap layer.
    expect(helperInstructionLines()).toEqual([
      'RUN setcap cap_setuid+ep /usr/bin/newuidmap && \\',
      'setcap cap_setgid+ep /usr/bin/newgidmap && \\',
      'chmod u-s /usr/bin/newuidmap /usr/bin/newgidmap',
    ]);
    expect(dockerfile).not.toMatch(/\bu\+s\b/u);
    expect(dockerfile).not.toMatch(/(?:chmod|-m)\s+4[0-7]{3}\b/u);
  });

  it('pre-creates the nested-daemon API directory 0700 for the runtime user', () => {
    // The agent VM's bounding set has no CAP_CHOWN, so this cannot be deferred
    // to runtime; /run is ext4 there, so the image-time directory survives.
    expect(dockerfile).toContain('install -d -o codespace -g codespace -m 0700 /run/ironcurtain-docker');
  });

  it('re-points the subordinate id ranges at codespace and drops the stale node entry', () => {
    expect(dockerfile).toContain("sed -i -e '/^node:/d' -e '/^codespace:/d' /etc/subuid /etc/subgid");
    expect(dockerfile).toContain("echo 'codespace:100000:65536' >> /etc/subuid");
    expect(dockerfile).toContain("echo 'codespace:100000:65536' >> /etc/subgid");
    expect(dockerfile).not.toMatch(/['"]node:100000:65536/u);
  });
});

describe('arm64 agent base image Docker toolchain layer', () => {
  it('copies the toolchain verbatim from the pinned stage and nothing else', () => {
    // Pins EVERY copy, not just the `--from=` ones: a plain `COPY ./x /` would
    // otherwise be invisible to this file's assertions.
    expect(copyInstructions()).toEqual([
      `COPY --from=docker-toolchain --chown=root:root /usr/local/bin/ ${TOOLCHAIN_BIN_DIR}/`,
      `COPY --from=docker-toolchain --chown=root:root ${CLI_PLUGIN_DIR}/ ${CLI_PLUGIN_DIR}/`,
    ]);
  });

  it('re-owns the copied toolchain to root: COPY --from preserves 1001:1001 on two binaries', () => {
    // rootlesskit and vpnkit are owned 1001:1001 in the pinned source image. A
    // Linux host that remaps the agent to uid 1001 would otherwise hand the
    // runtime user ownership of shipped toolchain binaries.
    for (const copy of copyInstructions()) expect(copy).toContain('--chown=root:root');
  });

  it('keeps the CLI plugins where the copied docker-compose symlink points', () => {
    // /usr/local/bin/docker-compose in the source stage is a symlink to
    // /usr/local/libexec/docker/cli-plugins/docker-compose and is copied along
    // with the rest of the bin directory. Landing the plugins anywhere else
    // leaves that symlink dangling; libexec is also a default CLI plugin
    // search path, so discovery still works.
    expect(dockerfile).toContain(`${CLI_PLUGIN_DIR}/ ${CLI_PLUGIN_DIR}/`);
    expect(dockerfile).not.toContain('/usr/local/lib/docker/cli-plugins');
  });

  it('exposes the client CLI globally and selects legacy iptables on the private daemon PATH', () => {
    expect(lnInvocations()).toEqual([
      `ln -s ${TOOLCHAIN_BIN_DIR}/docker /usr/local/bin/docker`,
      `ln -s /usr/sbin/iptables-legacy ${TOOLCHAIN_BIN_DIR}/iptables`,
    ]);
    expect(dockerfile).not.toMatch(/ln -s \/usr\/sbin\/iptables-legacy \/usr\/local\/(?:s?bin)\/iptables/u);
    for (const daemonBinary of ['dockerd', 'rootlesskit', 'containerd', 'runc', 'ctr', 'docker-proxy', 'vpnkit']) {
      expect(dockerfile).not.toMatch(
        new RegExp(String.raw`(?:/usr/local/bin|/usr/local/sbin|/usr/bin|/usr/sbin|/bin|/sbin)/${daemonBinary}\b`, 'u'),
      );
    }
  });

  it('never puts the daemon toolchain directory on the image PATH', () => {
    // The ENV-name assertion below only proves PATH is declared once; this
    // pins its VALUE, which is what decides whether `dockerd` is reachable by
    // an agent that simply types it.
    expect(declaredPathValues()).toEqual(['/opt/rust/cargo/bin:$PATH']);
    for (const value of declaredPathValues()) expect(value).not.toContain(TOOLCHAIN_BIN_DIR);
    // No other environment variable smuggles it onto a search path either.
    expect(dockerfile).not.toMatch(new RegExp(String.raw`^ENV\s+\w+=.*${TOOLCHAIN_BIN_DIR}`, 'mu'));
  });
});

describe('arm64 agent base image hygiene', () => {
  it('adds no runtime surface, no daemon endpoint, and no credential material', () => {
    expect(dockerfile).not.toMatch(/^VOLUME\b/mu);
    expect(dockerfile).not.toMatch(/^EXPOSE\b/mu);
    expect(dockerfile).not.toMatch(/tcp:\/\//u);
    expect(dockerfile).not.toMatch(/DOCKER_HOST|DOCKER_TLS|dockerd-entrypoint/u);
    expect(dockerfile).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|API_KEY|AUTH_TOKEN/u);
  });

  it('declares exactly the pre-existing environment and runtime identity', () => {
    expect([...dockerfile.matchAll(/^ENV\s+([A-Z0-9_]+)=/gmu)].map(([, name]) => name)).toEqual([
      'UV_NATIVE_TLS',
      'UV_PYTHON_INSTALL_DIR',
      'RUSTUP_HOME',
      'CARGO_HOME',
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
    ]);
    expect([...dockerfile.matchAll(/^USER\s+(\S+)$/gmu)].map(([, user]) => user)).toEqual(['root', 'codespace']);
    expect(dockerfile).toMatch(/^WORKDIR \/workspace$/mu);
  });

  it('keeps the pre-existing codespace toolchain provisioning intact', () => {
    expect(dockerfile).toContain('usermod -l codespace -d /home/codespace -m node');
    expect(dockerfile).toContain('groupmod -n codespace node');
    expect(dockerfile).toContain('echo "codespace ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/codespace');
    expect(dockerfile).toContain('git lfs install --system');
    expect(dockerfile).toContain('uv python install 3.12');
    expect(dockerfile).toContain('npm install -g node-gyp');
    expect(dockerfile).toContain('npx playwright install chromium');
    expect(dockerfile).toMatch(/^RUN node-gyp install$/mu);
  });
});
