# Design: Multi-Provider Model Support

**Status:** Proposed
**Date:** 2026-02-19
**Author:** IronCurtain Engineering

## 1. Problem Statement

IronCurtain hardcodes Anthropic as the sole LLM provider. The two model instantiation sites both import from `@ai-sdk/anthropic`:

1. **`src/session/agent-session.ts:260`** -- `anthropic(this.config.agentModelId)` (uses the default provider instance)
2. **`src/pipeline/compile.ts:588-589`** -- `createAnthropic()(userConfig.policyModelId)` (creates a provider explicitly)

The rest of the codebase is already provider-agnostic -- `generateText()`, `Output.object()`, and all pipeline functions accept the AI SDK's `LanguageModel` interface. The provider coupling is limited to these two lines.

Users should be able to use Google Gemini, OpenAI, or other AI SDK-compatible providers without editing source code.

## 2. Config Schema

### Option A: Colon-Prefixed Model ID (Recommended)

Encode the provider in the model ID string using a `provider:model` format:

```jsonc
// ~/.ironcurtain/config.json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "anthropic:claude-sonnet-4-6",
  "escalationTimeoutSeconds": 300
}
```

Examples:
- `"anthropic:claude-sonnet-4-6"` -- Anthropic Claude
- `"google:gemini-2.0-flash"` -- Google Gemini
- `"openai:gpt-4o"` -- OpenAI GPT-4o

### Option B: Separate Provider Field

```jsonc
{
  "agentModelProvider": "anthropic",
  "agentModelId": "claude-sonnet-4-6",
  "policyModelProvider": "anthropic",
  "policyModelId": "claude-sonnet-4-6"
}
```

### Decision: Option A

Rationale:

1. **Matches the AI SDK's own `createProviderRegistry` convention**, which uses `provider:model` as its native ID format. This is the established pattern in the ecosystem.
2. **Fewer config fields.** Two fields instead of four. Less duplication, less room for mismatch (e.g., setting `agentModelProvider: "google"` with `agentModelId: "claude-sonnet-4-6"`).
3. **Single string is easier to override.** An env var like `IRONCURTAIN_AGENT_MODEL=google:gemini-2.0-flash` is cleaner than needing two env vars.
4. **Backward compatible.** A bare model ID without a colon prefix (e.g., `"claude-sonnet-4-6"`) defaults to Anthropic. Existing configs keep working.

## 3. API Key Handling

Each provider has its own API key convention. The AI SDK providers already look for standard environment variables:

| Provider | Env Var (AI SDK default) | Config file field |
|----------|------------------------|-------------------|
| Anthropic | `ANTHROPIC_API_KEY` | `apiKey` (existing, remains the default) |
| Google | `GOOGLE_GENERATIVE_AI_API_KEY` | `googleApiKey` |
| OpenAI | `OPENAI_API_KEY` | `openaiApiKey` |

The config file gains optional per-provider API key fields. The resolution order for each provider's key is:

```
Provider's standard env var  >  config.json field  >  error (if provider is used)
```

This matches how the AI SDK providers work internally -- `createAnthropic()` reads `ANTHROPIC_API_KEY`, `createGoogleGenerativeAI()` reads `GOOGLE_GENERATIVE_AI_API_KEY`, etc. The config file fields are a convenience for users who prefer not to use env vars.

### Updated Config Schema

```jsonc
// ~/.ironcurtain/config.json
{
  "agentModelId": "anthropic:claude-sonnet-4-6",
  "policyModelId": "anthropic:claude-sonnet-4-6",

  // API keys -- optional, env vars take precedence
  "apiKey": "<anthropic-key>",       // existing field, now explicitly Anthropic
  "googleApiKey": "<google-key>",    // optional
  "openaiApiKey": "<openai-key>",    // optional

  "escalationTimeoutSeconds": 300
}
```

Only the API key for the provider(s) actually referenced by `agentModelId` or `policyModelId` needs to be present. If a user only uses Anthropic, they never need to set `googleApiKey`.

## 4. Model Resolution

### New file: `src/config/model-provider.ts`

A single function that parses a `provider:model` string and returns a `LanguageModel`. This is the only file that imports provider packages.

