import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRuntimeTrustEnv,
  CONTAINER_RUNTIME_CA_BUNDLE,
  CONTAINER_RUNTIME_CA_CERT,
  renderAptProxyConfig,
  stageRuntimeTrust,
} from '../../src/docker/runtime-trust.js';

const CA_ONE = '-----BEGIN CERTIFICATE-----\nSESSION-CA-ONE\n-----END CERTIFICATE-----';
const CA_TWO = '-----BEGIN CERTIFICATE-----\nSESSION-CA-TWO\n-----END CERTIFICATE-----';
const ROOT_ONE = '-----BEGIN CERTIFICATE-----\nPUBLIC-ROOT-ONE\n-----END CERTIFICATE-----';
const ROOT_TWO = '-----BEGIN CERTIFICATE-----\nPUBLIC-ROOT-TWO\n-----END CERTIFICATE-----';

describe('runtime trust staging', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'runtime-trust-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('stages exactly the normalized public certificate and deduplicated root bundle with immutable modes', () => {
    stageRuntimeTrust(directory, `\n${CA_ONE.replaceAll('\n', '\r\n')}\r\n`, [ROOT_TWO, ROOT_ONE, ROOT_ONE]);
    const certPath = join(directory, 'ca-cert.pem');
    const bundlePath = join(directory, 'ca-bundle.pem');

    expect(readFileSync(certPath, 'utf8')).toBe(`${CA_ONE}\n`);
    expect(readFileSync(bundlePath, 'utf8')).toBe(`${ROOT_ONE}\n${ROOT_TWO}\n${CA_ONE}\n`);
    expect(statSync(certPath).mode & 0o777).toBe(0o444);
    expect(statSync(bundlePath).mode & 0o777).toBe(0o444);
    expect(readdirSync(directory).sort()).toEqual(['ca-bundle.pem', 'ca-cert.pem']);
  });

  it('atomically replaces a prior generation without retaining the old CA', () => {
    stageRuntimeTrust(directory, CA_ONE, [ROOT_ONE]);
    const oldCertificate = openSync(join(directory, 'ca-cert.pem'), 'r');
    const oldBundle = openSync(join(directory, 'ca-bundle.pem'), 'r');
    try {
      stageRuntimeTrust(directory, CA_TWO, [ROOT_TWO]);
      expect(readFileSync(join(directory, 'ca-cert.pem'), 'utf8')).toBe(`${CA_TWO}\n`);
      expect(readFileSync(join(directory, 'ca-bundle.pem'), 'utf8')).toBe(`${ROOT_TWO}\n${CA_TWO}\n`);
      // Existing readers retain the complete previous files across each atomic rename.
      expect(readFileSync(oldCertificate, 'utf8')).toBe(`${CA_ONE}\n`);
      expect(readFileSync(oldBundle, 'utf8')).toBe(`${ROOT_ONE}\n${CA_ONE}\n`);
      expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      closeSync(oldCertificate);
      closeSync(oldBundle);
    }
  });

  it('keeps public trust accessible to other UIDs under umask 077 without widening private files', () => {
    const previousUmask = process.umask(0o077);
    try {
      const privatePath = join(directory, 'private-config');
      writeFileSync(privatePath, 'private fixture', { mode: 0o600 });
      stageRuntimeTrust(directory, CA_ONE, [ROOT_ONE]);
      expect(statSync(directory).mode & 0o777).toBe(0o755);
      expect(statSync(join(directory, 'ca-cert.pem')).mode & 0o777).toBe(0o444);
      expect(statSync(join(directory, 'ca-bundle.pem')).mode & 0o777).toBe(0o444);
      expect(statSync(privatePath).mode & 0o777).toBe(0o600);
      expect(process.umask()).toBe(0o077);
    } finally {
      process.umask(previousUmask);
    }
  });

  it('refuses to change the mode of a symlinked mount root', () => {
    const target = join(directory, 'target');
    const link = join(directory, 'link');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, link);
    expect(() => stageRuntimeTrust(link, CA_ONE, [ROOT_ONE])).toThrow('must be a real directory');
    expect(statSync(target).mode & 0o777).toBe(0o700);
    expect(readdirSync(target)).toEqual([]);
  });

  it.each(['ca-cert.pem', 'ca-bundle.pem'])('refuses to replace a planted %s symlink', (filename) => {
    const outside = join(directory, 'outside');
    symlinkSync(outside, join(directory, filename));
    expect(() => stageRuntimeTrust(directory, CA_ONE, [ROOT_ONE])).toThrow(/symlink/u);
    expect(existsSync(outside)).toBe(false);
  });
});

