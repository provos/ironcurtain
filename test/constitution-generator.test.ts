/**
 * Tests for constitution generator prompt construction and response parsing.
 * Pure function tests -- no session/LLM mocking needed.
 */

import { describe, it, expect } from 'vitest';
import {
  buildConstitutionGeneratorSystemPrompt,
  parseConstitutionResponse,
} from '../src/cron/constitution-generator.js';

describe('buildConstitutionGeneratorSystemPrompt', () => {
  it('includes the task description', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt(
      'Label all open GitHub issues older than 7 days',
      '/home/user/workspace',
    );
    expect(prompt).toContain('Label all open GitHub issues older than 7 days');
  });

  it('includes the workspace path', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/home/user/workspace');
    expect(prompt).toContain('/home/user/workspace');
  });

  it('includes the git repo when provided', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt(
      'Some task',
      '/home/user/workspace',
      'git@github.com:org/repo.git',
    );
    expect(prompt).toContain('git@github.com:org/repo.git');
  });

  it('indicates no git repo when not provided', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/home/user/workspace');
    expect(prompt).toContain('No git repository configured');
  });

  it('instructs the LLM about exploration', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/workspace');
    expect(prompt).toContain('Explore');
    expect(prompt).toContain('execute_code');
  });

  it('instructs the LLM about output format', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/workspace');
    expect(prompt).toContain('"constitution"');
    expect(prompt).toContain('"reasoning"');
    expect(prompt).toContain('"exploredServers"');
  });

  it('explains structural rules and workspace auto-allow', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/workspace');
    expect(prompt).toContain('Workspace auto-allow');
    expect(prompt).toContain('Default-deny');
    expect(prompt).toContain('/workspace');
  });

  it('explains cron context — unattended, no human to approve', () => {
    const prompt = buildConstitutionGeneratorSystemPrompt('Some task', '/workspace');
    expect(prompt).toContain('unattended');
    expect(prompt).toContain('no human');
  });
});

describe('parseConstitutionResponse', () => {
  it('parses valid JSON in code fences', () => {
    const response = `
I explored the workspace and found the following...

\`\`\`json
{
  "constitution": " - The agent is allowed to read files\\n - The agent must ask for approval before writes",
  "reasoning": "The workspace contains a Node.js project",
  "exploredServers": ["filesystem", "git"]
}
\`\`\`
    `;

    const result = parseConstitutionResponse(response);
    expect(result.constitution).toContain('read files');
    expect(result.reasoning).toContain('Node.js');
    expect(result.exploredServers).toEqual(['filesystem', 'git']);
  });

  it('parses raw JSON without code fences', () => {
    const response = `{
  "constitution": " - The agent is allowed to fetch URLs",
  "reasoning": "Simple web task",
  "exploredServers": ["fetch"]
}`;

    const result = parseConstitutionResponse(response);
    expect(result.constitution).toContain('fetch URLs');
  });

  it('handles missing optional fields', () => {
    const response = `\`\`\`json
{
  "constitution": " - The agent is allowed to read files"
}
\`\`\``;

    const result = parseConstitutionResponse(response);
    expect(result.constitution).toContain('read files');
    expect(result.reasoning).toBe('');
    expect(result.exploredServers).toEqual([]);
  });

  it('throws when no JSON block found', () => {
    const response = 'Here is a constitution without any JSON block.';
    expect(() => parseConstitutionResponse(response)).toThrow();
  });

  it('throws when JSON is malformed', () => {
    const response = '```json\n{invalid json}\n```';
    expect(() => parseConstitutionResponse(response)).toThrow();
  });

  it('throws when constitution field is missing', () => {
    const response = '```json\n{"reasoning": "no constitution"}\n```';
    expect(() => parseConstitutionResponse(response)).toThrow();
  });

  it('throws when constitution field is empty', () => {
    const response = '```json\n{"constitution": "   "}\n```';
    expect(() => parseConstitutionResponse(response)).toThrow();
  });

  it('handles JSON embedded in surrounding text', () => {
    const response = `
After exploring the workspace, I found a Python project. Here is the constitution:

\`\`\`json
{
  "constitution": " - The agent is allowed to read Python files\\n - The agent may run pytest",
  "reasoning": "Python project with tests",
  "exploredServers": ["filesystem"]
}
\`\`\`

Let me know if you'd like to adjust anything.
    `;

    const result = parseConstitutionResponse(response);
    expect(result.constitution).toContain('Python files');
    expect(result.exploredServers).toEqual(['filesystem']);
  });

  it('handles non-array exploredServers gracefully', () => {
    const response = '```json\n{"constitution": " - read files", "exploredServers": "filesystem"}\n```';
    const result = parseConstitutionResponse(response);
    expect(result.exploredServers).toEqual([]);
  });
});
