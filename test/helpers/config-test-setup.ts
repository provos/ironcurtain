/**
 * Shared test helpers for config-related tests (first-start, config-command).
 *
 * Provides environment isolation, config file read/write, and clack mock factory.
 * vi.mock() must remain in each test file due to vitest hoisting constraints.
 */

import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';

export const ENV_VARS_TO_ISOLATE = [
  'IRONCURTAIN_HOME',
  'ANTHROPIC_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'OPENAI_API_KEY',
] as const;

export interface ConfigTestEnv {
  testHome: string;
  savedEnv: Record<string, string | undefined>;
}

/** Creates a temp directory, saves and clears env vars, sets IRONCURTAIN_HOME. */
export function setupConfigEnv(prefix: string): ConfigTestEnv {
  const testHome = mkdtempSync(resolve(tmpdir(), `ironcurtain-${prefix}-`));
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of ENV_VARS_TO_ISOLATE) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.IRONCURTAIN_HOME = testHome;
  return { testHome, savedEnv };
}

/** Restores env vars and removes the temp directory. */
export function teardownConfigEnv(env: ConfigTestEnv): void {
  for (const key of ENV_VARS_TO_ISOLATE) {
    if (env.savedEnv[key] !== undefined) {
      process.env[key] = env.savedEnv[key];
    } else {
      delete process.env[key];
    }
  }
  rmSync(env.testHome, { recursive: true, force: true });
}

/** Writes a config.json to the test home directory. */
export function seedConfig(testHome: string, config: Record<string, unknown>): void {
  mkdirSync(testHome, { recursive: true });
  writeFileSync(resolve(testHome, 'config.json'), JSON.stringify(config, null, 2));
}

/** Typed shape for config assertions — avoids verbose `as Record<string, unknown>` casts. */
export interface ConfigOnDisk {
  agentModelId?: string;
  policyModelId?: string;
  escalationTimeoutSeconds?: number;
  autoApprove?: { enabled?: boolean; modelId?: string };
  webSearch?: {
    provider?: string;
    brave?: { apiKey?: string };
    tavily?: { apiKey?: string };
    serpapi?: { apiKey?: string };
  };
  resourceBudget?: Record<string, unknown>;
  autoCompact?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Reads and parses config.json from the test home directory. */
export function readConfig(testHome: string): ConfigOnDisk {
  const configPath = resolve(testHome, 'config.json');
  expect(existsSync(configPath)).toBe(true);
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

/** Returns true if config.json exists in the test home directory. */
export function configExists(testHome: string): boolean {
  return existsSync(resolve(testHome, 'config.json'));
}
