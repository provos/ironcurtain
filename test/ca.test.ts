import { describe, it, expect, afterEach } from 'vitest';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createTlsServer } from 'node:tls';
import { pathToFileURL } from 'node:url';
import forge from 'node-forge';
import { createLeafSecureContextCache, loadOrCreateCA, randomSerialNumber } from '../src/docker/ca.js';

describe('loadOrCreateCA', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('generates CA cert and key files on first run', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');

    const ca = loadOrCreateCA(caDir);

    expect(existsSync(ca.certPath)).toBe(true);
    expect(existsSync(ca.keyPath)).toBe(true);
    expect(ca.generation).toMatch(/^gen-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(join(ca.certPath, '..')).toBe(join(caDir, 'generations', ca.generation));
    expect(loadOrCreateCA(caDir).generation).toBe(ca.generation);
    expect(ca.certPath).toMatch(new RegExp(`^${escapeRegExp(join(caDir, 'generations', 'gen-'))}`));
    expect(ca.keyPath).toBe(join(join(ca.certPath, '..'), 'ca-key.pem'));
  });

  it('returns valid PEM content', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');

    const ca = loadOrCreateCA(caDir);

    expect(ca.certPem).toContain('-----BEGIN CERTIFICATE-----');
    expect(ca.certPem).toContain('-----END CERTIFICATE-----');
    expect(ca.keyPem).toContain('-----BEGIN RSA PRIVATE KEY-----');
    expect(ca.keyPem).toContain('-----END RSA PRIVATE KEY-----');
  });

  it('generates a CA certificate with correct extensions', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');

    const ca = loadOrCreateCA(caDir);
    const cert = forge.pki.certificateFromPem(ca.certPem);

    // Check CN
    const cn = cert.subject.getField('CN');
    expect(cn?.value).toBe('IronCurtain MITM CA');

    // Check self-signed (issuer == subject)
    const issuerCn = cert.issuer.getField('CN');
    expect(issuerCn?.value).toBe('IronCurtain MITM CA');

    // Check the exact strict-v2 trust-anchor profile required by OpenSSL's
    // VERIFY_X509_STRICT validation.
    const bc = cert.getExtension('basicConstraints') as {
      cA?: boolean;
      pathLenConstraint?: number;
      critical?: boolean;
    } | null;
    expect(bc?.cA).toBe(true);
    expect(bc?.pathLenConstraint).toBe(0);
    expect(bc?.critical).toBe(true);
    const keyUsage = cert.getExtension('keyUsage') as {
      keyCertSign?: boolean;
      cRLSign?: boolean;
      critical?: boolean;
    } | null;
    expect(keyUsage).toMatchObject({ keyCertSign: true, cRLSign: true, critical: true });
    const subjectKeyIdentifier = cert.getExtension('subjectKeyIdentifier') as {
      subjectKeyIdentifier?: string;
    } | null;
    expect(cert.verifySubjectKeyIdentifier()).toBe(true);
    expect(subjectKeyIdentifier?.subjectKeyIdentifier).toMatch(/^[0-9a-f]{40}$/u);
    expect(authorityKeyIdentifierHex(cert)).toBe(subjectKeyIdentifier?.subjectKeyIdentifier);
    expect(cert.extensions.map((extension) => extension.id).sort()).toEqual([
      '2.5.29.14',
      '2.5.29.15',
      '2.5.29.19',
      '2.5.29.35',
    ]);

    // Check validity (roughly 10 years)
    const validityMs = cert.validity.notAfter.getTime() - cert.validity.notBefore.getTime();
    const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
    expect(validityMs).toBeGreaterThanOrEqual(tenYearsMs - 60_000); // allow 1 min slack
  });

  it('loads existing CA on second call (idempotent)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');

    const ca1 = loadOrCreateCA(caDir);
    const ca2 = loadOrCreateCA(caDir);

    // Should return the same cert content
    expect(ca2.certPem).toBe(ca1.certPem);
    expect(ca2.keyPem).toBe(ca1.keyPem);
  });

  it('sets key file permissions to 0600', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');

    const ca = loadOrCreateCA(caDir);

    const keyStats = statSync(ca.keyPath);
    const keyMode = keyStats.mode & 0o777;
    expect(keyMode).toBe(0o600);
  });

  it('key can sign certificates', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');

    const ca = loadOrCreateCA(caDir);
    const caCert = forge.pki.certificateFromPem(ca.certPem);
    const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

    // Generate a leaf cert and sign it
    const leafKeys = forge.pki.rsa.generateKeyPair(2048);
    const leafCert = forge.pki.createCertificate();
    leafCert.publicKey = leafKeys.publicKey;
    leafCert.serialNumber = '01';
    leafCert.validity.notBefore = new Date();
    leafCert.validity.notAfter = new Date(Date.now() + 3600_000);
    leafCert.setSubject([{ name: 'commonName', value: 'test.example.com' }]);
    leafCert.setIssuer(caCert.subject.attributes);
    leafCert.sign(caKey, forge.md.sha256.create());

    // Verify the leaf cert was signed by the CA
    const verified = caCert.verify(leafCert);
    expect(verified).toBe(true);
  });

  it('reuses one shared leaf TLS context per hostname', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const cache = createLeafSecureContextCache(loadOrCreateCA(join(tempDir, 'ca')));

    expect(cache('api.example.com')).toBe(cache('api.example.com'));
    expect(cache('api.example.com')).not.toBe(cache('other.example.com'));
  });

  it('serves a strict-v2 leaf accepted by Python strict OpenSSL verification', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const authority = loadOrCreateCA(join(tempDir, 'ca'));
    const cache = createLeafSecureContextCache(authority);
    const socketPath = join(tempDir, 'strict-tls.sock');
    const server = createTlsServer(
      {
        SNICallback: (servername, callback) => {
          callback(null, cache(servername));
        },
      },
      (socket) => socket.end('strict-ok'),
    );
    await new Promise<void>((resolvePromise, rejectPromise) => {
      server.once('error', rejectPromise);
      server.listen(socketPath, resolvePromise);
    });
    try {
      const peerPem = await runStrictPythonTlsClient(socketPath, authority.certPath, 'registry.npmjs.org');
      const leaf = forge.pki.certificateFromPem(peerPem);
      const root = forge.pki.certificateFromPem(authority.certPem);
      expect(leaf.issuer.getField('CN')?.value).toBe('IronCurtain MITM CA');
      expect(root.verify(leaf)).toBe(true);
      expect(leaf.validity.notBefore.getTime()).toBeGreaterThanOrEqual(root.validity.notBefore.getTime());
      expect(leaf.validity.notAfter.getTime()).toBeLessThanOrEqual(root.validity.notAfter.getTime());
      expect(leaf.getExtension('basicConstraints')).toMatchObject({ cA: false, critical: true });
      expect(leaf.getExtension('keyUsage')).toMatchObject({
        digitalSignature: true,
        keyEncipherment: true,
        critical: true,
      });
      expect(leaf.getExtension('extKeyUsage')).toMatchObject({ serverAuth: true });
      expect(leaf.verifySubjectKeyIdentifier()).toBe(true);
      const rootSki = root.getExtension('subjectKeyIdentifier') as { subjectKeyIdentifier?: string } | null;
      expect(authorityKeyIdentifierHex(leaf)).toBe(rootSki?.subjectKeyIdentifier);
    } finally {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  });

  it('publishes one current pointer to one complete fsynced generation and leaves no temporary or lock files', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');

    const authority = loadOrCreateCA(caDir);

    expect(readdirSync(caDir).sort()).toEqual(['current.json', 'generations']);
    expect(statSync(caDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(caDir, 'current.json')).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(caDir, 'generations'))).toHaveLength(1);
    expect(readdirSync(join(authority.certPath, '..')).sort()).toEqual(['ca-cert.pem', 'ca-key.pem', 'manifest.json']);
    expect(statSync(authority.certPath).mode & 0o777).toBe(0o644);
  });

  it('rejects a partial pair instead of regenerating it', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    mkdirSync(caDir, { mode: 0o700 });
    const keyPath = join(caDir, 'ca-key.pem');
    writeFileSync(keyPath, 'partial-key', { mode: 0o600 });

    expect(() => loadOrCreateCA(caDir)).toThrow(/CA is incomplete/u);
    expect(readdirSync(caDir)).toEqual(['ca-key.pem']);
  });

  it('rejects unsafe key mode, links, and symlinks without replacing the pair', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const ca = loadOrCreateCA(caDir);
    const originalKey = ca.keyPem;

    chmodSync(ca.keyPath, 0o644);
    expect(() => loadOrCreateCA(caDir)).toThrow(/private key .* mode 644, expected 600/u);
    expect(statSync(ca.keyPath).mode & 0o777).toBe(0o644);
    chmodSync(ca.keyPath, 0o600);

    linkSync(ca.keyPath, join(caDir, 'key-alias.pem'));
    expect(() => loadOrCreateCA(caDir)).toThrow(/one unlinked regular file/u);
    rmSync(join(caDir, 'key-alias.pem'));

    const certTarget = join(caDir, 'cert-target.pem');
    renameSync(ca.certPath, certTarget);
    symlinkSync(certTarget, ca.certPath);
    expect(() => loadOrCreateCA(caDir)).toThrow();
    expect(readFileSync(ca.keyPath, 'utf8')).toBe(originalKey);
  });

  it('rejects a mismatched private key and a non-CA certificate', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const first = loadOrCreateCA(join(tempDir, 'first'));
    const second = loadOrCreateCA(join(tempDir, 'second'));
    writeFileSync(first.keyPath, second.keyPem, { mode: 0o600 });
    chmodSync(first.keyPath, 0o600);
    expect(() => loadOrCreateCA(join(tempDir, 'first'))).toThrow(/do not match/u);

    const key = forge.pki.privateKeyFromPem(second.keyPem);
    const cert = forge.pki.certificateFromPem(second.certPem);
    cert.setExtensions([{ name: 'basicConstraints', cA: false }]);
    cert.sign(key, forge.md.sha256.create());
    writeFileSync(second.certPath, forge.pki.certificateToPem(cert), { mode: 0o644 });
    chmodSync(second.certPath, 0o644);
    expect(() => loadOrCreateCA(join(tempDir, 'second'))).toThrow(/strict-v2 profile/u);
  });

  it('rejects a strict-v2 root whose authority key identifier does not match its subject key identifier', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const authority = loadOrCreateCA(caDir);
    const key = forge.pki.privateKeyFromPem(authority.keyPem);
    const cert = forge.pki.certificateFromPem(authority.certPem);
    cert.setExtensions([
      { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
      { name: 'subjectKeyIdentifier' },
      { name: 'authorityKeyIdentifier', keyIdentifier: forge.random.getBytesSync(20) },
    ]);
    cert.sign(key, forge.md.sha256.create());
    writeFileSync(authority.certPath, forge.pki.certificateToPem(cert), { mode: 0o644 });
    chmodSync(authority.certPath, 0o644);

    expect(() => loadOrCreateCA(caDir)).toThrow(/authority key identifier does not match/u);
  });

  it('rejects an expired certificate and does not rotate it', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const authority = loadOrCreateCA(caDir);
    const key = forge.pki.privateKeyFromPem(authority.keyPem);
    const cert = forge.pki.certificateFromPem(authority.certPem);
    cert.validity.notBefore = new Date('2020-01-01T00:00:00.000Z');
    cert.validity.notAfter = new Date('2021-01-01T00:00:00.000Z');
    cert.sign(key, forge.md.sha256.create());
    const expiredPem = forge.pki.certificateToPem(cert);
    writeFileSync(authority.certPath, expiredPem, { mode: 0o644 });
    chmodSync(authority.certPath, 0o644);

    expect(() => loadOrCreateCA(caDir)).toThrow(/validity window/u);
    expect(readFileSync(authority.certPath, 'utf8')).toBe(expiredPem);
  });

  it('fails closed while the exclusive authority lock is held', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    mkdirSync(caDir, { mode: 0o700 });
    writeFileSync(join(caDir, '.ca.lock'), '{}\n', { mode: 0o600 });

    expect(() => loadOrCreateCA(caDir)).toThrow(/process lock is busy/u);
    expect(readdirSync(caDir)).toEqual(['.ca.lock']);
  });

  it('publishes one authority under concurrent first-use creator/loaders', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');

    const results = await Promise.all([runAuthorityLoader(caDir), runAuthorityLoader(caDir)]);
    const successes = results.filter((result) => result.status === 'ok');
    const failures = results.filter((result) => result.status === 'error');
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(failures.every((result) => /process lock is busy/u.test(result.message))).toBe(true);
    expect(new Set(successes.map((result) => result.certPem))).toHaveLength(1);

    const loaded = loadOrCreateCA(caDir);
    expect(loaded.certPem).toBe(successes[0]?.certPem);
    expect(readdirSync(caDir).sort()).toEqual(['current.json', 'generations']);
    expect(readdirSync(join(caDir, 'generations'))).toHaveLength(1);
  });

  it('rejects a group-writable authority directory', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    mkdirSync(caDir, { mode: 0o770 });
    chmodSync(caDir, 0o770);

    expect(() => loadOrCreateCA(caDir)).toThrow(/group- or world-writable/u);
  });

  it('rejects creation beneath an untrusted writable parent without creating CA state', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const parent = join(tempDir, 'writable-parent');
    const caDir = join(parent, 'ca');
    mkdirSync(parent, { mode: 0o770 });
    chmodSync(parent, 0o770);

    expect(() => loadOrCreateCA(caDir)).toThrow(/CA directory .* group- or world-writable/u);
    expect(() => lstatSync(caDir)).toThrow();
  });

  it('migrates one exact legacy-v1 flat pair to strict-v2 and removes the legacy paths', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const source = createLegacyAuthority();
    const target = join(tempDir, 'target');
    mkdirSync(target, { mode: 0o700 });
    writeFileSync(join(target, 'ca-cert.pem'), source.certPem, { mode: 0o644 });
    writeFileSync(join(target, 'ca-key.pem'), source.keyPem, { mode: 0o600 });

    const migrated = loadOrCreateCA(target);
    expect(migrated.certPem).not.toBe(source.certPem);
    expect(migrated.keyPem).toBe(source.keyPem);
    expect(forge.pki.certificateFromPem(migrated.certPem).verifySubjectKeyIdentifier()).toBe(true);
    expect(readdirSync(target).sort()).toEqual(['current.json', 'generations']);
    expect(JSON.parse(readFileSync(join(target, 'current.json'), 'utf8')).generation).toBe(migrated.generation);
    expect(migrated.certPath).toContain('/generations/gen-');
  });

  it('atomically migrates a current legacy-v1 generation and preserves the old complete generation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const legacy = createLegacyAuthority();
    const legacyGeneration = 'gen-00000000-0000-4000-8000-000000000010';
    writeCurrentGenerationFixture(caDir, legacyGeneration, legacy.certPem, legacy.keyPem);

    const migrated = loadOrCreateCA(caDir);
    expect(migrated.generation).not.toBe(legacyGeneration);
    expect(migrated.certPem).not.toBe(legacy.certPem);
    expect(migrated.keyPem).toBe(legacy.keyPem);
    expect(readdirSync(join(caDir, 'generations')).sort()).toEqual([legacyGeneration, migrated.generation].sort());
    expect(readFileSync(join(caDir, 'generations', legacyGeneration, 'ca-cert.pem'), 'utf8')).toBe(legacy.certPem);

    const second = loadOrCreateCA(caDir);
    expect(second.generation).toBe(migrated.generation);
    expect(second.certPem).toBe(migrated.certPem);
    expect(readdirSync(join(caDir, 'generations'))).toHaveLength(2);
  });

  it('recovers an interrupted migration temp and retains every complete generation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const legacy = createLegacyAuthority();
    const legacyGeneration = 'gen-00000000-0000-4000-8000-000000000011';
    writeCurrentGenerationFixture(caDir, legacyGeneration, legacy.certPem, legacy.keyPem);
    const interrupted = join(caDir, `.current.json.tmp-${process.pid}-00000000-0000-4000-8000-000000000099`);
    writeFileSync(interrupted, '{"interrupted":true}\n', { mode: 0o600 });

    const migrated = loadOrCreateCA(caDir);
    expect(existsSync(interrupted)).toBe(false);
    expect(migrated.generation).not.toBe(legacyGeneration);
    expect(readdirSync(join(caDir, 'generations')).sort()).toEqual([legacyGeneration, migrated.generation].sort());
  });

  it('rejects a malformed near-legacy profile instead of migrating it', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    mkdirSync(caDir, { mode: 0o700 });
    const malformed = createLegacyAuthority([{ name: 'subjectKeyIdentifier' }]);
    writeFileSync(join(caDir, 'ca-cert.pem'), malformed.certPem, { mode: 0o644 });
    writeFileSync(join(caDir, 'ca-key.pem'), malformed.keyPem, { mode: 0o600 });

    expect(() => loadOrCreateCA(caDir)).toThrow(/legacy-v1 or strict-v2 profile/u);
    expect(readdirSync(caDir).sort()).toEqual(['ca-cert.pem', 'ca-key.pem']);
  });

  it('publishes only one strict-v2 migration under concurrent current-generation loaders', async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const legacy = createLegacyAuthority();
    const legacyGeneration = 'gen-00000000-0000-4000-8000-000000000012';
    writeCurrentGenerationFixture(caDir, legacyGeneration, legacy.certPem, legacy.keyPem);

    const results = await Promise.all([runAuthorityLoader(caDir), runAuthorityLoader(caDir)]);
    const successes = results.filter((result) => result.status === 'ok');
    const failures = results.filter((result) => result.status === 'error');
    expect(successes.length).toBeGreaterThanOrEqual(1);
    expect(failures.every((result) => /process lock is busy/u.test(result.message))).toBe(true);
    expect(new Set(successes.map((result) => result.certPem))).toHaveLength(1);

    const migrated = loadOrCreateCA(caDir);
    expect(migrated.certPem).toBe(successes[0]?.certPem);
    expect(migrated.certPem).not.toBe(legacy.certPem);
    expect(readdirSync(join(caDir, 'generations')).sort()).toEqual([legacyGeneration, migrated.generation].sort());
  });

  it('removes an unreachable partial generation and interrupted current temp before first publication', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const generations = join(caDir, 'generations');
    const stale = join(generations, 'gen-00000000-0000-4000-8000-000000000000');
    mkdirSync(stale, { recursive: true, mode: 0o700 });
    chmodSync(caDir, 0o700);
    chmodSync(generations, 0o700);
    chmodSync(stale, 0o700);
    writeFileSync(join(stale, 'ca-key.pem'), 'partial', { mode: 0o600 });
    writeFileSync(join(caDir, `.current.json.tmp-${process.pid}-00000000-0000-4000-8000-000000000000`), '{}\n', {
      mode: 0o600,
    });

    const authority = loadOrCreateCA(caDir);
    expect(authority.certPath).not.toContain('gen-00000000-0000-4000-8000-000000000000');
    expect(readdirSync(caDir).sort()).toEqual(['current.json', 'generations']);
    expect(readdirSync(generations)).toHaveLength(1);
  });

  it('removes a complete but unreachable generation before publishing a different current generation', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const source = loadOrCreateCA(join(tempDir, 'source'));
    const caDir = join(tempDir, 'target');
    const generations = join(caDir, 'generations');
    const staleName = 'gen-00000000-0000-4000-8000-000000000001';
    mkdirSync(generations, { recursive: true, mode: 0o700 });
    chmodSync(caDir, 0o700);
    chmodSync(generations, 0o700);
    cpSync(join(source.certPath, '..'), join(generations, staleName), { recursive: true });
    chmodSync(join(generations, staleName), 0o700);

    const authority = loadOrCreateCA(caDir);
    expect(authority.certPath).not.toContain(staleName);
    expect(readdirSync(generations)).toHaveLength(1);
  });

  it('rejects a corrupt current pointer without falling back to legacy bytes or generating a replacement', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const authority = loadOrCreateCA(caDir);
    writeFileSync(join(caDir, 'current.json'), '{"schemaVersion":1}\n', { mode: 0o600 });
    chmodSync(join(caDir, 'current.json'), 0o600);
    writeFileSync(join(caDir, 'ca-cert.pem'), authority.certPem, { mode: 0o644 });
    writeFileSync(join(caDir, 'ca-key.pem'), authority.keyPem, { mode: 0o600 });

    expect(() => loadOrCreateCA(caDir)).toThrow(/current manifest/u);
    expect(readdirSync(join(caDir, 'generations'))).toHaveLength(1);
    expect(readFileSync(join(caDir, 'current.json'), 'utf8')).toBe('{"schemaVersion":1}\n');
  });

  it('recovers interrupted post-pointer cleanup of the exact migrated legacy-v1 pair', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ca-test-'));
    const caDir = join(tempDir, 'ca');
    const legacy = createLegacyAuthority();
    mkdirSync(caDir, { mode: 0o700 });
    writeFileSync(join(caDir, 'ca-cert.pem'), legacy.certPem, { mode: 0o644 });
    writeFileSync(join(caDir, 'ca-key.pem'), legacy.keyPem, { mode: 0o600 });
    const authority = loadOrCreateCA(caDir);
    writeFileSync(join(caDir, 'ca-cert.pem'), legacy.certPem, { mode: 0o644 });
    writeFileSync(join(caDir, 'ca-key.pem'), legacy.keyPem, { mode: 0o600 });

    const loaded = loadOrCreateCA(caDir);
    expect(loaded.keyPem).toBe(authority.keyPem);
    expect(loaded.certPem).toBe(authority.certPem);
    expect(existsSync(join(caDir, 'ca-cert.pem'))).toBe(false);
    expect(existsSync(join(caDir, 'ca-key.pem'))).toBe(false);
  });
});

