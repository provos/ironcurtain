/**
 * Per-session public trust material for Docker agent containers.
 *
 * Agent images are intentionally CA-neutral. The host stages only the public
 * IronCurtain MITM certificate plus Node's public root set into the trusted,
 * read-only orientation directory. The CA private key never enters this API.
 */

import { randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { rootCertificates } from 'node:tls';

export const CONTAINER_RUNTIME_CA_CERT = '/etc/ironcurtain/ca-cert.pem';
export const CONTAINER_RUNTIME_CA_BUNDLE = '/etc/ironcurtain/ca-bundle.pem';
/** Stage the normalized public certificate and complete public-root bundle. */
export function stageRuntimeTrust(
  orientationDir: string,
  caCertificatePem: string,
  publicRoots: readonly string[] = rootCertificates,
): void {
  const normalizedCa = normalizeCertificate(caCertificatePem, 'IronCurtain CA certificate');
  const normalizedRoots = [...new Set(publicRoots.map((pem) => normalizeCertificate(pem, 'public root')))].sort();
  const bundlePem = `${normalizedRoots.join('\n')}\n${normalizedCa}\n`;

  writePublicFileAtomic(orientationDir, basename(CONTAINER_RUNTIME_CA_CERT), `${normalizedCa}\n`);
  writePublicFileAtomic(orientationDir, basename(CONTAINER_RUNTIME_CA_BUNDLE), bundlePem);
}

/** TLS environment shared by every Docker agent adapter. */
export function buildRuntimeTrustEnv(): Readonly<Record<string, string>> {
  return {
    NODE_EXTRA_CA_CERTS: CONTAINER_RUNTIME_CA_CERT,
    SSL_CERT_FILE: CONTAINER_RUNTIME_CA_BUNDLE,
    CURL_CA_BUNDLE: CONTAINER_RUNTIME_CA_BUNDLE,
    GIT_SSL_CAINFO: CONTAINER_RUNTIME_CA_BUNDLE,
    PIP_CERT: CONTAINER_RUNTIME_CA_BUNDLE,
    REQUESTS_CA_BUNDLE: CONTAINER_RUNTIME_CA_BUNDLE,
  };
}

/** Render the complete apt proxy/trust configuration for a fixed host endpoint. */
export function renderAptProxyConfig(proxyUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error('apt proxy URL must be an uncredentialed fixed http://host:port endpoint');
  }
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.hostname === '' ||
    parsed.port === '' ||
    /[\r\n"]/u.test(proxyUrl)
  ) {
    throw new Error('apt proxy URL must be an uncredentialed fixed http://host:port endpoint');
  }
  const endpoint = `http://${parsed.host}`;
  return [
    `Acquire::http::Proxy "${endpoint}";`,
    `Acquire::https::Proxy "${endpoint}";`,
    `Acquire::https::CaInfo "${CONTAINER_RUNTIME_CA_BUNDLE}";`,
    '',
  ].join('\n');
}

function normalizeCertificate(pem: string, label: string): string {
  const normalized = pem.replaceAll('\r\n', '\n').trim();
  if (!normalized.startsWith('-----BEGIN CERTIFICATE-----') || !normalized.endsWith('-----END CERTIFICATE-----')) {
    throw new Error(`${label} is not a PEM certificate`);
  }
  return normalized;
}

function writePublicFileAtomic(directory: string, filename: string, content: string): void {
  const target = resolve(directory, filename);
  if (resolve(directory, basename(target)) !== target) throw new Error(`invalid runtime trust filename: ${filename}`);
  try {
    if (lstatSync(target).isSymbolicLink()) throw new Error(`refusing runtime trust symlink: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = resolve(directory, `.${filename}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    chmodSync(temporary, 0o444);
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}
