/**
 * Checks whether isolated-vm's V8 Isolate creation works on this platform.
 *
 * isolated-vm is a native module that may crash on unsupported Node.js versions
 * (e.g., Node.js v25+). Since the crash kills the process, we spawn a child
 * process to probe it safely.
 */

import { execFileSync } from 'node:child_process';

let cachedResult: boolean | undefined;

export function isIsolatedVmAvailable(): boolean {
  if (cachedResult !== undefined) return cachedResult;

  try {
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import ivm from 'isolated-vm';
        const isolate = new ivm.Isolate({ memoryLimit: 128 });
        const ctx = await isolate.createContext();
        await ctx.eval('1+1');
        isolate.dispose();
      `,
      ],
      {
        timeout: 10_000,
        stdio: 'pipe',
        cwd: process.cwd(),
      },
    );
    cachedResult = true;
  } catch {
    cachedResult = false;
  }

  return cachedResult;
}
