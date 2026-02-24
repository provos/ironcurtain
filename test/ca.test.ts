import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import forge from 'node-forge';
import { loadOrCreateCA } from '../src/docker/ca.js';

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
    expect(ca.certPath).toBe(join(caDir, 'ca-cert.pem'));
    expect(ca.keyPath).toBe(join(caDir, 'ca-key.pem'));
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

    // Check Basic Constraints CA=true
    const bc = cert.getExtension('basicConstraints') as { cA?: boolean } | null;
    expect(bc?.cA).toBe(true);

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
});
