import { describe, it, expect } from 'vitest';
import { createWorkflowId } from '../../src/workflow/types.js';

describe('createWorkflowId', () => {
  it('returns a string', () => {
    const id = createWorkflowId();
    expect(typeof id).toBe('string');
  });

  it('returns unique values on each call', () => {
    const ids = new Set(Array.from({ length: 100 }, () => createWorkflowId()));
    expect(ids.size).toBe(100);
  });

  it('returns a valid UUID format', () => {
    const id = createWorkflowId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
