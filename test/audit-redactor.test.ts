import { describe, it, expect } from 'vitest';
import { redactString, redactObject } from '../src/trusted-process/audit-redactor.js';

// ── redactString ───────────────────────────────────────────────────────

describe('redactString', () => {
  // Credit cards
  it('redacts a valid Visa card number', () => {
    const { redacted, changed } = redactString('card is 4111111111111111');
    expect(changed).toBe(true);
    expect(redacted).toContain('4111');
    expect(redacted).not.toContain('4111111111111111');
  });

  it('redacts a card number with spaces', () => {
    const { redacted, changed } = redactString('4111 1111 1111 1111');
    expect(changed).toBe(true);
    expect(redacted).not.toContain('4111 1111 1111 1111');
  });

  it('redacts a card number with dashes', () => {
    const { redacted, changed } = redactString('4111-1111-1111-1111');
    expect(changed).toBe(true);
    expect(redacted).not.toContain('4111-1111-1111-1111');
  });

  it('does not redact a number that fails Luhn', () => {
    const { redacted, changed } = redactString('4111111111111112');
    expect(changed).toBe(false);
    expect(redacted).toBe('4111111111111112');
  });

  // SSNs
  it('redacts a valid SSN with dashes', () => {
    const { redacted, changed } = redactString('SSN: 123-45-6789');
    expect(changed).toBe(true);
    expect(redacted).toContain('***-**-6789');
    expect(redacted).not.toContain('123-45');
  });

  it('redacts a valid SSN without dashes', () => {
    const { redacted, changed } = redactString('ssn 123456789');
    expect(changed).toBe(true);
    expect(redacted).toContain('***-**-6789');
  });

  it('does not redact SSN with area 000', () => {
    const { redacted, changed } = redactString('000-12-3456');
    expect(changed).toBe(false);
    expect(redacted).toBe('000-12-3456');
  });

  it('does not redact SSN with area 666', () => {
    const { redacted, changed } = redactString('666-12-3456');
    expect(changed).toBe(false);
    expect(redacted).toBe('666-12-3456');
  });

  it('does not redact SSN with area 900+', () => {
    const { redacted, changed } = redactString('900-12-3456');
    expect(changed).toBe(false);
    expect(redacted).toBe('900-12-3456');
  });

  it('does not redact SSN with group 00', () => {
    const { redacted, changed } = redactString('123-00-4567');
    expect(changed).toBe(false);
    expect(redacted).toBe('123-00-4567');
  });

  it('does not redact SSN with serial 0000', () => {
    const { redacted, changed } = redactString('123-45-0000');
    expect(changed).toBe(false);
    expect(redacted).toBe('123-45-0000');
  });

  // API keys
  it('redacts an OpenAI-style API key', () => {
    // Construct key at runtime to avoid push protection false positives
    const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz1234';
    const { redacted, changed } = redactString('key: ' + key);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(key);
    expect(redacted).toContain('sk-a');
  });

  it('redacts a GitHub PAT', () => {
    // Construct token at runtime to avoid push protection false positives
    const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz1234567890';
    const { redacted, changed } = redactString('token ' + token);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(token);
  });

  it('redacts an AWS access key', () => {
    // Construct key at runtime to avoid push protection false positives
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE';
    const { redacted, changed } = redactString(key);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(key);
  });

  it('redacts a Slack bot token', () => {
    // Use a constructed token to avoid push protection false positives
    const token = ['xoxb', '1234567890', 'abcdefghijklmnopqrst'].join('-');
    const { redacted, changed } = redactString(token);
    expect(changed).toBe(true);
    expect(redacted).not.toContain(token);
  });

  // No matches
  it('returns unchanged text when no patterns match', () => {
    const { redacted, changed } = redactString('hello world, nothing sensitive here');
    expect(changed).toBe(false);
    expect(redacted).toBe('hello world, nothing sensitive here');
  });

  it('handles empty string', () => {
    const { redacted, changed } = redactString('');
    expect(changed).toBe(false);
    expect(redacted).toBe('');
  });

  // Multiple patterns in one string
  it('redacts multiple patterns in a single string', () => {
    const { redacted, changed } = redactString('SSN: 123-45-6789 card: 4111111111111111');
    expect(changed).toBe(true);
    expect(redacted).toContain('***-**-6789');
    expect(redacted).not.toContain('4111111111111111');
  });
});

// ── redactObject ───────────────────────────────────────────────────────

