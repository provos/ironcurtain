---
name: threat-model
description: Reference vocabulary for building and consuming a threat model — the threat-vs-vulnerability litmus test, the THREAT_MODEL.md schema (system context / assets / entry points / threats / deprioritized / open questions / provenance), entry-point surface taxonomy, threat-actor enum, STRIDE and infra/IAM gap-fill prompts, impact/likelihood scoring scales, the entry-point→threat and threat→hypothesis coverage invariants, and the threat-ID tagging rule that binds analyze hypotheses and triage findings back to the threat table. Read when producing the threat-model artifact, when scoping structural analysis against it, when checking ledger coverage, or when anchoring a finding's exploitability trace on a named entry point and asset. Language- and stack-neutral; pulls in the relevant surface skill (e.g. `memory-safety-c-cpp`) for bug-class-specific patterns.
---

# Threat Model

A threat model answers **"what could go wrong with this system, who would do it, and what would they gain?"** independently of whether any specific bug has been found yet. It is the map; structural analysis and harness execution are the metal detector. A good threat model tells `analyze` which entry points to trace and which bug classes each surface admits, tells the orchestrator when the hypothesis ledger has actually covered the attack surface, and tells `triage` which actor and asset a finding's CVSS vector should anchor on.

## Threat vs vulnerability — the litmus test

If patching one line of code makes an entry disappear, it was a **vulnerability**, not a threat. A threat ("attacker achieves RCE via untrusted media parsing") still stands after every known bug is fixed; a vulnerability ("`dr_wav.h:412` doesn't bounds-check `chunk_size`") does not.

The threat model produces threats. Vulnerabilities — past CVEs, git-log security fixes, prior pentest findings — appear only as **evidence** that raises a threat's likelihood score. Hypotheses produced by `analyze` are candidate vulnerabilities that **instantiate** a threat; they are tagged with the threat's ID, never the other way around.

## Artifact schema

The threat-model artifact is a single markdown file with seven required sections in the order below. Section headings, table column names, and enum values are a contract: downstream states (`analyze`, `orchestrator`, `triage`, `conclude`) parse them by heading match, so keep them exactly as shown.

```markdown
# Threat Model: <system name>

## 1. System context

## 2. Assets

## 3. Entry points & trust boundaries

## 4. Threats

## 5. Deprioritized

## 6. Open questions

## 7. Provenance
```

### §1 System context

One to three paragraphs of prose: what the system is, what it does, who uses it, where it runs, what language(s) and runtime, rough size. No table.

### §2 Assets

One row per thing worth protecting.

| asset | description | sensitivity |
| ----- | ----------- | ----------- |

`sensitivity` ∈ {`low`, `medium`, `high`, `critical`}. Process integrity is always an asset for native code; service availability is always an asset for anything that serves requests; downstream-embedder integrity is an asset for libraries.

### §3 Entry points & trust boundaries

One row per place untrusted input enters the system or privilege level changes. Supply-chain, build-time, and infra/IAM surfaces ARE entry points even though no runtime input crosses them.

| entry_point | description | trust_boundary | reachable_assets |
| ----------- | ----------- | -------------- | ---------------- |

`trust_boundary` is free text naming the crossing ("untrusted file → process memory", "unauth network → authenticated session", "namespace workload → WIF identity"). `reachable_assets` is a comma-separated list of §2 asset names.

### §4 Threats

One row per actor-wants-outcome pair, at the abstraction level where it survives a patch. **This is the threat model proper.**

| id  | threat | actor | surface | asset | impact | likelihood | status | controls | evidence |
| --- | ------ | ----- | ------- | ----- | ------ | ---------- | ------ | -------- | -------- |

- `id`: `T1`, `T2`, … assigned in (impact desc, likelihood desc) order. Stable across revisions; do not renumber when rows are removed.
- `threat`: one sentence, active voice, names the outcome. "Memory corruption leading to RCE via untrusted audio file parsing", not "buffer overflow in `decode()`".
- `actor` ∈ {`remote_unauth`, `remote_auth`, `adjacent_network`, `local_user`, `local_admin`, `supply_chain`, `insider`}.
- `surface`: which §3 `entry_point` this threat traverses. **Must match a §3 entry-point name string verbatim** — downstream coverage checks are text matches.
- `asset`: which §2 asset(s) this threat compromises.
- `impact` ∈ {`low`, `medium`, `high`, `critical`, `existential`}. See scoring guide below.
- `likelihood` ∈ {`very_rare`, `rare`, `possible`, `likely`, `almost_certain`}. See scoring guide below.
- `status` ∈ {`unmitigated`, `partially_mitigated`, `mitigated`, `risk_accepted`}.
- `controls`: current mitigations, or `none`.
- `evidence`: CVE IDs, commit hashes, issue links, or pentest finding IDs that instantiate this threat. May be empty. Evidence raises likelihood; it is not the threat.

