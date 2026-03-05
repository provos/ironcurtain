/**
 * Tests for cron system prompt augmentation.
 * Pure function tests -- no mocking needed.
 */

import { describe, it, expect } from 'vitest';
import { buildCronSystemPromptAugmentation, buildSystemPrompt } from '../src/session/prompts.js';
import type { CronPromptContext } from '../src/session/prompts.js';

describe('buildCronSystemPromptAugmentation', () => {
  const baseContext: CronPromptContext = {
    taskDescription: 'Label all open GitHub issues that are older than 7 days',
    workspacePath: '/home/user/.ironcurtain/jobs/label-issues/workspace',
  };

  it('includes the task description', () => {
    const prompt = buildCronSystemPromptAugmentation(baseContext);
    expect(prompt).toContain('Label all open GitHub issues that are older than 7 days');
  });

  it('includes the workspace path', () => {
    const prompt = buildCronSystemPromptAugmentation(baseContext);
    expect(prompt).toContain('/home/user/.ironcurtain/jobs/label-issues/workspace');
  });

  it('mentions scheduled task mode', () => {
    const prompt = buildCronSystemPromptAugmentation(baseContext);
    expect(prompt).toContain('Scheduled Task Mode');
    expect(prompt).toContain('automated scheduled task');
  });

  it('instructs the agent about memory.md and last-run.md', () => {
    const prompt = buildCronSystemPromptAugmentation(baseContext);
    expect(prompt).toContain('memory.md');
    expect(prompt).toContain('last-run.md');
  });

  it('instructs the agent about headless behavior', () => {
    const prompt = buildCronSystemPromptAugmentation(baseContext);
    expect(prompt).toContain('Headless Behavior');
    expect(prompt).toContain('do NOT retry');
    expect(prompt).toContain('auto-denied');
  });

  it('produces different output for different contexts', () => {
    const ctx1: CronPromptContext = {
      taskDescription: 'Task A',
      workspacePath: '/path/a',
    };
    const ctx2: CronPromptContext = {
      taskDescription: 'Task B',
      workspacePath: '/path/b',
    };
    const prompt1 = buildCronSystemPromptAugmentation(ctx1);
    const prompt2 = buildCronSystemPromptAugmentation(ctx2);

    expect(prompt1).not.toBe(prompt2);
    expect(prompt1).toContain('Task A');
    expect(prompt2).toContain('Task B');
  });

  it('handles multi-line task descriptions', () => {
    const ctx: CronPromptContext = {
      taskDescription: 'Step 1: Do this\nStep 2: Do that\nStep 3: Report',
      workspacePath: '/workspace',
    };
    const prompt = buildCronSystemPromptAugmentation(ctx);
    expect(prompt).toContain('Step 1: Do this');
    expect(prompt).toContain('Step 3: Report');
  });
});

describe('buildSystemPrompt', () => {
  it('includes sandbox directory when provided', () => {
    const prompt = buildSystemPrompt([], '/tmp/sandbox');
    expect(prompt).toContain('/tmp/sandbox');
    expect(prompt).toContain('sandbox directory');
  });

  it('does not include sandbox info when not provided', () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).not.toContain('sandbox directory');
  });

  it('lists server names and descriptions', () => {
    const servers = [
      { name: 'filesystem', description: 'File operations' },
      { name: 'git', description: 'Git version control' },
    ];
    const prompt = buildSystemPrompt(servers);
    expect(prompt).toContain('**filesystem**');
    expect(prompt).toContain('File operations');
    expect(prompt).toContain('**git**');
    expect(prompt).toContain('Git version control');
  });

  it('shows "No tool servers available" when empty', () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toContain('No tool servers available');
  });

  it('includes code mode rules', () => {
    const prompt = buildSystemPrompt([]);
    expect(prompt).toContain('Code Mode rules');
    expect(prompt).toContain('synchronous');
  });
});
