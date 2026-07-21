import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRuntimeTrustEnv,
  CONTAINER_RUNTIME_CA_BUNDLE,
  CONTAINER_RUNTIME_CA_CERT,
  renderAptProxyConfig,
  RUNTIME_TRUST_METADATA_FILE,
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

  it('stages only public, hash-bound trust material with immutable modes', () => {
    const metadata = stageRuntimeTrust(directory, CA_ONE, [ROOT_TWO, ROOT_ONE, ROOT_ONE]);
    const certPath = join(directory, 'ca-cert.pem');
    const bundlePath = join(directory, 'ca-bundle.pem');
    const metadataPath = join(directory, RUNTIME_TRUST_METADATA_FILE);

    expect(readFileSync(certPath, 'utf8')).toBe(`${CA_ONE}\n`);
    expect(readFileSync(bundlePath, 'utf8')).toBe(`${ROOT_ONE}\n${ROOT_TWO}\n${CA_ONE}\n`);
    expect(JSON.parse(readFileSync(metadataPath, 'utf8'))).toEqual(metadata);
    expect(metadata.generation).toBe(`runtime-trust-v1:${metadata.caCertificateSha256}`);
    expect(metadata.publicRootCount).toBe(2);
    expect(metadata.containerCertificatePath).toBe(CONTAINER_RUNTIME_CA_CERT);
    expect(metadata.containerBundlePath).toBe(CONTAINER_RUNTIME_CA_BUNDLE);
    expect(statSync(certPath).mode & 0o777).toBe(0o444);
    expect(statSync(bundlePath).mode & 0o777).toBe(0o444);
    expect(statSync(metadataPath).mode & 0o777).toBe(0o444);
    expect(readdirSync(directory).some((name) => /key/iu.test(name))).toBe(false);
  });

  it('atomically replaces a prior generation without retaining the old CA', () => {
    const first = stageRuntimeTrust(directory, CA_ONE, [ROOT_ONE]);
    const second = stageRuntimeTrust(directory, CA_TWO, [ROOT_ONE]);

    expect(second.generation).not.toBe(first.generation);
    expect(readFileSync(join(directory, 'ca-cert.pem'), 'utf8')).toBe(`${CA_TWO}\n`);
    expect(readFileSync(join(directory, 'ca-bundle.pem'), 'utf8')).not.toContain('SESSION-CA-ONE');
    expect(readdirSync(directory).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses to replace a planted trust-file symlink', () => {
    const outside = join(directory, 'outside');
    symlinkSync(outside, join(directory, 'ca-cert.pem'));
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
