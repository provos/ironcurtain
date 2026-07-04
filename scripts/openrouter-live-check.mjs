// OpenRouter R6 live-test runner (wired into package.json as `openrouter-live-check`):
// loads OPENROUTER_API_KEY from the repo-root .env and runs the real §12.5 vitest
// integration test with LLM_INTEGRATION_TEST=true. Opt-in; never prints the key.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Resolve paths relative to the repo root (this script lives in scripts/), so the
// check works no matter what directory it is invoked from.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const envUrl = new URL('../.env', import.meta.url);

let envText;
try {
  envText = readFileSync(envUrl, 'utf-8');
} catch (err) {
  const reason =
    err && err.code === 'ENOENT'
      ? 'no .env file at the repo root'
      : `could not read .env (${(err && err.code) || err})`;
  process.stderr.write(`openrouter-live-check: ${reason} — set OPENROUTER_API_KEY in .env to run the live check\n`);
  process.exit(2);
}

const match = envText.match(/^OPENROUTER_API_KEY=["']?([^"'\r\n]+)["']?\s*$/m);
if (!match) {
  process.stderr.write('openrouter-live-check: OPENROUTER_API_KEY not found in .env\n');
  process.exit(2);
}

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'test/docker/openrouter-live.integration.test.ts', '--reporter=verbose'],
  {
    stdio: 'inherit',
    cwd: repoRoot,
    env: { ...process.env, OPENROUTER_API_KEY: match[1], LLM_INTEGRATION_TEST: 'true' },
  },
);
process.exit(result.status ?? 1);
