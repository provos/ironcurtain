import { describe, it, expect } from 'vitest';
import {
  updateServerContext,
  formatServerContext,
  type ServerContextMap,
} from '../src/trusted-process/server-context.js';

describe('updateServerContext', () => {
  it('captures working directory from git_set_working_dir', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/home/user/repo' });
    expect(map.get('git')?.workingDirectory).toBe('/home/user/repo');
  });

  it('captures working directory from git_clone via localPath', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_clone', {
      url: 'https://github.com/user/repo.git',
      localPath: '/tmp/cloned-repo',
    });
    expect(map.get('git')?.workingDirectory).toBe('/tmp/cloned-repo');
  });

  it('ignores unrelated tools', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'fs', 'read_file', { path: '/etc/hosts' });
    expect(map.has('fs')).toBe(false);
  });

  it('ignores git_set_working_dir with non-string path', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_set_working_dir', { path: 123 });
    expect(map.has('git')).toBe(false);
  });

  it('updates existing context on subsequent calls', () => {
    const map: ServerContextMap = new Map();
    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/first' });
    updateServerContext(map, 'git', 'git_set_working_dir', { path: '/second' });
    expect(map.get('git')?.workingDirectory).toBe('/second');
  });
});

describe('formatServerContext', () => {
  it('returns undefined when no context exists', () => {
    const map: ServerContextMap = new Map();
    expect(formatServerContext(map, 'git')).toBeUndefined();
  });

  it('returns working directory when set', () => {
    const map: ServerContextMap = new Map();
    map.set('git', { workingDirectory: '/home/user/repo' });
    expect(formatServerContext(map, 'git')).toEqual({ 'Working directory': '/home/user/repo' });
  });

  it('returns undefined when context has no populated fields', () => {
    const map: ServerContextMap = new Map();
    map.set('git', {});
    expect(formatServerContext(map, 'git')).toBeUndefined();
  });
});