Sort the table by (impact desc, likelihood desc) so the top rows are the priorities.

### §5 Deprioritized

Threats considered and explicitly parked.

| threat | reason |
| ------ | ------ |

Common reasons: out of scope per task description, actor not in the task's threat model, asset not present, risk accepted by owner. A §3 entry point with no §4 row MUST appear here as "<entry_point>: out of scope because …" — that is the only valid alternative to a §4 row.

### §6 Open questions

Bullet list. Things the code could not tell you: deployment context ("is this network-exposed or local-only?"), intended actors ("who supplies the input files in practice?"), upstream controls ("is there a WAF / sandbox / size limit upstream?"), risk appetite ("is DoS acceptable?"). These seed `human_escalation` directives when an investigation routes there.

### §7 Provenance

```
- mode: bootstrap
- date: <YYYY-MM-DD>
- target: <workspace path> @ <git rev-parse --short HEAD or "not a git repo">
- inputs: <task description summary>; <git-log mined | none>
```

## Entry-point surface taxonomy

Language-agnostic seed table for identifying §3 rows. Treat the "Look for" column as a **seed, not a checklist** — one concrete token per row to set the specificity bar, then extend with the idioms of whatever language/framework the target actually uses.

| Surface               | Look for                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Network               | socket `listen`/`accept`/`bind`; HTTP route definitions (`@app.route`, `router.get`); RPC/gRPC/GraphQL service defs |
| File / format parsing | file-open calls (`open(`, `fopen`); format magic-byte checks; "parse"/"decode"/"load"/"unmarshal" function names    |
| CLI / env             | argv parsers (`argparse`, `getopt`, `clap`); env reads (`getenv`, `os.environ`)                                     |
| Deserialization       | language-native deserializers on external data (`pickle`, `ObjectInputStream`, `yaml.load`, `Marshal.load`)         |
| DB / query            | raw query-string construction; ORM `.raw()`/`.query()` escapes                                                      |
| IPC / plugins         | dynamic load (`dlopen`, `LoadLibrary`); subprocess spawn; `eval`/`exec` on config; dynamic import                   |
| Supply chain          | dependency lockfiles; vendored libs; `curl \| sh` in build scripts                                                  |
| Infra / IAM           | terraform `*_iam_*`; k8s `serviceAccountName`/WIF annotations; secrets mounts; dataset/table `access{}` blocks      |

Bound the scan: exclude `vendor/`, `node_modules/`, `third_party/`, generated code; cap at ~5 representative file:function refs per surface row.

## STRIDE gap-fill

Past evidence (git log, CVEs) is biased toward what has already been found. A threat model must also cover what hasn't. For every §3 entry point, walk STRIDE and add the plausible categories as §4 rows:

|                     | For this entry point, could an attacker…              |
| ------------------- | ----------------------------------------------------- |
| **S**poofing        | …pretend to be a trusted source?                      |
| **T**ampering       | …modify data in transit or at rest?                   |
| **R**epudiation     | …act without leaving attributable logs?               |
| **I**nfo disclosure | …read data they shouldn't?                            |
| **D**oS             | …exhaust a resource (CPU, memory, disk, connections)? |
| **E**levation       | …end up with more privilege than they started with?   |

For **infra/IAM entry points** STRIDE maps less cleanly; walk these instead:

- **Over-grant**: does the identity reach more than the workload needs (whole dataset vs one table; project-level vs resource-level)?
- **Lateral identity**: can a co-located workload (same namespace/node/SA) assume this identity?
- **Drift**: is any grant managed outside this tree (click-ops IAM, ad-hoc ACL, unmanaged SA)?
- **Residual access**: do credentials or principals from a predecessor system survive a migration?
- **Scope enforcement**: where an automated approval/merge/write path exists, what bounds it to its intended scope?

Threats added by gap-fill have empty `evidence` — that is expected and correct. Score `likelihood` from technique prevalence and surface reachability alone. **A §4 table with no empty-evidence rows means gap-fill was skipped.**

## Scoring guide

### Impact

| value         | means                                                                       |
| ------------- | --------------------------------------------------------------------------- |
| `low`         | Nuisance; no data or availability loss.                                     |
| `medium`      | Limited data exposure or degraded availability for some users.              |
| `high`        | Significant data exposure, integrity loss, or full availability loss.       |
| `critical`    | Full compromise of a primary asset (RCE, auth bypass, data exfil at scale). |
| `existential` | Compromise threatens the operator's continued operation.                    |

### Likelihood

