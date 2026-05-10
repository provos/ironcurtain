---
name: memory-safety-c-cpp
description: Reference vocabulary for memory-safety vulnerabilities in native C/C++ code — bug-class taxonomy, common arithmetic patterns that lead to corruption, dispatch-family discipline, type-confusion idioms, use-after-free patterns, and exploitability factors. Read when analyzing, hypothesizing, designing harnesses for, or triaging findings against C/C++ code with sanitizer support (ASAN/UBSAN/TSAN/MSan). Not applicable to managed runtimes (JVM, .NET) or scripting languages — those have their own skills.
---

# Memory-Safety Bugs in C/C++

Reference vocabulary for native C/C++ code with sanitizer support. Catalogs the bug classes, patterns, and exploitability factors a memory-safety investigation needs to reason about.

## Bug-class taxonomy

Identifiers below are the canonical IDs to use when naming a bug class in any artifact. Map each to the oracle that catches it and the root-cause CWE.

| Bug class              | Oracle                                                               | Root-cause CWE | Where it lives                                                                                                             |
| ---------------------- | -------------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `heap_overflow`        | ASAN `heap-buffer-overflow`                                          | CWE-122        | Read or write past a heap allocation                                                                                       |
| `stack_overflow`       | ASAN `stack-buffer-overflow`                                         | CWE-121        | Read or write past a stack frame buffer                                                                                    |
| `out_of_bounds_read`   | ASAN OOB-read                                                        | CWE-125        | Generic OOB load — distinct from heap/stack only by site                                                                   |
| `out_of_bounds_write`  | ASAN OOB-write                                                       | CWE-787        | Generic OOB store                                                                                                          |
| `use_after_free`       | ASAN `heap-use-after-free`                                           | CWE-416        | Pointer dereferenced after the allocation it pointed to was freed                                                          |
| `double_free`          | ASAN `attempting double-free`                                        | CWE-415        | `free()` called twice on the same allocation                                                                               |
| `integer_overflow`     | UBSAN `signed-integer-overflow` / `unsigned-integer-overflow`        | CWE-190        | Arithmetic produces a value outside the type's range                                                                       |
| `type_confusion`       | ASAN OOB or UBSAN `vptr`                                             | CWE-843        | A value is interpreted as a different type than it was created with — frequently across vtable / dispatch-table boundaries |
| `format_string`        | ASAN OOB / UBSAN                                                     | CWE-134        | Attacker-controlled bytes reach the format-spec argument of a `printf`-family call                                         |
| `null_deref`           | SIGSEGV (caught by ASAN as `SEGV on unknown address 0x000000000000`) | CWE-476        | Dereference of a pointer the attacker can force to NULL                                                                    |
| `uninitialized_memory` | MSan `use-of-uninitialized-value`                                    | CWE-457        | Read of memory before it was written                                                                                       |
| `race_condition`       | TSAN `data race`                                                     | CWE-362        | Concurrent unsynchronized access (a TOCTOU is a special case where the racing accesses are check-then-use)                 |
| `memory_leak`          | LSan / ASAN leak report                                              | CWE-401        | Heap allocation lost without `free()`                                                                                      |

**CWE precision rule.** Always cite the _root-cause_ CWE, not the _consequence_ CWE. An integer overflow that leads to an undersized heap allocation and a subsequent OOB write is CWE-190 (the arithmetic bug), not CWE-122 (the consequence). A `strncpy` using the wrong size constant is CWE-806 (buffer access using size of source buffer), not CWE-120 (generic buffer overflow).

## Common arithmetic patterns that lead to corruption

These are the high-yield sites to look for whenever the surface processes attacker-controlled lengths, counts, offsets, or indices. Each is a _pattern_, not a procedure — the same pattern fires across many surfaces (parsers, codecs, compression, RPC framing, allocator wrappers).

- **Integer overflow into allocation size.** Attacker controls a count `n`. Code computes `n * sizeof(T)` (or `n + header`) and passes the result to `malloc`/`new[]`. The multiplication or addition wraps; the allocation is undersized; subsequent indexed writes overflow. The _named violation site_ is the multiplication or addition, not the OOB write — the OOB write is the consequence.

- **Signed/unsigned mixing at a comparison.** A signed integer is compared against an unsigned length (or vice versa). The signed value is implicitly converted to unsigned, turning negative values into very large positives. A "guard" of the form `if (i < len) ...` admits every negative `i` when `len` is unsigned.

