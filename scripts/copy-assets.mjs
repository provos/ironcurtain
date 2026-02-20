/**
 * Post-build script: copies non-TS config assets into dist/config/
 * so that __dirname-relative path resolution works from compiled output.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcConfig = resolve(__dirname, '..', 'src', 'config');
const distConfig = resolve(__dirname, '..', 'dist', 'config');

// Ensure dist/config/ and dist/config/generated/ exist
mkdirSync(resolve(distConfig, 'generated'), { recursive: true });

// Copy static config assets
for (const file of ['constitution.md', 'mcp-servers.json']) {
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

console.log('Assets copied to dist/config/');
