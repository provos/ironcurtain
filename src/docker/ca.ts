/**
 * IronCurtain MITM CA certificate generation and management.
 *
 * Generates a self-signed CA on first run and loads it on subsequent runs.
 * The CA key never leaves the host process; only the certificate is
 * baked into Docker images for trust.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import forge from 'node-forge';
import * as logger from '../logger.js';

export interface CertificateAuthority {
  readonly certPem: string;
  readonly keyPem: string;
  readonly certPath: string;
  readonly keyPath: string;
}

const CERT_FILENAME = 'ca-cert.pem';
const KEY_FILENAME = 'ca-key.pem';

/**
 * Loads or generates the IronCurtain CA.
 *
 * On first invocation, generates a 2048-bit RSA CA with:
 * - CN = "IronCurtain MITM CA"
 * - 10-year validity
 * - Basic Constraints: CA=true
 * - Key Usage: keyCertSign, cRLSign
 *
 * Stores cert + key in the given directory with 0600 permissions on key.
 * On load, verifies ca-key.pem has 0600 permissions and warns if not.
 * Subsequent calls load from disk.
 */
export function loadOrCreateCA(caDir: string): CertificateAuthority {
  mkdirSync(caDir, { recursive: true });

  const certPath = join(caDir, CERT_FILENAME);
  const keyPath = join(caDir, KEY_FILENAME);

  if (existsSync(certPath) && existsSync(keyPath)) {
    return loadCA(certPath, keyPath);
  }

  return generateCA(certPath, keyPath);
}

function loadCA(certPath: string, keyPath: string): CertificateAuthority {
  // Verify key file permissions
  const keyStats = statSync(keyPath);
  const keyMode = keyStats.mode & 0o777;
  if (keyMode !== 0o600) {
    logger.info(`[ca] WARNING: ${keyPath} has permissions ${keyMode.toString(8)}, expected 600`);
  }

  const certPem = readFileSync(certPath, 'utf-8');
  const keyPem = readFileSync(keyPath, 'utf-8');

  return { certPem, keyPem, certPath, keyPath };
}

function generateCA(certPath: string, keyPath: string): CertificateAuthority {
  logger.info('[ca] Generating IronCurtain MITM CA (first run)...');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomSerialNumber();

  const now = new Date();
  cert.validity.notBefore = now;
  cert.validity.notAfter = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);

  const attrs = [{ name: 'commonName', value: 'IronCurtain MITM CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

  writeFileSync(certPath, certPem, { mode: 0o644 });
  writeFileSync(keyPath, keyPem, { mode: 0o600 });

  logger.info(`[ca] CA certificate written to ${certPath}`);
  logger.info(`[ca] CA private key written to ${keyPath}`);

  return { certPem, keyPem, certPath, keyPath };
}

/** Generates a random serial number as a hex string. */
export function randomSerialNumber(): string {
  const bytes = forge.random.getBytesSync(16);
  return forge.util.bytesToHex(bytes);
}