- **Type narrowing at a storage boundary.** A wider type (computed precisely) is stored into a narrower container (`int` → `uint16_t`, `size_t` → `uint32_t`, `double` → `float`). The maximum value the source can reach exceeds the destination's range. Trace every write where source and destination types differ in width.

- **Unbounded growth meeting fixed-size storage.** A counter or accumulator grows without a hard cap, then is stored in or compared against a fixed-width field. When the counter reaches the maximum representable value of the storage type, the comparison flips or the stored value collides with a sentinel.

- **Sentinel and magic value reachability.** Identify every sentinel or magic value the code uses (`-1`, `0`, `NULL`, `0xFFFF`, `INT_MAX`, special tags). For each, ask whether any computed value — through normal execution, overflow, truncation, or wrapping — can equal the sentinel. Counters that grow toward a sentinel are a high-yield target.

- **Off-by-one at a buffer boundary.** Loop bound is `<=` instead of `<`, or vice versa. `strncpy` writes a non-null-terminated string. `memcpy` length is `len + 1` where `+1` was meant for a separate terminator.

- **Check-use separation (TOCTOU).** A value is validated in one place and consumed in another. Between check and use, the value can change — through concurrent access, callbacks, re-reads from shared / global state, or intervening function calls that mutate it.

- **Arithmetic result range vs destination range.** A multiplication, addition, or shift produces a value that exceeds the range of its destination type or comparison operand. Worth tracing whether intermediate computations widen the type before narrowing.

## Common non-arithmetic patterns

These produce memory corruption without an arithmetic root cause. They cluster around contract violations between functions — a writer leaves a buffer in a state the reader does not expect, or a sink assumes an invariant the source did not enforce. Apply alongside the arithmetic patterns; the bug at any given site may be in either category, and a surface that admits one usually admits both.

- **Missing null-termination on string sinks.** A function copies `n` bytes from a `(count, ptr)` pair into a buffer without appending a NUL. A downstream `printf("%s", ...)`, `strlen`, `strcat`, or `strchr` reads past the allocation searching for a terminator that does not exist. Particularly common in parsing routines that copy attacker-controlled strings field-by-field; the named violation site is the read sink, but the root cause is the writer's missing terminator.

- **Format-string controlled by attacker.** Attacker bytes reach the format-string argument of a `printf`-family call (`printf(user)` instead of `printf("%s", user)`). Yields memory disclosure via `%s` / `%n` and crashes via malformed specifiers. Trace every variadic-print call where the first argument is not a compile-time constant.

- **Length pair desynchronized from buffer.** A `(ptr, len)` interface is called with `len` exceeding the allocation behind `ptr`. Common when the length is read from input and the pointer is allocated to a different size, or when the buffer was reallocated but a stale length is used elsewhere. The bound check happens in one function; the read or write happens in another that assumes the check was honored.

- **Sentinel-driven iteration without an independent bound.** A loop walks until it hits a sentinel (`NUL`, `0xFFFF`, end-marker tag) without a hard cap. If the data lacks the sentinel — because validation did not enforce it, or the attacker stripped it — iteration runs past the buffer. Pairs naturally with terminated-string or terminated-list assumptions on input that has not been verified to terminate.

- **Print, dump, and diagnostic paths trust upstream invariants.** Print and dump routines often assume the data they receive has already been validated — terminated, bounded, well-formed — because they run after the parser. If validation skipped fields the print path consumes (common for "diagnostic" or "verbose" outputs), the print path becomes the OOB-read site even though the bug is the validator's omission. Every code path used only by `-v` / `-D` / `--debug` flags is its own attack surface that typically gets less validation attention than the main path.

## Dispatch-family discipline

When the target dispatches over a typed surface — a per-bps codec table, a per-message-type handler array, a per-opcode switch, a per-mode initializer, a per-format decoder — **every variant is its own attack surface**. Variants commonly share a contract on paper but differ in per-element arithmetic, buffer sizes, or guard placement.

- Treat each variant as a separate site for every pattern in this skill. "Same as variant X" is not a sufficient dismissal because variants commonly have differing per-element arithmetic.
- A coverage-gap finding is structural: if existing fuzzers exercise three of the seven variants, the other four are under-tested by the project itself.
- Variant selection often happens early (a header byte, a tag enum). The dispatch site itself is rarely vulnerable; the per-variant body usually is.