```typescript
// src/config/model-provider.ts

import type { LanguageModel } from 'ai';
import type { ResolvedUserConfig } from './user-config.js';

/**
 * Supported LLM provider identifiers.
 * Adding a new provider requires:
 * 1. Adding the identifier here
 * 2. Adding a case to createLanguageModel()
 * 3. Adding a key field to UserConfig (if not using env vars)
 * 4. Installing the @ai-sdk/<provider> package
 */
type ProviderId = 'anthropic' | 'google' | 'openai';

/** Default provider when no prefix is specified. */
const DEFAULT_PROVIDER: ProviderId = 'anthropic';

/** Known provider identifiers for validation. */
const KNOWN_PROVIDERS = new Set<string>(['anthropic', 'google', 'openai']);

/**
 * Parsed model specifier. A "qualified model ID" has the form
 * "provider:model-name". A bare model ID defaults to Anthropic.
 */
interface ParsedModelId {
  readonly provider: ProviderId;
  readonly modelId: string;
}

/**
 * Parses a qualified model ID string into provider and model components.
 *
 * Format: "provider:model-id" or just "model-id" (defaults to anthropic).
 *
 * @throws Error if the provider prefix is not recognized or model ID is empty
 */
export function parseModelId(qualifiedId: string): ParsedModelId {
  const colonIndex = qualifiedId.indexOf(':');

  if (colonIndex === -1) {
    // No prefix -- default to Anthropic for backward compatibility
    return { provider: DEFAULT_PROVIDER, modelId: qualifiedId };
  }

  const prefix = qualifiedId.substring(0, colonIndex);
  const modelId = qualifiedId.substring(colonIndex + 1);

  if (!KNOWN_PROVIDERS.has(prefix)) {
    const known = [...KNOWN_PROVIDERS].sort().join(', ');
    throw new Error(
      `Unknown model provider "${prefix}" in "${qualifiedId}". ` +
      `Supported providers: ${known}`
    );
  }

  if (!modelId) {
    throw new Error(
      `Empty model ID in "${qualifiedId}". ` +
      `Expected format: "provider:model-id"`
    );
  }

  return { provider: prefix as ProviderId, modelId };
}

/**
 * Creates a LanguageModel from a qualified model ID and user config.
 *
 * Provider packages are dynamically imported so that only the packages
 * for providers actually in use need to be installed.
 *
 * @param qualifiedId - Model specifier like "anthropic:claude-sonnet-4-6"
 * @param config - Resolved user config for API key lookup
 * @returns A LanguageModel instance ready for use with generateText()
 *
 * @throws Error if provider is unknown or required API key is missing
 */
export async function createLanguageModel(
  qualifiedId: string,
  config: ResolvedUserConfig,
): Promise<LanguageModel> {
  const { provider, modelId } = parseModelId(qualifiedId);

  switch (provider) {
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      const apiKey = config.apiKey || undefined;
      return createAnthropic({ apiKey })(modelId);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      const apiKey = config.googleApiKey || undefined;
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      const apiKey = config.openaiApiKey || undefined;
      return createOpenAI({ apiKey })(modelId);
    }
  }
}
```

### Why Dynamic Imports

Provider packages are imported with `await import(...)` so that:

1. **Only the required provider package needs to be installed.** A user who only uses Anthropic does not need `@ai-sdk/google` in their `node_modules`. If the import fails, Node gives a clear "Cannot find package" error.
2. **No import-time side effects from unused providers.** Each provider SDK may do network checks, load native modules, etc.
3. **The switch is exhaustive.** TypeScript's control flow analysis ensures every `ProviderId` case is handled. Adding a new provider to the union without adding a case is a compile error.

### Why Not `createProviderRegistry`

The AI SDK's `createProviderRegistry()` provides a `registry.languageModel('anthropic:claude-sonnet-4-6')` API that is conceptually similar. We do not use it because:

1. **It requires all provider instances up front.** You must pass `{ anthropic: createAnthropic(), google: createGoogleGenerativeAI() }` at construction time, meaning all provider packages must be installed and all API keys resolved eagerly.
2. **It does not support per-provider API key configuration.** The registry creates provider instances; it does not know about our config file's key resolution.
3. **It adds a layer of indirection for no benefit.** Our `createLanguageModel()` function is ~30 lines and does exactly what we need. The registry is designed for applications with many models and dynamic dispatch -- overkill here.

## 5. Changes Required

### `src/config/user-config.ts`

Add optional API key fields for additional providers. Update the Zod schema and `ResolvedUserConfig`:

```typescript
const userConfigSchema = z.object({
  agentModelId: z.string().min(1).optional(),
  policyModelId: z.string().min(1).optional(),
  apiKey: z.string().min(1).optional(),          // Anthropic (existing)
  googleApiKey: z.string().min(1).optional(),     // NEW
  openaiApiKey: z.string().min(1).optional(),     // NEW
  escalationTimeoutSeconds: z.number().int().min(30).max(600).optional(),
});

export interface ResolvedUserConfig {
  readonly agentModelId: string;
  readonly policyModelId: string;
  readonly apiKey: string;          // Anthropic
  readonly googleApiKey: string;    // NEW (empty string if not set)
  readonly openaiApiKey: string;    // NEW (empty string if not set)
  readonly escalationTimeoutSeconds: number;
}
```

Update `applyEnvOverrides()` to respect additional provider env vars:

```typescript
function applyEnvOverrides(config: ResolvedUserConfig): ResolvedUserConfig {
  return {
    ...config,
    apiKey: process.env.ANTHROPIC_API_KEY || config.apiKey,
    googleApiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || config.googleApiKey,
    openaiApiKey: process.env.OPENAI_API_KEY || config.openaiApiKey,
  };
}
```

Update `USER_CONFIG_DEFAULTS`:

```typescript
export const USER_CONFIG_DEFAULTS = {
  agentModelId: 'anthropic:claude-sonnet-4-6',   // CHANGED: added prefix
  policyModelId: 'anthropic:claude-sonnet-4-6',  // CHANGED: added prefix
  escalationTimeoutSeconds: 300,
} as const;
```

### `src/config/types.ts`

No changes needed. `IronCurtainConfig.agentModelId` remains a `string`. The `anthropic:` prefix is just part of the string value now.

Remove `anthropicApiKey` from `IronCurtainConfig` -- it is no longer used directly. The agent session receives the full `ResolvedUserConfig` through a new config field instead (or the `LanguageModel` is constructed before being passed in).

### `src/session/agent-session.ts`

Replace the synchronous `anthropic()` call with the new async resolver. Since `buildModel()` is called from `initialize()` (which is already async), this is straightforward:

```typescript
// Before:
import { anthropic } from '@ai-sdk/anthropic';
// ...
private buildModel(): LanguageModel {
  const baseModel = anthropic(this.config.agentModelId);
  // ...
}

// After:
import { createLanguageModel } from '../config/model-provider.js';
// ...
private async buildModel(): Promise<LanguageModel> {
  const baseModel = await createLanguageModel(
    this.config.agentModelId,
    this.config.userConfig,
  );
  // ...
}
```

The `IronCurtainConfig` needs to carry the `ResolvedUserConfig` so the model resolver has access to API keys:

```typescript
// src/config/types.ts
export interface IronCurtainConfig {
  // ... existing fields ...
  /** Resolved user configuration. Provides API keys for model resolution. */
  userConfig: ResolvedUserConfig;
}
```

### `src/pipeline/compile.ts`

```typescript
// Before:
import { createAnthropic } from '@ai-sdk/anthropic';
// ...
const anthropic = createAnthropic();
const baseLlm = anthropic(userConfig.policyModelId);

// After:
import { createLanguageModel } from '../config/model-provider.js';
// ...
const baseLlm = await createLanguageModel(
  userConfig.policyModelId,
  userConfig,
);
```

### `package.json`

`@ai-sdk/anthropic` moves from `dependencies` to `dependencies` (stays). `@ai-sdk/google` and `@ai-sdk/openai` become optional peer dependencies documented in README, or added to `dependencies` for out-of-the-box support:

```json
{
  "dependencies": {
    "@ai-sdk/anthropic": "^3.0.44",
    "@ai-sdk/google": "^3.0.30",
    "@ai-sdk/openai": "^3.0.30"
  }
}
```

For a PoC, shipping all three as regular dependencies is pragmatic. They are small packages (~50KB each). If package size becomes a concern later, they can be moved to `optionalDependencies` or `peerDependencies`.

### Removal of `anthropicApiKey` from `IronCurtainConfig`

Currently `IronCurtainConfig.anthropicApiKey` is set from the user config and checked in `loadConfig()`:

```typescript
if (!userConfig.apiKey) {
  throw new Error('ANTHROPIC_API_KEY environment variable is required ...');
}
```

This check must become provider-aware. Instead of failing eagerly at config load time, validation moves to model creation time. `createLanguageModel()` does not validate the key itself -- the AI SDK provider will throw a clear error on the first API call if the key is missing or invalid. This is the standard AI SDK behavior and gives a better error message than we could produce (e.g., it includes the HTTP status and error body).

