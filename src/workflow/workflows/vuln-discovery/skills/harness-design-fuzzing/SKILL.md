---
name: harness-design-fuzzing
description: Reference vocabulary for designing instrumented harnesses that drive vulnerability discovery — design classes (trigger-driven vs coverage-driven), tiered scope (T1 isolated function / T2 multi-component / T3 full build), systematic input exploration, the two-coverage distinction (fuzzer-feedback vs audit), existing-fuzzer selection (libFuzzer / AFL++ / Jazzer / atheris / `go test -fuzz`), seed-corpus discipline, diagnostic checkpoints, common pitfalls, and design-document scope. Read when designing or reviewing a harness specification. Stays neutral on language and stack — pulls in the relevant surface skill (e.g. `memory-safety-c-cpp`) for bug-class taxonomy.
---

# Harness Design for Vulnerability Discovery

Reference vocabulary for designing instrumented harnesses that drive vulnerability discovery. Catalogs the classes, scopes, instrumentation choices, and pitfalls a harness design needs to reason about.

A harness is not a unit test. The point of a harness is to **systematically explore an input space against an oracle that fires on a violation** — not to confirm a few hand-picked cases. Hand-picked scenarios miss boundary values; the boundary is where the bug lives.

## Design class — pick first

Every harness has exactly one of two design classes. The class drives the sweep variables and the oracle. Tier (below) is orthogonal — any tier can be either class.

- **Trigger-driven.** The directive supplies a falsifiable claim with a named violation site — a specific function, value range, and expected oracle (a bounds check fires, a type narrows lossily, a sentinel collides, a state-machine transition is reached out of order). The harness sweeps the **hypothesis input variables**. The oracle is the named violation pattern firing.

- **Coverage-driven.** The directive supplies an under-exercised dispatch surface — a code region the project's existing fuzzers don't reach, with named dispatch axes (option flags, message types, opcode tables, mode bits, format variants) the input space hasn't crossed. The harness sweeps the **dispatch axes**. The oracle is **any sanitizer error within the named region**. The named region must be a concrete file/function set, not "somewhere in the target."

Pick coverage-driven when prior trigger-driven rounds against the same region have been mitigated by upstream guards but the region itself is untested by the existing fuzz infrastructure. Pick trigger-driven when there is a specific theory to falsify.

## Harness tiers

Three tiers of infrastructure scope. Match tier to hypothesis scope; never use Tier 1 for a cross-component target.

### Tier 1 — Isolated function test
Extract the relevant function(s) into a standalone, self-contained program. Copy the exact types, macros, and helper functions verbatim from the source. Stub only I/O, networking, and allocation.

**Critical:** the test must faithfully preserve ALL code paths that interact with the violation site. If the hypothesis involves a value computed in function A being consumed in function B, BOTH functions must be included — do not test A in isolation and assume B's behavior.

Use Tier 1 when the hypothesis is about a single function: arithmetic boundary, type narrowing, off-by-one, a self-contained parsing routine. Runs millions of trials per second.

### Tier 2 — Multi-component harness
Link multiple real source files from the project. Preserve actual data structures, type definitions, inter-function calls, and state that accumulates across calls. Specify:

- Which source files to link
- Which functions' logic must be preserved vs stubbed
- Which struct layouts must match the real project
- Coverage instrumentation for both kinds (see below)

Use Tier 2 when the hypothesis involves cross-function interaction — a value computed in one function being consumed or compared in another, sentinel collisions across components, state accumulated across multiple call sites, or dispatch tables linked across compilation units.

### Tier 3 — Full build with instrumented input
Compile the actual project (or a substantial subset) with sanitizers and coverage. A driver feeds crafted input files, protocol messages, or CLI invocations through real entry points. Specify:

- The protocol/interaction sequence the driver must follow
- Required setup (handshakes, session establishment, state-machine transitions)
- Session reset mechanism between runs
- Coverage report format (lcov, JSON, or stack-equivalent)

Use Tier 3 when the bug depends on initialization sequences, global state, runtime configuration, or protocol-level framing that can't be faithfully stubbed.

### Picking the right tier

- Hypothesis names ONE function → Tier 1.
- Hypothesis involves a value flowing between 2+ functions, or a sentinel/type used across components → Tier 2 minimum.
- Hypothesis requires real initialization, protocol framing, or global state → Tier 3.
- If in doubt, go higher. Tier-1 reproductions of cross-component bugs produce false negatives and false positives — both equally misleading.

## Systematic input exploration

