import { describe, it, expect } from 'vitest';
import { applyToolDescriptionHints } from '../src/trusted-process/tool-description-hints.js';
import type { ProxiedTool } from '../src/trusted-process/mcp-proxy-server.js';

describe('applyToolDescriptionHints', () => {
  const tools: ProxiedTool[] = [
    { serverName: 'git', name: 'git_checkout', description: 'Checkout a branch.', inputSchema: {} },
    { serverName: 'git', name: 'git_push', description: 'Push commits.', inputSchema: {} },
    { serverName: 'fs', name: 'read_file', description: 'Read a file.', inputSchema: {} },
  ];

  it('appends hints to matching tools', () => {
    const hints = new Map([['git__git_checkout', 'Use createBranch: true for new branches.']]);
    const result = applyToolDescriptionHints(tools, hints);

    expect(result[0].description).toBe('Checkout a branch.\n\nUse createBranch: true for new branches.');
    expect(result[1].description).toBe('Push commits.');
    expect(result[2].description).toBe('Read a file.');
  });

  it('returns tools unchanged when no hints match', () => {
    const hints = new Map([['unknown__tool', 'some hint']]);
    const result = applyToolDescriptionHints(tools, hints);

    expect(result).toEqual(tools);
  });

  it('returns tools unchanged when hints map is empty', () => {
    const result = applyToolDescriptionHints(tools, new Map());
    expect(result).toBe(tools);
  });

  it('handles tools with no description', () => {
    const toolsNoDesc: ProxiedTool[] = [{ serverName: 'git', name: 'git_checkout', inputSchema: {} }];
    const hints = new Map([['git__git_checkout', 'Use createBranch.']]);
    const result = applyToolDescriptionHints(toolsNoDesc, hints);

    expect(result[0].description).toBe('Use createBranch.');
  });
});