describe('redactObject', () => {
  it('redacts string values in a flat object', () => {
    const result = redactObject({ path: '/tmp/foo', content: 'SSN: 123-45-6789' });
    expect(result.path).toBe('/tmp/foo');
    expect(result.content).toContain('***-**-6789');
  });

  it('redacts nested objects', () => {
    const result = redactObject({
      outer: {
        inner: 'card 4111111111111111',
      },
    });
    expect((result.outer as { inner: string }).inner).not.toContain('4111111111111111');
  });

  it('redacts arrays of strings', () => {
    const result = redactObject(['safe text', 'SSN: 123-45-6789']);
    expect(result[0]).toBe('safe text');
    expect(result[1]).toContain('***-**-6789');
  });

  it('passes through numbers unchanged', () => {
    const result = redactObject({ count: 42 });
    expect(result.count).toBe(42);
  });

  it('passes through null', () => {
    expect(redactObject(null)).toBeNull();
  });

  it('passes through undefined', () => {
    const undef: unknown = undefined;
    expect(redactObject(undef)).toBeUndefined();
  });

  it('passes through booleans unchanged', () => {
    const result = redactObject({ flag: true });
    expect(result.flag).toBe(true);
  });

  it('handles deeply nested mixed structures', () => {
    // Construct key at runtime to avoid push protection false positives
    const key = 'sk-' + 'abcdefghijklmnopqrstuvwxyz1234';
    const input = {
      level1: {
        level2: [{ text: key }, { text: 'no secrets' }],
      },
    };
    const result = redactObject(input);
    const items = (result.level1 as { level2: Array<{ text: string }> }).level2;
    expect(items[0].text).not.toContain(key);
    expect(items[1].text).toBe('no secrets');
  });
});

// ── AuditLog integration ───────────────────────────────────────────────

describe('AuditLog with redaction', () => {
  it('redacts when enabled', async () => {
    const { AuditLog } = await import('../src/trusted-process/audit-log.js');
    const tmpPath = `/tmp/audit-redact-test-${Date.now()}.jsonl`;
    const log = new AuditLog(tmpPath, { redact: true });

    log.log({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { content: 'SSN: 123-45-6789' },
      policyDecision: { status: 'allow' as const, rule: 'r', reason: 'r' },
      result: { status: 'success', content: 'card 4111111111111111' },
      durationMs: 10,
    });
    await log.close();

    const { readFileSync, unlinkSync } = await import('node:fs');
    const written = readFileSync(tmpPath, 'utf-8');
    expect(written).toContain('***-**-6789');
    expect(written).not.toContain('123-45-6789');
    expect(written).not.toContain('4111111111111111');
    unlinkSync(tmpPath);
  });

  it('does not redact when disabled', async () => {
    const { AuditLog } = await import('../src/trusted-process/audit-log.js');
    const tmpPath = `/tmp/audit-no-redact-test-${Date.now()}.jsonl`;
    const log = new AuditLog(tmpPath, { redact: false });

    log.log({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { content: 'SSN: 123-45-6789' },
      policyDecision: { status: 'allow' as const, rule: 'r', reason: 'r' },
      result: { status: 'success', content: 'card 4111111111111111' },
      durationMs: 10,
    });
    await log.close();

    const { readFileSync, unlinkSync } = await import('node:fs');
    const written = readFileSync(tmpPath, 'utf-8');
    expect(written).toContain('123-45-6789');
    expect(written).toContain('4111111111111111');
    unlinkSync(tmpPath);
  });

  it('does not redact by default (no options)', async () => {
    const { AuditLog } = await import('../src/trusted-process/audit-log.js');
    const tmpPath = `/tmp/audit-default-test-${Date.now()}.jsonl`;
    const log = new AuditLog(tmpPath);

    log.log({
      timestamp: '2026-01-01T00:00:00.000Z',
      requestId: 'r1',
      serverName: 'fs',
      toolName: 'read_file',
      arguments: { content: 'SSN: 123-45-6789' },
      policyDecision: { status: 'allow' as const, rule: 'r', reason: 'r' },
      result: { status: 'success' },
      durationMs: 10,
    });
    await log.close();

    const { readFileSync, unlinkSync } = await import('node:fs');
    const written = readFileSync(tmpPath, 'utf-8');
    expect(written).toContain('123-45-6789');
    unlinkSync(tmpPath);
  });
});
