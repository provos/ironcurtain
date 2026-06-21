# Evolve Workflow Package — architecture map (for harness/experiment slices)

Package: `src/workflow/workflows/evolve/` (workflow.yaml + scripts/).

## Current FSM (on master, post human-surface slice)
`initial: preflight`. States: preflight → preflight_review (gate) → orchestrator (hub) with
spokes sample/researcher/evaluate/analyzer/analysis_record; human_escalation gate; final_summary
(agent, outputs:[final_report]) → final_review (gate) → done; terminals done/failed/aborted.
`settings.mode: docker`, `dockerAgent: claude-code`, `sharedContainer: true`, `maxRounds: 200` (wedge backstop, NOT round budget).

## scripts/ bridge + vendored engine
- `scripts/requirements.txt` = `numpy` + `pyyaml` ONLY (stays generic — base venv).
- `scripts/evolve_result.py` = IronCurtain bridge; subcommands sample/evaluate/record/attach_analysis emit `{verdict,payload,passed}` result files.
- `scripts/evolve_core/` = vendored ASI-Evolve engine (byte-verbatim invariant). cli.py is the real engine entry (`main_for("eval"|"brief"|...)`).
- Wrappers: evolve-brief/eval/db/cognition/files/summary (thin `main_for(...)` shims).
- Helpers run as `/opt/workflow-venv/bin/python /workflow-scripts/...` (the persistent venv + scripts mount).

## run_spec schema (`evolve_core/run_state.py`)
DEFAULT_RUN_SPEC keys: objective; evaluation.{core_score,secondary_metrics,command,script_path,timeout_secs,success_criteria};
budget.{max_rounds,patience}; stop_conditions; mutation_scope.{writable_paths,primary_targets};
sampling.{algorithm,sample_n,...}; cognition.{source_mode,seed_files,seed_notes}; approval.{confirmed}.
- `require_evolve_ready()` (run_state.py:288) gates every mutating helper: checks missing-fields + approval.confirmed. Does NOT enforce budget.max_rounds.
- `compute_missing_fields` REQUIRED_FIELD_CHECKS at run_state.py:58.

## Evaluator wiring (THE key plumbing seam)
- `evolve_result.py evaluate` calls `evolve-eval run --code-path <ws-rel> --step-name ... --timeout T`.
- `cmd_eval_run` (cli.py:243) reads `spec.evaluation.command` (or `script_path`), formats it with `{quoted_code_path}`, `{quoted_results_path}`, `{quoted_script_path}` (command_context cli.py:98), then `subprocess.run(formatted, shell=True, cwd=workspace_root, timeout=...)`.
- Default when only script_path set: `python {quoted_script_path} {quoted_code_path} {quoted_results_path}`.
- So to wire an external evaluator: set `evaluation.command` (in preflight via `evolve-brief normalize --evaluation-command ...`) to e.g.
  `/opt/workflow-venv/bin/python /experiment/evaluator.py {quoted_code_path} {quoted_results_path}`.
- evaluate verdict: `evaluated` if engine rc==0 AND numeric `eval_score`/`score` present; else `evaluator_blocked`.
- `ensure_path_allowed` (run_state.py:300) gates the CANDIDATE code path against mutation_scope.writable_paths — NOT the evaluator path. Evaluator reads candidate copied into the step dir.