describe('runtime trust consumers', () => {
  it.each(['Dockerfile.base', 'Dockerfile.base.arm64'])('%s is independent of session CA material', (name) => {
    const dockerfile = readFileSync(join(process.cwd(), 'docker', name), 'utf8');
    expect(dockerfile).not.toContain('ironcurtain-ca-cert.pem');
    expect(dockerfile).not.toMatch(/COPY .*ca-cert/iu);
  });

  it('uses the exact staged certificate and bundle paths', () => {
    expect(buildRuntimeTrustEnv()).toEqual({
      NODE_EXTRA_CA_CERTS: CONTAINER_RUNTIME_CA_CERT,
      SSL_CERT_FILE: CONTAINER_RUNTIME_CA_BUNDLE,
      CURL_CA_BUNDLE: CONTAINER_RUNTIME_CA_BUNDLE,
      GIT_SSL_CAINFO: CONTAINER_RUNTIME_CA_BUNDLE,
      PIP_CERT: CONTAINER_RUNTIME_CA_BUNDLE,
      REQUESTS_CA_BUNDLE: CONTAINER_RUNTIME_CA_BUNDLE,
    });
  });

  it('installs the mounted public CA into each ephemeral container system store', () => {
    const trustScript = readFileSync(join(process.cwd(), 'docker', 'entrypoint-uid-remap.sh'), 'utf8');
    expect(trustScript).toContain('IRONCURTAIN_RUNTIME_CA=/etc/ironcurtain/ca-cert.pem');
    expect(trustScript).toContain('IRONCURTAIN_SYSTEM_CA=/usr/local/share/ca-certificates/ironcurtain-session-ca.crt');
    expect(trustScript).toContain('sudo -n install -m 0444 "$IRONCURTAIN_RUNTIME_CA" "$IRONCURTAIN_SYSTEM_CA"');
    expect(trustScript).toContain('sudo -n update-ca-certificates');
    expect(trustScript).not.toMatch(/PRIVATE KEY|ca-key|key\.pem/iu);

    for (const agent of ['claude-code', 'codex', 'goose']) {
      const dockerfile = readFileSync(join(process.cwd(), 'docker', `Dockerfile.${agent}`), 'utf8');
      const entrypoint = readFileSync(join(process.cwd(), 'docker', `entrypoint-${agent}.sh`), 'utf8');
      expect(dockerfile).toContain('COPY entrypoint-uid-remap.sh /usr/local/bin/ironcurtain-uid-remap.sh');
      expect(entrypoint).toContain('. /usr/local/bin/ironcurtain-uid-remap.sh');
    }
  });

  it('binds apt HTTP, HTTPS, and TLS trust to one fixed endpoint', () => {
    expect(renderAptProxyConfig('http://127.0.0.1:18080')).toBe(
      'Acquire::http::Proxy "http://127.0.0.1:18080";\n' +
        'Acquire::https::Proxy "http://127.0.0.1:18080";\n' +
        `Acquire::https::CaInfo "${CONTAINER_RUNTIME_CA_BUNDLE}";\n`,
    );
  });

  it.each([
    'https://127.0.0.1:18080',
    'http://user@127.0.0.1:18080',
    'http://127.0.0.1:18080/path',
    'http://127.0.0.1',
    'http://127.0.0.1:18080\nAcquire::http::Proxy "http://evil";',
  ])('rejects non-fixed apt proxy URL %s', (url) => {
    expect(() => renderAptProxyConfig(url)).toThrow(/fixed http/u);
  });
});
