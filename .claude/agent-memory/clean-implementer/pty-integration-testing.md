# Real-container PTY / web-UI integration testing

Learnings from `test/pty-web-escalation.integration.test.ts` (real `PtySessionManager`
+ real `createPtyBridge` + real Docker container, proving the web-UI PTY
escalation-forwarding path: registry discovery -> EscalationWatcher ->
`escalation.created` on WebEventBus). Grep to confirm symbols before acting.

## macOS 26+ auto-selects Apple `container`, NOT Docker (cost 2 iterations)
- `containerRuntime: 'auto'` (`src/docker/container-runtime.ts`) prefers apple-container
  when its probe passes (macOS 26+, Apple silicon, `/usr/local/bin/container`).
  Apple-container containers are named `ironcurtain-pty-<shortId>` too, but are
  INVISIBLE to `docker ps` — they live in the `container list` runtime.
- Symptom that fooled me: the child booted (Claude Code TUI rendered in the PTY
  output) and the PTY registration appeared, yet `docker ps` never showed the
  container. It was in the apple runtime.
- Fix for a Docker-based integration test: set `process.env.IRONCURTAIN_CONTAINER_RUNTIME
  = 'docker'` in beforeAll (capture+restore). Then macOS uses the tcp-sidecar
  topology (main `ironcurtain-pty-<shortId>` + `ironcurtain-sidecar-<shortId>`,
  both visible to `docker ps`; needs `alpine/socat` image). The image must exist
  in BOTH runtimes independently; `docker image inspect` only checks Docker's store.
- Cleanup must target the SAME runtime you booted in. `docker rm -f` will NOT
  remove an apple-container leak — use `container stop/rm/delete`. Leaked apple
  pty containers persist as `running` and are easy to miss.

## Spawning a real PTY child under vitest: override `createBridge`
- `PtySessionManager.create()` calls `resolveIroncurtainBin()` (`src/pty/resolve-ironcurtain-bin.ts`)
  which keys on `process.argv[1]`. Under vitest that's the vitest runner, not
  `src/cli.ts`, so the default would spawn vitest.
- Inject `createBridge: (opts) => createPtyBridge({ ...opts, ironcurtainBin:
  process.execPath, prefixArgs: ['--import', 'tsx', '<abs>/src/cli.ts'] })`. This
  is still the REAL bridge (real node-pty spawn + discovery + watcher); only the
  spawn target is fixed.
- MUST be single-process: `node --import tsx src/cli.ts` runs cli.ts in the node
  process node-pty spawned, so node-pty's `child.pid` == the child's `process.pid`
  == the `pid` field `writeRegistration()` stamps. Bridge discovery
  (`discoverSessionRegistration`) matches `reg.pid === child.pid`. A `.bin/tsx`
  CLI shim forks a child node → pid mismatch → discovery never resolves →
  watcher never starts. Verified `node --import tsx file.ts` is single-process.

## Child boots from disk (unlike pty-entrypoint's in-process runPtySession)
- The child (`ironcurtain start --pty` via `src/index.ts main()`) calls
  `loadConfig()`/`loadUserConfig()`, so `IRONCURTAIN_HOME` must contain a valid
  `config.json` (UserConfig JSON; all fields optional, defaults backfilled —
  but empty-string keys like `googleApiKey:""` FAIL the zod `.min(1)`), plus
  `generated/{compiled-policy,tool-annotations}.json` and a copy of the host
  `ca/` (so the prebuilt image content-hash matches — else multi-minute rebuild).
- `config.json` MUST exist or the child launches the first-start wizard (its
  stdin is a PTY/TTY). Freshness checks (`checkConstitutionFreshness`,
  `checkAnnotationFreshness`) only WARN — fixture policy hash mismatch is benign.
- Force apikey auth: `IRONCURTAIN_DOCKER_AUTH=apikey` + a fake `anthropicApiKey`.
  Also pin `ANTHROPIC_API_KEY=<fake>` in the parent env (child inherits; dotenv
  won't override an already-set var) so the repo `.env`'s REAL key never leaks
  host-side. `ANTHROPIC_BASE_URL=<local responder>` keeps MITM upstream on-host.

## Deterministic, LLM-free escalation trigger
- Don't drive the agent to call a tool (needs an LLM) or run a container-side MCP
  client (transport-specific/flaky). Get `escalationDir` from the discovered
  registration (`readActiveRegistrations(getPtyRegistryDir())`; tempdir registry
  is isolated so `regs[0]` is your session) and write `request-<id>.json`
  (`atomicWriteJsonSync`) directly — byte-for-byte what the host proxy writes.
  The host-side watcher path (the thing under test) is runtime/transport-agnostic.

## Boot-evidence timing
- The PTY registration is the definitive boot proof (`writeRegistration()` runs
  only after `docker.start` + PTY readiness). Sample "is the container running"
  via `docker ps` IMMEDIATELY after registration in beforeAll (capture a bool) —
  asserting it in a later `it` races the agent lifecycle / teardown.
- Container name suffix = `getBundleShortId(sessionId)` = dehyphenated UUID[0:12]
  (`src/session/types.ts`); `sessionId` is plain, so cast `as unknown as BundleId`.
- Cold first docker tcp-sidecar boot on macOS took ~120s; warm ~6s. Budget
  beforeAll at 180s. `manager.close()` only awaits child exit 5s; poll `docker ps -a`
  for the container to actually disappear before asserting no-orphan.