| value            | means                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `very_rare`      | Requires nation-state resources or an unlikely chain of preconditions.                                             |
| `rare`           | Requires significant skill and a non-default configuration.                                                        |
| `possible`       | A motivated attacker with public tooling could plausibly do this.                                                  |
| `likely`         | The attack surface is reachable and the technique is well known; prior evidence exists in this or similar systems. |
| `almost_certain` | Actively exploited in the wild, or trivially automatable against the default configuration.                        |

Evidence (past CVEs in the same surface, git-log security fixes, public exploit code) moves likelihood **up**. Existing controls move it **down**. Score the **residual** likelihood after current controls.

## Coverage invariants

These are the load-bearing rules. They turn the threat model from documentation into a constraint on when the investigation may close.

**Entry-point → threat coverage.** For every §3 row, the `entry_point` name MUST appear verbatim in at least one §4 `surface` cell, OR a §5 row MUST say "<entry_point>: out of scope because …". A §3 row with neither means the threat model is incomplete — gap-fill was skipped for that entry point.

**Threat → hypothesis coverage.** For every §4 row with `likelihood` ∈ {`possible`, `likely`, `almost_certain`} AND whose `surface` is in the task's scope, at least one analyze-produced hypothesis (`h1`, `h2`, …) MUST be tagged with that threat's `id`, OR the threat MUST appear in §5 with a reason. A §4 threat with no hypothesis and no §5 entry is an **uncovered in-scope threat** — the orchestrator's `complete` verdict is forbidden while any uncovered in-scope threat exists.

**Hypothesis → threat tagging.** Every cross-cutting pattern instance / hypothesis produced by structural analysis MUST carry a `Threat:` line listing the §4 `id`(s) it instantiates (e.g., `Threat: T1, T3`). A hypothesis whose pattern does not instantiate any §4 threat means the threat table is missing a row — add it (gap-fill applies retroactively), do not leave the hypothesis untagged.

## Anchoring downstream states

- **`analyze`.** The §3 entry points are the starting set for the backward call-graph trace; every entry point in the task's scope must be traced. The §4 threats name the bug-class vocabulary each surface admits — a network framing surface admits parsing/integer/DoS classes; a deserialization surface admits type-confusion/gadget-chain classes; an infra surface admits over-grant/drift classes. `analyze` consults the relevant surface skill (e.g. `memory-safety-c-cpp`) for the concrete patterns within each class, but the threat table decides **which** surface skills' classes apply to each entry point.
- **Orchestrator ledger.** The hypothesis ledger's terminal-state check is supplemented by the threat→hypothesis coverage invariant above. The ledger should render a per-threat coverage line alongside the per-hypothesis lines: `Threat coverage: T1 → h1,h3; T2 → h2; T4 → uncovered; T5 → deprioritized (§5)`.
- **`triage`.** Rubric item 7 (external exploitability trace) anchors on the §3 `trust_boundary` of the finding's tagged threat — that names the delivery channel from untrusted boundary to bug site. Rubric item 4 (adjacency / payload model) anchors on the §2 `reachable_assets` of that entry point. The CVSS Attack Vector maps from the threat's `actor` enum (`remote_unauth` → AV:N, `local_user` → AV:L, `adjacent_network` → AV:A, `supply_chain` → typically AV:L with Scope:Changed).
- **`conclude`.** The report index's Investigation-coverage section carries a per-threat coverage table mirroring the orchestrator's ledger line, so a reader can see which §4 threats the investigation reached and which were deprioritized.

## Common pitfalls

- **Restating the task scope as the only entry point.** The task description's named scope is what the user asked you to look at; it is not the system's only trust boundary. Map every entry point the source tree shows; mark the ones outside task scope in §5, do not omit them from §3.
- **One threat per bug class, ignoring surface.** "SQL injection" is not one threat; "SQL injection via unauth HTTP API" and "SQL injection via admin CLI" are different threats with different actors, impacts, and likelihoods. Cluster by `(entry point, bug class, asset)`, not by bug class alone.
- **Evidence in the threat statement.** "OOB write at `decode.c:412`" is a vulnerability; promoting it verbatim to a §4 row fails the litmus test. Generalize to the threat ("memory corruption via untrusted file parsing"), put `decode.c:412` in `evidence`.
- **Likelihood scored on theoretical reachability.** Likelihood is residual after controls. A reachable surface behind a working sandbox + size cap is `rare` or `possible`, not `likely`, even if the technique is well known.
- **Gap-fill skipped because git-log was rich.** Past fixes cluster where past attention went. The surfaces with no fix history are exactly where gap-fill earns its keep. Every §3 row must produce at least one §4 row or a §5 reason — no exceptions.