The harness must FUZZ, not unit-test. For each swept variable (hypothesis inputs for trigger-driven, dispatch axes for coverage-driven), the design must specify:

- **Sweep range.** The full range of values to iterate over. Cover the entire representable range of the type, not just "a few specific values." For wide ranges, specify dense sampling near type boundaries (min, max, zero, `2^N - 1` for each relevant N, sign-flip points) plus sparse sampling elsewhere. For coverage-driven dispatch axes, the range is the full set of dispatch values plus their realistic combinations.
- **Search strategy.** Exhaustive enumeration if the space is < 100M combinations; boundary-dense + random sampling otherwise; coverage-guided fuzzer for large or structured input spaces.
- **Observables.** At each input value, what does the harness record? Stored value in the target buffer, result of the bounds check at `<file>:<line>`, return value of the target function, sanitizer error, canary state, dispatch arm hit. Be specific by site.
- **Positive-finding condition.** What pattern in the observables confirms the design's claim? For trigger-driven: be specific — not "a crash happens" but "the bounds check at `<file>:<line>` evaluates true when the input value exceeds the buffer's allocated size." For coverage-driven: "any sanitizer error within the named code region" is acceptable, but the region must be concrete.

The design specifies input variables and ranges. The implementer drives the sweep. Do NOT prescribe individual "Test A / Test B / Test C" scenarios with fixed values — that's unit testing and will miss the actual boundary.

### Multi-hypothesis bundling

A trigger-driven design may scope a single hypothesis or a related set when they share input space and code region. Bundle when consolidating doesn't dilute the sweep (e.g., three integer-overflow hypotheses on the same allocator → one harness). Keep separate when input distributions conflict (one wants huge dimensions, another wants small) or observation points differ enough that one harness can't see both.

When bundling, the sweep range is the **union** of input-variable ranges, the positive-finding condition is the **disjunction** of named violation patterns, and observables must cover all named sites. Briefly justify the bundling — bundled designs only pay off when the hypotheses share enough input space and code region that one harness can exercise them coherently. More than three hypotheses bundled in one harness is a signal of an unfocused design.

## Coverage instrumentation — two distinct concerns

Fuzzing requires two instrumentation decisions that are easy to confuse. The design must address both.

### 1. Fuzzer-feedback coverage

Instrumentation the fuzzer consumes at runtime to guide mutation. Tool-specific, falls into three categories:

- **Compile-time sanitizer coverage.** libFuzzer's `-fsanitize=fuzzer` (which enables `-fsanitize-coverage=trace-cmp` by default), often combined with `-fsanitize=address,undefined`. Additional coverage knobs: `trace-pc-guard`, `trace-cmp`, `trace-div`, `trace-gep`.
- **Compile wrappers.** AFL++'s `afl-clang-fast`, `afl-clang-lto` (LTO mode, generally preferred when usable), or `afl-gcc-fast`.
- **Runtime agents** for managed stacks. Jazzer's Java agent for JVM, atheris's import rewriter for Python, Go's built-in coverage for `go test -fuzz`.

The design must name **the exact mechanism** AND **the exact metric field name the validator will read** from the fuzzer's status output. Without the metric name, downstream verification cannot gate on "the fuzzer's feedback chain reached the target." Canonical field names:

| Fuzzer            | Field for "edges/blocks hit by feedback" |
| ----------------- | ---------------------------------------- |
| libFuzzer         | `cov:` (also `ft:` for features)         |
| AFL++             | `edges_found`                            |
| Jazzer            | reports via libFuzzer (`cov:`)           |
| Go `go test -fuzz`| `new interesting` count                  |
| atheris           | reports via libFuzzer (`cov:`)           |

### 2. Audit coverage

Post-run reporting of which lines executed: `llvm-cov`, `gcov`, Python `coverage.py`, JaCoCo, Go's `-cover`, and stack-equivalents. This is an audit tool, not a feedback signal. A harness can have audit coverage without fuzzer-feedback coverage — that is the **forgot-to-instrument-the-target pitfall**: the run reports lines hit in the wrapper but the fuzzer was driving randomly because no feedback signal reached it.

### Target-code instrumentation (required)

Fuzzer-feedback coverage MUST reach the **target code**, not just the harness wrapper. Name the unit (library, package, module, class) that must carry it. Prebuilt artifacts from elsewhere — system libraries, distribution wheels, `.node` files, pre-built binary crates — do NOT carry instrumentation retroactively. The design must call for the target to be rebuilt under the fuzzer-feedback toolchain, or a pre-instrumented artifact to be located. If the project's build cannot accommodate that, say so — it is a signal to switch tools.

