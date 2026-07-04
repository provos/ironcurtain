// Temporary R6 live-test runner (not committed): loads OPENROUTER_API_KEY from .env
// and runs the real §12.5 vitest test with LLM_INTEGRATION_TEST=true. Never prints the key.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const envText = readFileSync(new URL('./.env', import.meta.url), 'utf-8');
const match = envText.match(/^OPENROUTER_API_KEY=["']?([^"'\r\n]+)["']?\s*$/m);
if (!match) {
  console.error('OPENROUTER_API_KEY not found in .env');
  process.exit(2);
}

const result = spawnSync(
  'npx',
  ['vitest', 'run', 'test/docker/openrouter-live.integration.test.ts', '--reporter=verbose'],
  {
    stdio: 'inherit',
    env: { ...process.env, OPENROUTER_API_KEY: match[1], LLM_INTEGRATION_TEST: 'true' },
  },
);
process.exit(result.status ?? 1);