## Type-confusion in C++ vtables and dispatch tables

C++ adds a class of bugs that don't appear in pure C surfaces:

- **Bad downcast.** A `static_cast<Derived*>(base_ptr)` where `base_ptr` does not point to a `Derived`. Subsequent virtual calls invoke the wrong method; subsequent member accesses read or write at the wrong offsets.
- **Lifetime-vs-vtable race.** A method on `this` runs after the object's destructor has already started — common in callback handlers, signal handlers, and worker-thread teardown. `vptr` may have been overwritten or freed.
- **Polymorphic container element-type drift.** A `std::variant`, tagged union, or `void*`-keyed map records one type but is read as another, often after a refactor that added a new variant tag without updating every consumer.

UBSAN's `vptr` check (`-fsanitize=vptr`) catches some of these; the rest surface as `heap-use-after-free` or as silent corruption.

## Use-after-free patterns

UAFs cluster around lifetime confusion, not single-line bugs. The high-yield search patterns:

- **Lifetime bugs in callbacks.** A callback retains a pointer or reference to an object whose owner unregisters and frees it. The next callback invocation dereferences a freed pointer.
- **Freed-on-error paths.** An error handler frees a resource that the success path also frees. Either path alone is fine; the bug is in the joint state space — frequently exposed by partial failures inside a loop.
- **Double-free via aliasing.** Two pointers refer to the same allocation; both are passed through cleanup paths. A double-free is the symptom; the root cause is unclear ownership.
- **Stale iterator / span / reference.** A container is mutated (resize, erase, rehash) while an iterator, `string_view`, `span`, or raw pointer derived from it is held. The reference dereferences memory the container has moved or freed.
- **Object-resurrection patterns.** A reference-counted object's count drops to zero and is re-incremented before destruction completes — typically through a weak-pointer race.

## Primitive-extent scaling axes

Each memory-safety primitive class has natural scaling axes — the dimensions along which a minimum trigger can be pushed to characterize what an attacker can actually do with the primitive. Discover exercises these axes to produce adversary-maximal evidence; triage scores on the demonstrated extent. Mirrored from `vulnerability-triage`'s *Primitive extent* section so this skill (loaded by `discover` and `analyze`) carries the same canonical enumeration triage uses.

- **Out-of-bounds write/read.** Push distance past the allocation, total bytes accessed, attacker control over the written/read byte values, and stride between accesses. The minimum trigger may demonstrate one byte past one allocation with a fixed value; the axes ask whether that extends to attacker-chosen bytes across a larger span at a controllable stride.
- **Use-after-free.** Push reuse delay against any deferred-free queue or generation counter, and characterize the type set that can land in the freed slot under attacker-influenceable allocation pressure.
- **Type confusion.** Push the type-pair set the confusion lands on across the surrounding dispatch, and the depth of polymorphic dispatch reached in the confused state before the program faults or returns.
- **Integer overflow into undersized allocation.** Push the undersize ratio between requested and allocated size, and the extent of the downstream write or read that consumes the un-truncated value.
- **Unbounded iteration.** Push the iteration count against the buffer or frame the iteration writes into, and the attacker control over the value written at each step.
- **Resource exhaustion / DoS.** For primitives whose impact is allocation/CPU/IO exhaustion rather than memory corruption, the axes shift. Push file-size-to-effect amplification (peak RSS, CPU time, or FD count divided by input file size on disk); wire-body-to-effect amplification when transport compression is in scope (same numerator divided by compressed POST body size — material for AV:N primitives, where gzip/br/zstd handed by upstream proxies can dominate cost-to-attacker); per-item-size × item-count multiplication when the bug multiplies via list/array containers (both ceilings are attacker-controlled — document independently); and the allocation-timing locus (eager parse before any application code runs vs. lazy on-demand — determines where in the call graph mitigations can be sited).

If this list and `vulnerability-triage`'s *Primitive extent* section drift, fix both at once — triage's scoring rule and discover's evidence-gathering rule must reference the same axes.

## Exploitability reference

Whether a confirmed sanitizer crash is a real security risk depends on the runtime environment. This is reference material for triage, not a procedure.