### Fallback path

Specify an alternative tool that uses a **different instrumentation mechanism** — not just a different frontend on the same one. A fallback on the same mechanism inherits the same failure mode. Canonical pairing: libFuzzer ↔ AFL++ (sanitizer-coverage vs. compile-wrapper). Cross-stack pairings (Jazzer ↔ Kelinci on JVM, atheris ↔ python-afl on Python) work the same way.

## Existing fuzzer selection

For large input spaces, structured inputs, or whenever coverage-guided exploration would outperform a hand-rolled loop, design the harness around an existing fuzzer rather than reinventing one. The build agent installs the tool; the design specifies WHICH tool, WHY, and the entry-point shape.

| Stack           | Canonical fuzzer       | Entry-point shape                                                            |
| --------------- | ---------------------- | ---------------------------------------------------------------------------- |
| C / C++         | libFuzzer (in-process) | `extern "C" int LLVMFuzzerTestOneInput(const uint8_t *Data, size_t Size)`    |
| C / C++         | AFL++ (out-of-process) | Standard `main` reading from stdin or a file path; coverage via compile wrap |
| JVM             | Jazzer                 | `static void fuzzerTestOneInput(byte[] data)` or `FuzzedDataProvider` form   |
| Python          | atheris                | `atheris.Setup([...], TestOneInput)` with `def TestOneInput(data: bytes)`    |
| Go              | `go test -fuzz`        | `func FuzzXxx(f *testing.F) { f.Fuzz(func(t *testing.T, ...) { ... }) }`     |
| Rust            | `cargo fuzz` (libFuzzer)| `fuzz_target!(|data: &[u8]| { ... })`                                       |

For small discrete spaces, bounded enumeration (a typed `for` loop) is fine — but the design must state the choice and why.

## Seed corpus and dispatch surface

A coverage-guided fuzzer is only as good as its starting corpus. The corpus must reach the dispatch surface — otherwise feedback-driven mutation never explores the variants behind the dispatcher.

- **Programmatic seeds for structured dispatchers.** If the target has a structured dispatch table (tag table, opcode switch, protocol message-type enum, state-machine driver), the design must specify seeds **generated programmatically from that table** — at least one per dispatch case. This guarantees every variant has a representative the mutator can build from.
- **Hand-curated deep-path seeds are additive.** A few hand-crafted inputs that drive a specific protocol exchange or codec path complement programmatic seeds; they do not substitute for them.
- **Small discrete targets.** Mark seed corpus N/A with a one-line reason — e.g., the input is a single 32-bit integer and the harness exhausts it.

## Diagnostic checkpoints

Every design must specify three verification steps that the implementer can execute before declaring the harness usable:

1. **Baseline reachability.** With a benign input, confirm the target function is executed (audit-coverage hit at the named function, log line, or trace marker).
2. **Input integrity.** Verify inputs arrive at the target function unmodified — no truncation by an outer wrapper, no encoding mangling, no unintended preprocessing.
3. **Fuzzer-feedback reach.** Specify a threshold the target code's fuzzer-feedback metric must meet after a short fuzz burst (e.g., libFuzzer `cov:` > N covering the target unit, AFL++ `edges_found` > M attributable to the target). If not met, the feedback chain is broken — the fuzzer is mutating but no signal from the target reaches it.

## Mitigation testing discipline

The harness MUST test against UNMODIFIED source code. Stripping a guard, weakening a check, or replacing a sanitizer-armed allocator with a permissive one tells you nothing about the production binary's behavior. If the hypothesized condition doesn't trigger within the swept range, document which code intercepts it and whether that code covers ALL relevant paths.

A Tier-1 harness with hardening stripped tells you nothing about production outcomes. Triage anchors on what the harness demonstrated under production-equivalent conditions.

## Delegate library realism

Mitigation discipline applies at the link layer too. A harness that links against a project-internal stub of an upstream library produces evidence about the stub, not about production. Every stub the design introduces must be classified.

