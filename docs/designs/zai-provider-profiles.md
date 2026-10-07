# Named Z.AI profiles and host model roles

This change adds Z.AI to the existing named-provider registry and adds independent named-profile routing for host models in the same PR. Native and OpenRouter routes keep their existing behavior. Workflow benchmark changes are outside this PR.

## Provider contract

`type: "zai"` defines `plan` (`api` by default, or `coding`), `model` (`glm-5.3` by default), an optional key, ordered model map, and per-agent overrides. `ZAI_API_KEY` overrides Z.AI profiles at load time and is stripped at the config write boundary while preserving any file-origin key, including renames. Profile selection is per session; adapters never capture the active profile in the cached registry.

| Harness | Protocol | Client base | Configuration |
|---|---|---|---|
| Claude Code | Anthropic Messages | `https://api.z.ai/api/anthropic` | Bearer sentinel; tier aliases and effective selected model; nonessential traffic/betas disabled |
| Codex | Responses | `https://api.z.ai/api/v1` | Custom provider TOML using `env_key`, mounted model catalog, HTTP transport |
| Goose | Chat Completions | `https://api.z.ai` | `OPENAI_BASE_PATH` is `api/paas/v4/chat/completions` or `api/coding/paas/v4/chat/completions` |

Model resolution is `perAgent override → first map match → requested model` (or the profile default when none is requested). Default map rules map Claude tier names to the profile model; explicit empty maps are preserved. Mapping happens once at client selection. The proxy filters unsupported tools/beta fields without remapping an already selected model. Batch command overrides and PTY startup selections use the same resolver. Host roles omit the Docker per-agent override.

Z.AI uses an explicit provider host and narrow protocol endpoint allowlists. Container keys are sentinels; only exact sentinel matches select the host credential. Existing agent-owned credential passthrough is preserved. Native shared-root SDK normalization derives `/v1` for Anthropic SDK calls while preserving explicit SDK `/v1` bases and Docker roots. The earlier duplicate managed-header sentinel fix is retained; the custom-model-option prototype is replaced by this provider architecture.

## Host roles

`hostModelProfiles` optionally binds `agent`, `policy`, `prefilter`, `summary`, and `autoApprove` to registry names. Unbound roles retain native resolution independently of `modelProviders.default`. Existing role model fields remain authoritative inputs to mapping. Both native and gateway-only credential preflights resolve by role.

Z.AI and OpenRouter host models use the installed OpenAI SDK's explicit Chat Completions client. Z.AI structured output uses the documented JSON mode: the schema is included in the prompt and AI SDK validation remains in place. An invalid auto-approver response escalates to a human. A binding alone does not enable auto-approval; its default remains disabled.

Unknown profile references fail config validation. A host-bound profile cannot be deleted until reassigned. The web rename operation includes explicit original identity, migrating keys, bindings, and the default in one save. The backend rejects type-changing renames and old-service masks. The editor keeps an existing profile's service fixed.

## Verification

Hermetic checks cover profile defaults, environment precedence/persistence, explicit empty maps, ordered mappings applied once, three-harness configuration/authentication, effective batch overrides, parsed Codex TOML/catalog, protocol classification, all five host roles, JSON-mode auto-approver success and invalid-output escalation, builtin credential preflight, API/UI key round trips, and atomic renames under environment overrides.

The real TLS proxy tests use loopback upstreams to exercise streaming tool-call/result forwarding for all three protocols, endpoint filtering, credential swapping, and agent-owned credential preservation. They spend no provider tokens. The opt-in `ZAI_CLAUDE_OFFLINE_TEST=1` integration test runs the installed Claude Code image through a local fake upstream, with dummy credentials. Linux uses a mounted socket and `--network none`; Docker Desktop uses the host TCP proxy on its bridge network. Claude Code 2.1.292 completes successfully without the custom-model-option variable. It can still warn about an unknown model's context metadata and conservatively assume 200k context; this change does not assign Claude capabilities to GLM models.

Published direct-integration documentation is distinct from qualification of a particular account and client build. Live Z.AI account access, full three-client agent/tool loops, cache behavior, and benchmark completion are not implied by hermetic checks. No production configuration is changed by this PR.

## Primary protocol references

- [Z.AI Claude Code integration](https://docs.z.ai/devpack/tool/claude)
- [Z.AI Codex integration and model catalog](https://docs.z.ai/devpack/tool/codex)
- [Z.AI supported protocol endpoints](https://docs.z.ai/devpack/tool/others)
- [Z.AI JSON mode](https://docs.z.ai/guides/capabilities/struct-output)
- [Codex custom-provider configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Goose provider configuration](https://github.com/aaif-goose/goose/blob/main/documentation/docs/getting-started/providers.md)