describe('randomSerialNumber', () => {
  // node-forge encodes the serial's bytes verbatim as a DER INTEGER with no sign
  // padding, so a leading byte >= 0x80 becomes a NEGATIVE integer that strict
  // OpenSSL (Node 22 / OpenSSL 3.0.x) rejects at cert-load with "illegal padding".
  // The leading byte must always encode a positive, minimally-encoded integer:
  // >= 0x01 (non-zero, no redundant sign pad) and < 0x80 (positive).
  it('always produces a positive, minimally-encoded leading byte', () => {
    for (let i = 0; i < 500; i++) {
      const serial = randomSerialNumber();
      const first = parseInt(serial.slice(0, 2), 16);
      expect(first).toBeGreaterThanOrEqual(0x01);
      expect(first).toBeLessThan(0x80);
    }
  });

  it('returns 32 hex chars (16 bytes) of even length', () => {
    const serial = randomSerialNumber();
    expect(serial).toHaveLength(32);
    expect(serial).toMatch(/^[0-9a-f]+$/);
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

interface AuthorityLoaderResult {
  readonly status: 'ok' | 'error';
  readonly certPem: string;
  readonly message: string;
}

async function runAuthorityLoader(caDir: string): Promise<AuthorityLoaderResult> {
  const moduleUrl = pathToFileURL(join(process.cwd(), 'src', 'docker', 'ca.ts')).href;
  const program = `
    import { loadOrCreateCA } from ${JSON.stringify(moduleUrl)};
    try {
      const authority = loadOrCreateCA(process.env.IRONCURTAIN_CA_TEST_DIRECTORY);
      process.stdout.write(JSON.stringify({ status: 'ok', certPem: authority.certPem, message: '' }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: 'error', certPem: '', message: String(error) }));
    }
  `;
  return await new Promise<AuthorityLoaderResult>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', program], {
      cwd: process.cwd(),
      env: { ...process.env, IRONCURTAIN_CA_TEST_DIRECTORY: caDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`CA loader child exited ${String(code)}: ${stderr}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout) as AuthorityLoaderResult);
      } catch (error) {
        rejectPromise(new Error(`CA loader child emitted invalid JSON: ${stdout}\n${stderr}`, { cause: error }));
      }
    });
  });
}

interface AuthorityPemPair {
  readonly certPem: string;
  readonly keyPem: string;
}

function createLegacyAuthority(extraExtensions: readonly Record<string, unknown>[] = []): AuthorityPemPair {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = randomSerialNumber();
  const now = new Date();
  certificate.validity.notBefore = now;
  certificate.validity.notAfter = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);
  const name = [{ name: 'commonName', value: 'IronCurtain MITM CA' }];
  certificate.setSubject(name);
  certificate.setIssuer(name);
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
    ...extraExtensions,
  ]);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(certificate),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function writeCurrentGenerationFixture(caDir: string, generation: string, certPem: string, keyPem: string): void {
  const generationDirectory = join(caDir, 'generations', generation);
  mkdirSync(generationDirectory, { recursive: true, mode: 0o700 });
  chmodSync(caDir, 0o700);
  chmodSync(join(caDir, 'generations'), 0o700);
  chmodSync(generationDirectory, 0o700);
  const certBytes = Buffer.from(certPem);
  const keyBytes = Buffer.from(keyPem);
  writeFileSync(join(generationDirectory, 'ca-cert.pem'), certBytes, { mode: 0o644 });
  writeFileSync(join(generationDirectory, 'ca-key.pem'), keyBytes, { mode: 0o600 });
  const generationManifest = Buffer.from(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        certificate: {
          filename: 'ca-cert.pem',
          sha256: sha256(certBytes),
          size: certBytes.length,
          mode: '0644',
        },
        privateKey: {
          filename: 'ca-key.pem',
          sha256: sha256(keyBytes),
          size: keyBytes.length,
          mode: '0600',
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(generationDirectory, 'manifest.json'), generationManifest, { mode: 0o600 });
  writeFileSync(
    join(caDir, 'current.json'),
    `${JSON.stringify({ schemaVersion: 1, generation, manifestSha256: sha256(generationManifest) }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex');
}

function authorityKeyIdentifierHex(certificate: forge.pki.Certificate): string | undefined {
  const extension = certificate.extensions.find((candidate) => candidate.id === '2.5.29.35') as
    | { value?: unknown }
    | undefined;
  if (typeof extension?.value !== 'string') return undefined;
  const parsed = forge.asn1.fromDer(extension.value);
  if (!Array.isArray(parsed.value) || parsed.value.length !== 1) return undefined;
  const keyIdentifier = parsed.value[0];
  return typeof keyIdentifier.value === 'string' ? forge.util.bytesToHex(keyIdentifier.value) : undefined;
}

async function runStrictPythonTlsClient(socketPath: string, caPath: string, hostname: string): Promise<string> {
  const program = String.raw`
import socket
import ssl
import sys

context = ssl.create_default_context(cafile=sys.argv[2])
context.verify_flags |= ssl.VERIFY_X509_STRICT
if not context.verify_flags & ssl.VERIFY_X509_STRICT:
    raise RuntimeError("VERIFY_X509_STRICT is not enabled")
raw = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
raw.connect(sys.argv[1])
with context.wrap_socket(raw, server_hostname=sys.argv[3]) as connection:
    if connection.recv(64) != b"strict-ok":
        raise RuntimeError("unexpected TLS response")
    der = connection.getpeercert(binary_form=True)
sys.stdout.write(ssl.DER_cert_to_PEM_cert(der))
`;
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn('python3', ['-c', program, socketPath, caPath, hostname], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', rejectPromise);
    child.once('exit', (code) => {
      if (code !== 0) {
        rejectPromise(new Error(`strict Python TLS client exited ${String(code)}: ${stderr}`));
        return;
      }
      resolvePromise(stdout);
    });
  });
}
