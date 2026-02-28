/**
 * PII/credential redactor for audit log entries.
 *
 * Scans string values in audit entry arguments and result content for
 * sensitive data patterns (credit cards, SSNs, API keys) and replaces
 * them with masked versions before writing to the JSONL audit log.
 *
 * Redaction is opt-in via the `auditRedaction.enabled` user config flag.
 * When disabled, entries pass through unchanged (preserving full
 * forensic logging).
 */

// ── Pattern definitions ────────────────────────────────────────────────

/**
 * Credit card: 13–19 digits possibly separated by single spaces or dashes.
 * Each repetition matches exactly one digit + optional separator, avoiding
 * nested quantifiers that cause exponential backtracking (ReDoS).
 * Validated with Luhn checksum after extraction.
 */
const CREDIT_CARD_RE = /\b\d(?:[ -]?\d){12,18}\b/g;

/** US Social Security Number: 3-2-4 digit groups. */
const SSN_RE = /\b(\d{3})[- ]?(\d{2})[- ]?(\d{4})\b/g;

/** API keys from known providers. */
const API_KEY_RE =
  /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xoxb-[a-zA-Z0-9-]{20,}|xoxp-[a-zA-Z0-9-]{20,}|AKIA[A-Z0-9]{16})\b/g;

// SSN area numbers that are never valid.
const INVALID_SSN_AREAS = new Set(['000', '666']);

// ── Luhn checksum ──────────────────────────────────────────────────────

function luhnCheck(digits: string): boolean {
  if (!digits || !/^\d+$/.test(digits)) return false;
  let total = 0;
  for (let i = digits.length - 1, alt = false; i >= 0; i--, alt = !alt) {
    let n = Number(digits[i]);
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    total += n;
  }
  return total % 10 === 0;
}

// ── Redaction helpers ──────────────────────────────────────────────────

function redactCreditCard(raw: string): string {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length <= 8) return '*'.repeat(digits.length);
  return digits.slice(0, 4) + ' ' + '*'.repeat(digits.length - 8) + ' ' + digits.slice(-4);
}

function redactSsn(_area: string, _group: string, serial: string): string {
  return `***-**-${serial}`;
}

function redactApiKey(raw: string): string {
  if (raw.length > 8) return raw.slice(0, 4) + '...' + raw.slice(-4);
  return raw.slice(0, 4) + '...';
}

// ── String redaction ───────────────────────────────────────────────────

/**
 * Redacts all recognized PII/credential patterns in a single string.
 * Returns the redacted string and whether any redaction occurred.
 */
export function redactString(text: string): { redacted: string; changed: boolean } {
  let result = text;
  let changed = false;

  // Credit cards (Luhn-validated)
  result = result.replace(CREDIT_CARD_RE, (match) => {
    const digits = match.replace(/[^0-9]/g, '');
    if (digits.length < 13 || digits.length > 19) return match;
    if (!luhnCheck(digits)) return match;
    changed = true;
    return redactCreditCard(match);
  });

  // SSNs
  result = result.replace(SSN_RE, (match, area: string, group: string, serial: string) => {
    if (INVALID_SSN_AREAS.has(area)) return match;
    if (Number(area) >= 900) return match;
    if (group === '00') return match;
    if (serial === '0000') return match;
    changed = true;
    return redactSsn(area, group, serial);
  });

  // API keys
  result = result.replace(API_KEY_RE, (match) => {
    changed = true;
    return redactApiKey(match);
  });

  return { redacted: result, changed };
}

// ── Deep object redaction ──────────────────────────────────────────────

/**
 * Recursively walks an object, redacting string values that contain
 * PII/credential patterns. Returns a deep copy with redacted values.
 * Non-string primitives, nulls, and undefined pass through unchanged.
 */
export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    const { redacted } = redactString(obj);
    return redacted as unknown as T;
  }

  if (Array.isArray(obj)) {
    const mapped: unknown[] = obj.map((item: unknown) => redactObject(item));
    return mapped as unknown as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = redactObject(value);
    }
    return result as T;
  }

  return obj;
}