## Cognition seeding
- evolve_result.py sample seeds cognition from `<run_dir>/cognition_seed.md` (```json fenced blocks) on first round if cognition_data empty.
- Experiment's `init_cognition.py` imports the ASI-Evolve `Evolve.*` package (NOT vendored) — cannot run in our container. Infer the heuristics as cognition_seed.md content instead.

## Docker staging seam (`src/docker/docker-infrastructure.ts`)
- mounts array built ~line 1001: workspace (rw) + orientation (ro). scripts/venv pushed at 1121-1147. NEW `/experiment` ro mount hooks in here.
- `scriptsMount` = staged `scripts/` dir → `/workflow-scripts` (CONTAINER_SCRIPTS_DIR), readonly (set at 691-694).
- **`workflowPythonVenvMount`** = host cached venv → `/opt/workflow-venv` (WORKFLOW_PYTHON_VENV_DIR), readwrite. cacheKey = `computeWorkflowDependencyHash(agentBuildHash, scriptsDir)` (hashes requirements.txt/package.json ONLY — NOT the experiment).
- **Runtime provisioning ALREADY EXISTS**: `provisionWorkflowPythonDependencies` (1542) runs IN the container via `infra.docker.exec`: sentinel `.ironcurtain-provisioned-<cacheKey>` short-circuit, then `uv venv` + `UV_NATIVE_TLS=1 uv pip install -r /workflow-scripts/requirements.txt`. Host-side withProvisionLock serializes. Gated on `packageInstallEnabled` (MITM registry proxy) — throws actionable error if disabled.
- Base image (`docker/Dockerfile.base:14-30`, `.base.arm64:43-59`) ships `uv` (/usr/local/bin/uv), Python 3.12, `python3-pip`, `UV_NATIVE_TLS=1`. Confirmed.
- Proxy env: container gets `HTTPS_PROXY`/`HTTP_PROXY` → MITM (docker-infrastructure.ts ~1042 macOS TCP; Linux UDS branch parallel). `apt`/`pip`/`uv`/`npm` all route through it.
- MITM allowlist: providers + registries + dynamic passthrough (mitm-proxy.ts ~1392); registries open for whole run when packageInstall enabled. add/removeHost control at :45-69.
- `buildWorkflowExecCommand` (1447) prepends venv bin to live $PATH at exec time (so bare `python` resolves to the venv).

## Threading `--experiment` (CLI → daemon → start → mount)
- `workflow start` (interactive, in-process): `workflow-command.ts:248` `orchestrator.start(def, task, workspacePath?)`. start() at orchestrator.ts:1235; signature `start(definitionPath, taskDescription, workspacePath?)`. Stages scripts at 1271 via `stageWorkflowScriptsAtStart`; WorkflowInstance built 1280; `workflowScriptsDir` persisted in checkpoint.
- `workflow run` (daemon-backed): `daemon-gate-commands.ts:287` runRun → `client.call('workflows.start', {definitionPath, taskDescription, workspacePath?})`.
- Daemon handler: `src/web-ui/dispatch/workflow-dispatch.ts:256` `workflows.start` → `workflowStartSchema` (Zod, :89-91: definitionPath, taskDescription, workspacePath?) → `controller.start(...)`.
- So `--experiment` needs: new param on both CLI parsers, new Zod field, extended `start()` signature (or options object), new `WorkflowInstance.experimentDir`, checkpoint field, and the `/experiment` ro mount threaded through SessionOptions → CreateWorkflowInfrastructureInput (orchestrator.ts:405/602/845-855) → docker bundle.

## Agent-state declaration (WORKFLOWS.md §"Agent states", :476)
`type: agent`, `persona` ("global" or persona name), `prompt`, `inputs`/`outputs` (artifact dirs under `.workflow/`), `freshSession` (default true), `maxVisits`, `transitions` (when/guard). outputs:[] for code-only states.

## Resume durability split (LOAD-BEARING for any provision/install design)
- `orchestrator.ts:1412-1422`: resume does NOT reclaim the original container — "any dependencies installed in the previous run are lost"; lazy-mint means the first state after resume mints a FRESH container.
- Consequence: host-mounted `/opt/workflow-venv` (pip/uv) is RESUME-DURABLE; container-FS state (apt packages + their `.so`) is NOT. A `.provisioned`-style marker may gate the durable venv install but MUST NOT gate apt steps — `import <pkg>` can pass from the durable venv while a required apt `.so` is gone post-resume. So apt must be re-applied on EVERY provision entry.
- scipy's PyPI wheel bundles BLAS (self-contained) → circle-packing needs NO apt; demo path is pip-only.

## Evaluator → candidate venv inheritance (the real mechanism, not $PATH)
- circle_packing `evaluator.py:147-148` re-spawns the candidate via `subprocess.Popen([sys.executable, ...])`. When the evaluator runs as `/opt/workflow-venv/bin/python`, `sys.executable` IS the venv python → nested candidate inherits the venv (scipy). This is the load-bearing path, NOT `buildWorkflowExecCommand` prepending venv bin to $PATH (that governs the deterministic state's own `run:` command).

## createDockerInfrastructure wrapper (threading gotcha)
- `docker-infrastructure.ts:770` `createDockerInfrastructure` WRAPS `prepareDockerInfrastructure` (`:360`); orchestrator's default factory calls the WRAPPER (`orchestrator.ts:1146`). `scriptsDir` is a trailing positional on BOTH (`:781`/`:794` forwards into `:371`). Any new mount param (e.g. experimentDir) must be added to BOTH signatures + the default-factory call site, or it never reaches prepare.

## Daemon path resolution: definitionPath vs workspacePath
- `daemon-gate-commands.ts`: `definitionPath` is resolved client-side before RPC (`:307` resolveWorkflowPath). `workspacePath` is forwarded RAW (`:321`, no resolve()). For any new daemon path arg, copy definitionPath's pattern, NOT workspace's.

## Reference experiment (circle_packing_demo, `donotcommit/ASI-Evolve/experiments/`)
- `evaluator.py`: CLI `python evaluator.py <code_file> <output_json>`; needs numpy always; candidates need scipy.optimize. Emits eval_score = combined_score = sum_radii; loads candidate via exec(code) (extensionless ok). Validates 26 circles in unit square.
- `initial_program`: single-file `construct_packing() -> (centers, radii, sum)`, numpy-only.
- `input.md`: brief (pack 26 circles, maximize Σr, target 2.635). `eval.sh`: bash wrapper around evaluator.py (locates step dir, writes results.json) — NOT needed if we wire evaluator.py directly via run_spec command.
- `init_cognition.py`: 12 scipy/SLSQP heuristics (imports non-vendored Evolve pkg → infer as seed content). `config.yaml`: ASI-Evolve native config (informational only).
