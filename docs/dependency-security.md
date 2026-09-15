# Dependency security maintenance

## September 2026 release preparation

Dependency updates were installed using `aikido-npm` (Safe Chain 1.5.15), after
`aikido-npm safe-chain-verify` succeeded. Malware checks and the minimum-package-age
policy remained enabled. No forced audit fix, advisory suppression, lifecycle-script
approval, or Safe Chain exception was added.

The compatible lockfile updates include fast-uri 3.1.7, Hono 4.13.7, js-yaml 4.3.2,
qs 6.16.0, smol-toml 1.8.0, and the Browserslist dependency family. Vitest and its
coverage package use 4.1.11, including the workspace test runners.

Two scoped overrides are needed because the current parent releases do not admit
the patched dependencies within their declared ranges:

| Dependency path                       | Selected version | Reason                                                                                        |
| ------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| `@huggingface/transformers` → `sharp` | 0.35.4           | Updated native image libraries; fixes GHSA-f88m-g3jw-g9cj and GHSA-rgj7-g3m4-5g8c.            |
| `onnxruntime-node` → `adm-zip`        | 0.6.1            | Bounded decompression and safe extraction; fixes GHSA-xcpc-8h2w-3j85 and GHSA-vwc7-r8mq-g2x9. |

These are dependency-resolution overrides, not security-scanner bypasses. Keep the
ONNX runtime version expected by Transformers rather than changing the inference
engine to obtain an incidental ZIP-library update. The ZIP API used by the ONNX
installer (`getEntry` / `extractEntryTo`) and native sharp encode/decode were checked
against the replacements. Memory-server tests exercise the real text models.

Remove each override when its parent declares a compatible patched dependency,
then regenerate and audit the lockfile through Safe Chain.

## Public-install boundary

A clean checkout audit does **not** establish a clean public npm installation.
The repository's `package-lock.json` is not published, and npm only applies
`overrides` from the consuming project's root manifest, not from its installed
dependencies. In particular, publishing IronCurtain or the memory-server package
does not by itself carry these two overrides into downstream installations.

Before releasing, either adopt parent releases that accept the patched versions,
or explicitly choose and validate a publishable dependency-pinning strategy such
as an npm shrinkwrap. A monorepo lockfile containing workspace links must not simply
be renamed and shipped: validate the packed artifact in a fresh consumer project,
including the separately published memory server and platform-specific native
dependencies. That packaging change is not included in this dependency update.

References: [npm overrides](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#overrides),
[npm shrinkwrap](https://docs.npmjs.com/cli/v11/configuring-npm/npm-shrinkwrap-json/),
[Safe Chain](https://github.com/AikidoSec/safe-chain).
