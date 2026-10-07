# Named Z.AI profiles and host model roles

This change adds Z.AI to the existing named-provider registry and adds independent named-profile routing for host models in the same PR. Native and OpenRouter routes keep their existing behavior. Workflow benchmark changes are outside this PR.

## Provider contract

`type: "zai"` defines `plan` (`api` by default, or `coding`), `model` (`glm-5.3` by default), an optional key, ordered model map, and per-agent overrides. `ZAI_API_KEY` overrides Z.AI profiles at load time and is stripped at the config write boundary while preserving any file-origin key, including renames. Profile selection is per session; adapters never capture the active profile in the cached registry.

| Harness | Protocol | Client base | Configuration |
|---|---|---|---|
| Claude Code | Anthropic Messages | `https://api.z.ai/api/anthropic` | Bearer sentinel; tier aliases and effective selected model; nonessential traffic/betas disabled |
| Codex | Responses | `https://api.z.ai/api/v1` | Custom provider TOML using `env_key`, mounted model catalog, HTTP transport |
| Goose | Chat Completions | `https://api.z.ai` | `OPENAI_BASE_PATH` is `api/paas/v4/chat/completions` or `api/coding/paas/v4/chat/completions` |

Model resolution is `perAgent override → first map match → requested model` (or the profile default when none is requested). The default map sends `*opus*` to the profile model (`glm-5.3` by default) and `*sonnet*` / `*haiku*` to `glm-5.3-flash`. OpenRouter's default map uses the same split with `z-ai/`-prefixed IDs. Explicit maps, including empty maps, and per-agent overrides are preserved. Mapping happens once at client selection. The proxy filters unsupported tools/beta fields without remapping an already selected main model. Pinned Goose 1.26.1 selects `gpt-4o-mini` internally for titles and compaction; the proxy resolves that internal fast request as `perAgent.goose → first map match → profile default`, avoiding unrelated OpenAI-model requests to Z.AI. Batch command overrides and PTY startup selections use the same resolver. Host roles omit the Docker per-agent override.

Z.AI uses an explicit provider host and narrow protocol endpoint allowlists. Container keys are sentinels; only exact sentinel matches select the host credential. Existing agent-owned credential passthrough is preserved. Native shared-root SDK normalization derives `/v1` for Anthropic SDK calls while preserving explicit SDK `/v1` bases and Docker roots. The earlier duplicate managed-header sentinel fix is retained; the custom-model-option prototype is replaced by this provider architecture.

## Host roles

`hostModelProfiles` optionally binds `agent`, `policy`, `prefilter`, `summary`, and `autoApprove` to registry names. Unbound roles retain native resolution independently of `modelProviders.default`. Existing role model fields remain authoritative inputs to mapping. Both native and gateway-only credential preflights resolve by role.

Z.AI and OpenRouter host models use the installed OpenAI SDK's explicit Chat Completions client. OpenRouter host requests preserve provider preferences, including strict pins and disabled fallback, and use the same default soft Z.AI pin as container requests. Z.AI structured output uses the documented JSON mode: the schema is included in the prompt and AI SDK validation remains in place. An invalid auto-approver response escalates to a human. A binding alone does not enable auto-approval; its default remains disabled.

Unknown profile references fail config validation. A host-bound profile cannot be deleted until reassigned. The web rename operation includes explicit original identity, migrating keys, bindings, and the default in one save. The backend rejects type-changing renames and old-service masks. The editor keeps an existing profile's service fixed.

## Verification

Hermetic checks cover profile defaults, environment precedence/persistence, explicit empty maps, ordered mappings applied once, three-harness configuration/authentication, effective batch overrides, parsed Codex TOML/catalog, protocol classification, all five host roles, JSON-mode auto-approver success and invalid-output escalation, builtin credential preflight, API/UI key round trips, and atomic renames under environment overrides.

The real TLS proxy tests use loopback upstreams to exercise streaming tool-call/result forwarding for all three protocols, endpoint filtering, credential swapping, and agent-owned credential preservation. They spend no provider tokens. The opt-in `ZAI_CLAUDE_OFFLINE_TEST=1` integration test runs the installed Claude Code image through a local fake upstream, with dummy credentials. Linux uses a mounted socket and `--network none`; Docker Desktop uses the host TCP proxy on its bridge network. Claude Code 2.1.292 completes successfully without the custom-model-option variable. It can still warn about an unknown model's context metadata and conservatively assume 200k context; this change does not assign Claude capabilities to GLM models.

With user authorization, bounded hello-world tests also ran against the actual Z.AI endpoints using the existing host key and ephemeral Coding Plan profiles. All three returned `HELLO_FROM_ZAI`:

| Harness version | Requested / forwarded | Served model observed | Result |
|---|---|---|---|
| Claude Code 2.1.292 | `glm-5.3` / `glm-5.3` | `glm-5.3`, HTTP 200 | Passed |
| Codex 0.160.1 | `glm-5.3` / `glm-5.3` | Unverified: capture ended with one aborted exchange and no final record | Passed completion |
| Goose 1.26.1 | `glm-5.3` / `glm-5.3`; auxiliary `gpt-4o-mini` / `glm-5.3` | `glm-5.3`, HTTP 200 for both requests | Passed |

These live checks explicitly selected `glm-5.3`. They do not qualify the later default Sonnet/Haiku routing to `glm-5.3-flash`; the tier split is covered by configuration, adapter, host-SDK, and OpenRouter wire tests.

The generated Codex catalog conservatively advertises Flash as text-only with a 200k context window. These settings have not been qualified against the account's Responses endpoint; larger contexts and multimodal Flash behavior remain unverified.

Initial attempts encountered Docker `ENOSPC` before provider exchanges. Retried tests used temporary memory-backed home/workspace directories without removing existing Docker resources. An initial isolated Codex setup removed its provider table while disabling MCP; the corrected test retained the generated table and disabled MCP through a CLI override. Real keys remained in host proxy memory, and no production configuration changed.

These results qualify short completions for this key, model, plan, and client builds. Standard API-plan access, full agent/tool loops, host-role live calls, cache/context behavior, and benchmark completion remain unverified. The Codex capture gap is preserved as an aborted exchange rather than a fabricated served-model result.

## Primary protocol references

- [Z.AI Claude Code integration](https://docs.z.ai/devpack/tool/claude)
- [Z.AI Codex integration and model catalog](https://docs.z.ai/devpack/tool/codex)
- [Z.AI supported protocol endpoints](https://docs.z.ai/devpack/tool/others)
- [Z.AI JSON mode](https://docs.z.ai/guides/capabilities/struct-output)
- [Codex custom-provider configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Goose provider configuration](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md)
- [Pinned Goose OpenAI provider](https://github.com/aaif-goose/goose/blob/v1.26.1/crates/goose/src/providers/openai.rs)
