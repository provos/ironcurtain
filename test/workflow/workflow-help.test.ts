import { afterEach, describe, expect, it } from 'vitest';

import { main } from '../../src/workflow/workflow-command.js';

const originalStderrWrite = process.stderr.write;

afterEach(() => {
  process.stderr.write = originalStderrWrite;
});

async function renderHelp(args: string[]): Promise<string> {
  const chunks: string[] = [];
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
    return true;
  };

  await main(args);
  return chunks.join('');
}

describe('workflow help', () => {
  it.each([['--help'], ['await', '--help']])('explains how observation commands return for %j', async (...args) => {
    const help = await renderHelp(args);

    expect(help).toContain('status');
    expect(help).toContain('Print one status snapshot and exit; use for stateless polling');
    expect(help).toContain(
      'Subscribe and exit at the next gate or terminal (not ordinary transitions); use for automation',
    );
    expect(help).toContain('Continuously stream transitions/events; does not exit after one');
    expect(help).toContain('Max seconds to await; timeout exits while the workflow keeps running');
  });
});
