import { describe, expect, it } from 'vitest';
import { parsePort } from '../../../scripts/parse-port.js';

describe('parsePort', () => {
  it('accepts valid TCP ports', () => {
    expect(parsePort('1', 5173)).toBe(1);
    expect(parsePort('17400', 5173)).toBe(17400);
    expect(parsePort('65535', 5173)).toBe(65535);
  });

  it.each([undefined, '', 'not-a-port', '0', '-1', '65536', '12.5'])('falls back for invalid value %s', (value) => {
    expect(parsePort(value, 5173)).toBe(5173);
  });
});
