/**
 * Fake API key generation for the MITM proxy.
 *
 * Generates sentinel keys that match the provider's key format to pass
 * client-side validation. These keys are given to the container; the
 * MITM proxy swaps them for real keys before forwarding upstream.
 */

import { randomBytes } from 'node:crypto';

/**
 * Generate a fake API key that matches the provider's format.
 *
 * The key is structurally valid (passes prefix/format checks) but
 * is not a real key -- the provider will reject it with 401.
 * The MITM proxy swaps it before it reaches the provider.
 */
export function generateFakeKey(prefix: string): string {
  const suffix = randomBytes(24).toString('base64url');
  return `${prefix}${suffix}`;
}
