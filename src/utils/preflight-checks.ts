import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { getIronCurtainHome } from '../config/paths.js';

export interface PreflightCheckResult {
  ok: boolean;
  message: string;
  details?: string;
}

/** Hard timeout for the child-process viability check. */
const SANDBOX_CHECK_TIMEOUT_MS = 10_000;

/** Cache marker — skips the subprocess on repeat runs when the env hasn't changed. */
interface CacheMarker {
  nodeVersion: string;
  utcpVersion: string;
}

function getCacheMarkerPath(): string {
  return resolve(getIronCurtainHome(), '.preflight-ok');
}

/**
 * Resolves the installed `@utcp/code-mode` version by reading its
 * `node_modules/@utcp/code-mode/package.json`. We pick the resolved version
 * (not the semver range from the root package.json) because the cache is
 * about ABI compatibility — the installed build is what actually runs.
 * Returns null if the package can't be located (treated as a cache miss).
 *
 * Uses Node's module resolution (via createRequire) rather than cwd-based
 * guessing so this works from any invocation directory, including global
 * installs.
 */
function resolveUtcpVersion(): string | null {
  try {
    const pkgPath = createRequire(import.meta.url).resolve('@utcp/code-mode/package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string };
    if (typeof pkg.version === 'string') return pkg.version;
  } catch {
    // Fall through — caller treats null as "no cache, run real check".
  }
  return null;
}

function readCacheMarker(): CacheMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(getCacheMarkerPath(), 'utf-8')) as Partial<CacheMarker>;
    if (typeof parsed.nodeVersion !== 'string' || typeof parsed.utcpVersion !== 'string') {
      return null;
    }
    return { nodeVersion: parsed.nodeVersion, utcpVersion: parsed.utcpVersion };
  } catch {
    return null;
  }
}

function writeCacheMarker(marker: CacheMarker): void {
  try {
    mkdirSync(getIronCurtainHome(), { recursive: true });
    writeFileSync(getCacheMarkerPath(), JSON.stringify(marker), { mode: 0o600 });
  } catch {
    // Cache writes are best-effort — failure just means we re-run next time.
  }
}

/**
 * Validates that the V8 sandbox (isolated-vm) can be initialized.
 * We spawn a separate Node process to prevent native module crashes (like
 * segfaults on Node 25 or ABI mismatches from stale builds) from killing
 * the main CLI process.
 *
 * On success, writes a cache marker keyed on `{nodeVersion, utcpVersion}`
 * so subsequent invocations skip the spawn (which otherwise costs hundreds
 * of ms for the UTCP module load).
 */
export async function checkSandboxViability(): Promise<PreflightCheckResult> {
  const utcpVersion = resolveUtcpVersion();
  if (utcpVersion) {
    const cached = readCacheMarker();
    if (cached && cached.nodeVersion === process.versions.node && cached.utcpVersion === utcpVersion) {
      return { ok: true, message: 'cached' };
    }
  }

  const result = await runSandboxViabilityCheck();
  if (result.ok && utcpVersion) {
    writeCacheMarker({ nodeVersion: process.versions.node, utcpVersion });
  }
  return result;
}

function runSandboxViabilityCheck(): Promise<PreflightCheckResult> {
  return new Promise((resolvePromise) => {
    // The script simply attempts to import and instantiate the UTCP client.
    const script = `
      import('@utcp/code-mode')
        .then((m) => m.CodeModeUtcpClient.create())
        .then(() => process.exit(0))
        .catch((e) => {
          console.error(e.message || e);
          process.exit(1);
        });
    `;

    const child = spawn(process.execPath, ['--no-warnings', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: process.env,
    });

    let stderrOutput = '';
    let settled = false;

    const settle = (result: PreflightCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const timer = setTimeout(() => {
      // SIGKILL directly — the child is either hung in native init or stuck
      // loading UTCP, neither of which respects SIGTERM cleanly.
      child.kill('SIGKILL');
      settle({
        ok: false,
        message: 'Sandbox viability check timed out.',
        details:
          `The V8 sandbox (isolated-vm) did not initialize within ${SANDBOX_CHECK_TIMEOUT_MS}ms. ` +
          'This usually indicates a hung native module load. ' +
          'Try `npm rebuild` or `rm -rf node_modules && npm install` to rebuild dependencies.',
      });
    }, SANDBOX_CHECK_TIMEOUT_MS);

    child.stderr.on('data', (chunk: Buffer | string) => {
      stderrOutput += typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
    });

    child.on('close', (code, signal) => {
      if (settled) return;

      if (code === 0 && !signal) {
        settle({ ok: true, message: 'V8 sandbox loaded successfully.' });
        return;
      }

      let details = stderrOutput.trim();
      let message = 'Failed to initialize the V8 sandbox (isolated-vm).';

      if (signal) {
        message = `V8 sandbox crashed with signal ${signal}.`;
        if (signal === 'SIGSEGV' || signal === 'SIGILL') {
          details =
            'This is often caused by an incompatible Node.js version (e.g., Node 25). ' +
            'Please use Node.js 22, 23, or 24.';
        }
      } else if (details.includes('NODE_MODULE_VERSION')) {
        message = 'Native module ABI mismatch detected.';
        details =
          'You likely changed Node.js versions without rebuilding dependencies. ' +
          'Run `npm rebuild` or `rm -rf node_modules && npm install` to fix this.';
      } else if (details.includes('Cannot find package')) {
        message = 'Missing required dependency: @utcp/code-mode';
        details = 'Run `npm install` to ensure all dependencies are present.';
      }

      settle({
        ok: false,
        message,
        details: details || `Process exited with code ${code}`,
      });
    });

    child.on('error', (err) => {
      settle({
        ok: false,
        message: 'Failed to spawn sandbox check process.',
        details: err.message,
      });
    });
  });
}
