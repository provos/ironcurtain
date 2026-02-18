# IronCurtain Clean Implementer Memory

## Project Architecture
- **Pipeline types**: `src/pipeline/types.ts` -- shared types for all pipeline modules
- **PolicyEngine**: `src/trusted-process/policy-engine.ts` -- two-phase: structural invariants + compiled rules
- **Constructor**: `new PolicyEngine(compiledPolicy, toolAnnotations, protectedPaths)`
- **Generated artifacts**: `src/config/generated/{compiled-policy,tool-annotations}.json`
- **Config**: `src/config/types.ts` has `IronCurtainConfig` with `protectedPaths`, `generatedDir`, `constitutionPath`

## ToolAnnotation shape (post-refactor)
- Fields: `toolName`, `serverName`, `comment` (string), `sideEffects` (boolean), `args` (Record<string, ArgumentRole[]>)
- No `effect` field -- argument roles are the single source of truth

## CompiledRuleCondition shape (post-refactor)
- `roles?: ArgumentRole[]` -- match tools with any argument having these roles (blanket rules)
- `paths?: PathCondition` -- extract paths from args with matching roles, check within directory
- `roles` and `paths` serve different purposes; should not both appear in same rule
- No `effect` field

## AI SDK v6 Mock Pattern (MockLanguageModelV3)
When mocking `generateText` with `Output.object` using `MockLanguageModelV3` from `ai/test`:
```typescript
new MockLanguageModelV3({
  doGenerate: async () => ({
    content: [{ type: 'text', text: JSON.stringify(responseData) }],
    finishReason: { unified: 'stop', raw: 'stop' },  // V3 format
    usage: {
      inputTokens: { total: 100, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 50, text: undefined, reasoning: undefined },
    },
    warnings: [],  // REQUIRED
    request: {},
    response: { id: 'test-id', modelId: 'test-model', timestamp: new Date() },
  }),
});
```
CRITICAL: `finishReason` must use `{ unified, raw }` (V3). Old `{ type, reason }` causes "No output generated" error.
CRITICAL: `response` not `responseData`. Field name changed in V3.

## Integration Test Pattern
Integration tests use dynamic sandbox dirs (`/tmp/ironcurtain-test-<pid>`). The compiled-policy.json has `/tmp/ironcurtain-sandbox`. Must load, rewrite `within` paths, and write to a temp dir for the test.

## Protected Paths vs Patterns
Engine uses concrete filesystem paths with `path.resolve()` and directory containment. Test paths must use actual project paths like `resolve(projectRoot, 'src/config/constitution.md')`.

## Key File Inventory (post-pipeline)
- `src/pipeline/types.ts` -- all shared types
- `src/pipeline/tool-annotator.ts` -- LLM tool classification
- `src/pipeline/constitution-compiler.ts` -- LLM rule compilation
- `src/pipeline/scenario-generator.ts` -- LLM test generation
- `src/pipeline/policy-verifier.ts` -- multi-round real engine + LLM judge
- `src/pipeline/handwritten-scenarios.ts` -- 15 mandatory test scenarios
- `src/pipeline/compile.ts` -- CLI entry point (`npm run compile-policy`)
- `src/config/index.ts` -- `loadConfig()` and `loadGeneratedPolicy()`

## validateCompiledRules Signature
`validateCompiledRules(rules: CompiledRule[])` -- no longer takes annotations parameter.

## Zod v4 Strict Mode
Zod v4 (^4.3.6) strict by default. Mock response JSON must exactly match Zod schema -- no extra properties.

## Move Operations Policy
All moves denied via `deny-delete-operations` rule (move_file source has `delete-path` role). No move-specific rules.

## LLM Interaction Logging
- `src/pipeline/llm-logger.ts` -- AI SDK middleware that captures all LLM prompts and responses
- Uses `wrapLanguageModel()` with `LanguageModelMiddleware.wrapGenerate` to intercept calls
- Writes JSONL to `src/config/generated/llm-interactions.jsonl` (covered by `*.jsonl` in .gitignore)
- Caller sets `LlmLogContext.stepName` before each pipeline phase (mutable context pattern)
- Each entry: timestamp, stepName, modelId, prompt, responseText, usage, durationMs
- Middleware `specificationVersion: 'v3'` required for AI SDK v6
