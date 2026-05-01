/**
 * Post-build script: copies non-TS config assets into dist/config/
 * so that __dirname-relative path resolution works from compiled output.
 */

import { cpSync, chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcConfig = resolve(__dirname, '..', 'src', 'config');
const distConfig = resolve(__dirname, '..', 'dist', 'config');

// Ensure dist/config/ and dist/config/generated/ exist
mkdirSync(resolve(distConfig, 'generated'), { recursive: true });

// Copy static config assets
for (const file of [
  'constitution.md',
  'constitution-readonly.md',
  'constitution-user-base.md',
  'mcp-servers.json',
  'tool-description-hints.json',
]) {
  const src = resolve(srcConfig, file);
  if (existsSync(src)) {
    cpSync(src, resolve(distConfig, file));
  }
}

// Copy generated artifacts (if they exist)
const generatedDir = resolve(srcConfig, 'generated');
if (existsSync(generatedDir)) {
  for (const file of ['compiled-policy.json', 'test-scenarios.json', 'tool-annotations.json']) {
    const src = resolve(generatedDir, file);
    if (existsSync(src)) {
      cpSync(src, resolve(distConfig, 'generated', file));
    }
  }
}

// Copy read-only policy artifacts (if they exist)
const readOnlyDir = resolve(srcConfig, 'generated-readonly');
if (existsSync(readOnlyDir)) {
  mkdirSync(resolve(distConfig, 'generated-readonly'), { recursive: true });
  for (const file of ['compiled-policy.json']) {
    const src = resolve(readOnlyDir, file);
    if (existsSync(src)) {
      cpSync(src, resolve(distConfig, 'generated-readonly', file));
    }
  }
}

// Copy bundled workflow packages. Each workflow lives in its own
// directory under src/workflow/workflows/<name>/ with a workflow.yaml
// (or workflow.yml) manifest plus optional sibling resources like
// skills/. The whole package directory is copied recursively so any
// co-packaged files travel with the manifest.
const srcWorkflows = resolve(__dirname, '..', 'src', 'workflow', 'workflows');
const distWorkflows = resolve(__dirname, '..', 'dist', 'workflow', 'workflows');
if (existsSync(srcWorkflows)) {
  mkdirSync(distWorkflows, { recursive: true });
  for (const entry of readdirSync(srcWorkflows, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    cpSync(resolve(srcWorkflows, entry.name), resolve(distWorkflows, entry.name), { recursive: true });
  }
}

// Ensure the CLI entry point is executable after TypeScript compilation
const cliBin = resolve(__dirname, '..', 'dist', 'cli.js');
if (existsSync(cliBin)) {
  chmodSync(cliBin, 0o755);
}

console.log('Assets copied to dist/config/');