- **Class A — I/O / allocator stubs.** Replace operations whose behavior is irrelevant to the violation site: fixed-buffer reads/writes, controlled-return allocators, no-op logging, deterministic clocks. Acceptable.
- **Class B — Validator / parser / decoder stubs.** Replace upstream components that perform trust-boundary validation in production: format parsers, input validators, signature/checksum verifiers, schema validators, dimension/type checkers inside delegate libraries. **Forbidden.** A Class B stub strips production validation at the linker level — equivalent to redefining `VALIDATE_INPUT` to a no-op. The violation site may be reachable in the harness while in production the upstream library rejects the trigger before it lands.
- **Class C — Non-production build configuration.** Real upstream library, but built or installed with optional features/components disabled that production deployments typically enable (compile-time build flags, language build tags, optional-dependency extras, conditional-compilation gates). Equivalent to a Class B stub of those features — **forbidden**. The design must enumerate each delegate's build-time configuration and confirm parity with the production-default build.

The design must enumerate every stub it introduces and classify each. Any Class B stub or Class C build-flag mismatch is a redesign trigger, not a tradeoff. If the violation site is unreachable through the real upstream library because the library's own validation pre-empts the trigger, the bug is a latent code smell — not an exploitable vulnerability — and the hypothesis should be re-evaluated rather than papered over with a permissive stub.

If integrating the real upstream library requires a higher tier than the design currently states, escalate the tier. Class B stubbing is not an acceptable shortcut to keep a Tier 1 design viable.

## Infrastructure assumptions

List every external dependency (sanitizer toolchain, fuzzer binary, coverage tool, decoder library, container image, kernel feature like KASAN, hypervisor mode) and what the design falls back to if any are unavailable. An assumption that goes unstated becomes a bug in the build phase.

## Common pitfalls

- **Tier-1 for a cross-component target.** Reproducing the value flow across a stub instead of the real callee. The stub agrees with the hypothesis by construction; the bug doesn't reproduce, or reproduces falsely.
- **Audit coverage without fuzzer feedback.** The harness reports lines hit but the fuzzer was running blind — no feedback signal reached the target. The "forgot-to-instrument-the-target" pitfall.
- **Feedback instrumentation on the wrapper, not the target.** The fuzzer is happily following coverage in the harness scaffold; the target's code is not contributing edges. Symptom: `cov:` plateaus quickly; the target is barely exercised.
- **"Test a few values" unit testing.** The design enumerates 5–10 fixed scenarios. The boundary is somewhere in the other 4 billion values the type can hold.
- **Fallback on the same instrumentation mechanism.** The design lists "libFuzzer or honggfuzz" — both sanitizer-coverage based. If sanitizer-coverage fails to attach to the target, both fail.
- **Prebuilt-artifact assumption.** "We'll fuzz against the system-installed library" — system libraries do not carry the fuzzer-feedback instrumentation. Either rebuild the dependency or pick a different surface.
- **Hand-rolled loop for a structured input space.** Reinventing libFuzzer with a `for` loop over `rand()`. Coverage-guided fuzzers exist because feedback-driven mutation finds boundary values that uniform random does not.
- **Seed corpus omits dispatch arms.** Programmatic per-arm seeds were skipped; the fuzzer never explores past the first arm of the dispatcher because no input takes any other arm.
- **Hand-picked positive scenarios masquerading as a sweep.** Five "boundary cases" are chosen by hand. The actual boundary in the target's arithmetic is not one of the five.
- **Hardening stripped for "easier debugging."** ASLR off, canaries off, custom permissive allocator. The harness fires; production does not. Tells you nothing.
- **Validator stubbed at link time.** A project-internal stub of a parser, validator, or decoder library is linked into the harness, omitting the upstream component's own validation. The harness fires; production rejects the trigger before the violation site is reached. Tells you nothing about reachability.

## Design-document scope

A design IS a specification. A design IS NOT an implementation.

Include:

- What source files to link and why
- What types, structs, and macros to preserve verbatim vs stub
- What input variables to sweep and over what range
- What conditions constitute a positive finding
- What instrumentation (sanitizer set, feedback mechanism, audit tool) to use
- The fallback tool and why its mechanism differs
- Diagnostic checkpoints with named thresholds
- Infrastructure assumptions and fallbacks
- Stub inventory and classification (Class A/B/C per *Delegate library realism*); designs declare every stub and every delegate's build-flag parity status

Exclude:

- Full C/Python/Java/etc. source code for the harness
- Build scripts or compile commands with full flag lists (reference them abstractly: "compile with ASAN+UBSAN+libFuzzer")
- Test execution results or tables of "expected outcomes" — nothing has been run yet
- Pre-enumerated `Test A / Test B / Test C` scenarios with fixed values

The design is read by an implementer who must turn it into running code. Be concrete enough that they don't have to guess at the spec; abstract enough that they aren't transcribing your code. If the design's body could compile, it has drifted into implementation.
