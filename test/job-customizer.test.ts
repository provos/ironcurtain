/**
 * Tests for job constitution customizer prompt construction.
 * Pure function tests -- no LLM or interactive terminal mocking needed.
 */

import { describe, it, expect } from 'vitest';
import { buildJobCustomizerSystemPrompt } from '../src/cron/job-customizer.js';
import type { ToolAnnotation } from '../src/pipeline/types.js';

const sampleAnnotations: ToolAnnotation[] = [
  {
    toolName: 'read_file',
    serverName: 'filesystem',
    comment: 'Read file contents',

    args: { path: ['read-path'] },
  },
  {
    toolName: 'write_file',
    serverName: 'filesystem',
    comment: 'Write file contents',

    args: { path: ['write-path'] },
  },
];

describe('buildJobCustomizerSystemPrompt', () => {
  it('includes the task description in Task Context section', () => {
    const prompt = buildJobCustomizerSystemPrompt(
      '',
      sampleAnnotations,
      'Label all open GitHub issues older than 7 days',
    );
    expect(prompt).toContain('Task Context');
    expect(prompt).toContain('Label all open GitHub issues older than 7 days');
  });

  it('includes tool annotations', () => {
    const prompt = buildJobCustomizerSystemPrompt('', sampleAnnotations, 'Some task');
    expect(prompt).toContain('read_file');
    expect(prompt).toContain('write_file');
    expect(prompt).toContain('filesystem');
  });

  it('includes the base customizer instructions', () => {
    const prompt = buildJobCustomizerSystemPrompt('', sampleAnnotations, 'Some task');
    // The base system prompt mentions these
    expect(prompt).toContain('least privilege');
    expect(prompt).toContain('Response Format');
    expect(prompt).toContain('addRules');
  });

  it('focuses on task-specific permissions', () => {
    const prompt = buildJobCustomizerSystemPrompt('', sampleAnnotations, 'Some task');
    expect(prompt).toContain('THIS SPECIFIC TASK');
    expect(prompt).toContain('scheduled job');
  });

  it('includes GitHub identity context when provided', () => {
    const prompt = buildJobCustomizerSystemPrompt('', sampleAnnotations, 'Some task', {
      login: 'testuser',
      orgs: ['myorg'],
    });
    expect(prompt).toContain('testuser');
    expect(prompt).toContain('myorg');
  });

  it('works without GitHub identity', () => {
    const prompt = buildJobCustomizerSystemPrompt('', sampleAnnotations, 'Some task', null);
    expect(prompt).not.toContain('GitHub Identity');
  });

  it('includes base constitution when provided', () => {
    const prompt = buildJobCustomizerSystemPrompt(
      '# My Base Constitution\nSome rules here',
      sampleAnnotations,
      'Some task',
    );
    expect(prompt).toContain('My Base Constitution');
  });
});