The `loadConfig()` function drops the API key requirement check. The `anthropicApiKey` field is removed from `IronCurtainConfig` since it is no longer the only provider and the config already carries `userConfig` with all API keys.

## 6. Backward Compatibility

| Scenario | Before | After |
|----------|--------|-------|
| Bare model ID in config | `"claude-sonnet-4-6"` works | Still works (defaults to `anthropic:`) |
| `ANTHROPIC_API_KEY` env var | Required | Still works, still overrides config |
| No config file | Auto-created with defaults | Auto-created with `anthropic:` prefix in defaults |
| Existing config file | `agentModelId: "claude-sonnet-4-6"` | Continues to work (bare ID = Anthropic) |

The bare-ID fallback ensures zero breakage for existing users. The `anthropic:` prefix is optional for Anthropic models but recommended in documentation and auto-generated config files.

## 7. Validation

Update the Zod schema for `agentModelId` and `policyModelId` to validate the `provider:model` format:

```typescript
const qualifiedModelId = z.string().min(1).refine(
  (val) => {
    const colonIndex = val.indexOf(':');
    if (colonIndex === -1) return true; // bare ID is valid
    const prefix = val.substring(0, colonIndex);
    return ['anthropic', 'google', 'openai'].includes(prefix);
  },
  {
    message: 'Model ID must be "model-name" or "provider:model-name" ' +
             'where provider is one of: anthropic, google, openai',
  },
);
```

This catches typos like `"anthropi:claude-sonnet-4-6"` at config load time rather than at first LLM call.

## 8. File Structure

```
src/config/
  model-provider.ts         # NEW -- parseModelId(), createLanguageModel()
  user-config.ts            # MODIFIED -- add googleApiKey, openaiApiKey, update defaults
  types.ts                  # MODIFIED -- add userConfig field, remove anthropicApiKey
  index.ts                  # MODIFIED -- drop API key requirement, add userConfig to config

src/session/
  agent-session.ts          # MODIFIED -- use createLanguageModel(), remove @ai-sdk/anthropic import

src/pipeline/
  compile.ts                # MODIFIED -- use createLanguageModel(), remove @ai-sdk/anthropic import
```

## 9. Testing Strategy

### `model-provider.ts` tests

- `parseModelId('anthropic:claude-sonnet-4-6')` returns `{ provider: 'anthropic', modelId: 'claude-sonnet-4-6' }`
- `parseModelId('claude-sonnet-4-6')` returns `{ provider: 'anthropic', modelId: 'claude-sonnet-4-6' }` (backward compat)
- `parseModelId('google:gemini-2.0-flash')` returns `{ provider: 'google', modelId: 'gemini-2.0-flash' }`
- `parseModelId('unknown:model')` throws with descriptive error listing known providers
- `parseModelId('anthropic:')` throws (empty model ID)
- `createLanguageModel()` returns a `LanguageModel` for each supported provider (mock the provider imports in tests)

### `user-config.ts` tests

- New API key fields default to empty string
- Env var overrides work for all three providers
- Qualified model IDs with invalid prefixes are rejected at validation
- Bare model IDs pass validation

### Integration consideration

Full integration tests (actually calling LLMs) are out of scope. The dynamic import pattern means that if a provider package is not installed, the error is a clear "Cannot find package '@ai-sdk/google'" at the import site, not a cryptic failure elsewhere.

## 10. Future Extensions

### Adding a new provider

1. Add the identifier to the `ProviderId` union type -- TypeScript will flag the incomplete switch
2. Add a case to `createLanguageModel()` with the dynamic import
3. Optionally add a config key field (e.g., `mistralApiKey`)
4. Install the `@ai-sdk/<provider>` package

This is ~10 lines of code per new provider.

### Custom base URLs

Some providers support `baseURL` for proxies or self-hosted endpoints. This could be added later as:

```jsonc
{
  "providers": {
    "openai": {
      "baseURL": "https://my-proxy.example.com/v1"
    }
  }
}
```

Not needed now, but the `createLanguageModel()` function is the natural place to thread these settings through. Keeping provider configuration in one function makes this extension straightforward.

### Provider-specific options

Each AI SDK provider supports unique options (e.g., Anthropic's `sendReasoning`, OpenAI's `organization`). These can be added to the config file under a `providers` key when needed, without changing the `provider:model` ID format.
