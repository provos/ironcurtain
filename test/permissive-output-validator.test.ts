import { describe, it, expect } from 'vitest';
import { permissiveJsonSchemaValidator } from '../src/trusted-process/permissive-output-validator.js';

describe('permissiveJsonSchemaValidator', () => {
  it('always returns valid for any input', () => {
    const validator = permissiveJsonSchemaValidator.getValidator({
      type: 'object',
      required: ['success', 'commitHash'],
      properties: {
        success: { type: 'boolean' },
        commitHash: { type: 'string' },
      },
    });

    // Even data that clearly violates the schema should pass
    const result = validator({ error: 'Git push failed', stderr: 'fatal: ...' });
    expect(result.valid).toBe(true);
    expect(result.data).toEqual({ error: 'Git push failed', stderr: 'fatal: ...' });
    expect(result.errorMessage).toBeUndefined();
  });

  it('returns valid for empty objects', () => {
    const validator = permissiveJsonSchemaValidator.getValidator({
      type: 'object',
      required: ['name'],
    });
    expect(validator({}).valid).toBe(true);
  });

  it('returns valid for null/undefined input', () => {
    const validator = permissiveJsonSchemaValidator.getValidator({ type: 'object' });
    expect(validator(null).valid).toBe(true);
    expect(validator(undefined).valid).toBe(true);
  });
});