**Mitigation timeline (shifts what's reachable):**

| Mitigation                 | Effect                                                          |
| -------------------------- | --------------------------------------------------------------- |
| Full RELRO                 | No GOT, no `.fini_array`, no `.init_array` writeable at runtime |
| glibc 2.34+                | `__malloc_hook` / `__free_hook` removed                         |
| glibc 2.38+                | `%n` may be blocked in some configurations — check empirically  |
| Stack canary + no infoleak | Cannot overflow past the canary without first leaking it        |
| ASLR + no infoleak         | Cannot find absolute addresses to write                         |

**Constraint rules to apply:**

- **strcpy on x86_64 writes 6 bytes per address.** A NULL-terminated `strcpy` copy writes the 6 low bytes of an address before the NULL byte stops it; the upper 2 bytes are not written. This bounds what a `strcpy`-based primitive can land.
- **Heap exploitation depends on the glibc version actually shipped.** `tcache` poisoning, `unsorted_bin` attacks, and house-of-\* techniques all have version windows. Cite the _deployed_ glibc, not the latest.
- **One-gadget feasibility is constraint-bounded.** A one-gadget needs registers and memory to be in specific states at the moment of call. A gadget that exists in `libc` is not the same as a gadget that's reachable from the crash state.

**When a sanitizer crash is NOT a security bug:**

- Assertion in an unreachable path (the harness reaches it because invariants the production code enforces were skipped in stubs).
- NULL-deref on `malloc` failure inside a path that the production environment never reaches under attacker pressure.
- Stack overflow at a recursive parser given input that would be rejected by an upstream length check the harness skipped.
- Uninitialized memory read on a path the production code never executes (debug-only branches, dead code).

The triage discipline is to anchor severity on what the harness _actually demonstrated under production-equivalent conditions_, not on the theoretical maximum implied by the crash class. A Tier-1 harness with hardening stripped tells you nothing about production outcomes.

## Hypothesis phrasing for memory-safety bugs

Hypotheses must be **value-level**, not pattern-level.

- Bad: "Supplying 24+ bytes overwrites the return address."
- Good: "At input offset 24, RIP=`0x4141414141414141` → SIGSEGV at attacker-controlled address."

- Bad: "There may be integer overflow in the parser."
- Good: "When the input field at `<file>:<line>` exceeds `2^31 - 1`, the multiplication at `<file>:<line>` wraps to a negative `int`, and the subsequent `malloc(n * sizeof(T))` allocates fewer bytes than the loop at `<file>:<line>` then writes."

A well-formed memory-safety hypothesis names: (1) the input value or shape that triggers the pattern, (2) the named arithmetic / dereference / lifetime site that violates, (3) the oracle that should fire (specific ASAN error class, UBSAN check, TSAN race, or assertion), and (4) the root-cause CWE.

## Observable-effect requirement

A finding is supported only by **observable evidence**: a crash, sanitizer trace, changed output, callback fired, file read, error message, or measurable state change. "Ran without error" is not evidence. If the expected effect is not observed, either the harness is wrong or the bug is not triggered — diagnose which; do not paper over.

When claiming a finding is exploitable, the supporting evidence must answer all three:

1. What specific input shape triggers it?
2. What dangerous operation does it reach (and how, exactly)?
3. What capability does an attacker gain that they did not have before?

If any of the three cannot be answered from the artifacts alone, the finding is not yet exploitable — it is a detector hit awaiting demonstration.

## Common pitfalls when reasoning about C/C++ memory safety

- **Confusing detector evidence with impact evidence.** A sanitizer fired on a Tier-1 isolated function tells you the detector caught something; it does not tell you the attacker can demonstrate impact in production. Padding, runtime guards, schema validators, sanitizing middleware, or attacker-uncontrolled state often absorb the effect.
- **Round-tripped attacker input mistaken for leaked target state.** If the bytes the bug "leaks" are bytes the attacker just sent, that is not a confidentiality finding. Memory-read findings need to demonstrate adjacency — what _target_ state sits next to the affected region.
- **Padding or zeroed memory mistaken for sensitive content.** A heap OOB read that returns NUL bytes, schema-sanitized placeholders, or default-config values has not demonstrated impact.
- **Hardening-stripped harness vs production binary.** A harness compiled without `-D_FORTIFY_SOURCE`, without stack canaries, without ASLR, or with custom allocators tells you nothing about the production binary's behavior. The triage question is "what does the production build do under this input," not "what does my Tier-1 reproduction show."
- **Variant tunnel-vision.** Reporting only the variant the harness reproduced when the underlying pattern (e.g., the same arithmetic in a sibling dispatch handler) reaches more of the surface. Every variant is its own attack surface; document each.
