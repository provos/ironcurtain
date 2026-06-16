"""CLI entrypoints for the Evolve skill."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from difflib import unified_diff
from pathlib import Path
from typing import Any, Dict, List, Optional

from .best_snapshot import BestSnapshotManager
from .cognition import Cognition
from .database import Database
from .run_state import (
    append_round_log,
    build_run_dir,
    compute_missing_fields_for_workspace,
    deep_merge,
    ensure_path_allowed,
    ensure_run_layout,
    flatten_list,
    initialize_cognition_seed_file,
    load_run_spec,
    load_structured_file,
    normalize_spec_path,
    require_evolve_ready,
    save_run_spec,
    workspace_root_for_run,
    write_preflight_summary,
)
from .sampling_config import (
    SAMPLING_CONFIG_IMMUTABLE_ERROR,
    build_database_sampling_config,
    configured_sampling_algorithm,
    configured_sample_n,
    run_has_recorded_nodes,
    sampling_config_fingerprint,
    validate_custom_sampler_for_workspace,
)
from .structures import CognitionItem, Node


def emit_json(payload: Dict[str, Any]) -> int:
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def parse_bool(value: Optional[str]) -> Optional[bool]:
    if value is None:
        return None
    lowered = value.strip().lower()
    if lowered in {"1", "true", "yes", "y"}:
        return True
    if lowered in {"0", "false", "no", "n"}:
        return False
    raise argparse.ArgumentTypeError(f"Invalid boolean value: {value}")


def build_database(run_dir: Path, spec: Dict[str, Any]) -> Database:
    algorithm, sampling_kwargs = build_database_sampling_config(
        spec,
        workspace_root_for_run(run_dir),
    )
    return Database(
        storage_dir=Path(run_dir) / "database_data",
        sampling_algorithm=algorithm,
        sampling_kwargs=sampling_kwargs,
    )


def build_cognition(run_dir: Path) -> Cognition:
    return Cognition(storage_dir=Path(run_dir) / "cognition_data", score_threshold=0.0)


def extract_seed_items(markdown_path: Path) -> List[CognitionItem]:
    text = Path(markdown_path).read_text(encoding="utf-8")
    items: List[CognitionItem] = []
    for raw_block in re.findall(r"```json\s*(.*?)```", text, re.DOTALL):
        payload = json.loads(raw_block)
        if isinstance(payload, dict):
            payload = [payload]
        for raw_item in payload:
            items.append(
                CognitionItem(
                    content=raw_item.get("content", ""),
                    source=raw_item.get("source", ""),
                    metadata=raw_item.get("metadata", {}),
                    id=raw_item.get("id"),
                )
            )
    return items


def command_context(
    workspace_root: Path,
    run_dir: Path,
    step_dir: Path,
    code_path: Path,
    results_path: Path,
    script_path: Optional[str],
    timeout_secs: int,
) -> Dict[str, str]:
    raw = {
        "workspace_root": str(workspace_root),
        "run_dir": str(run_dir),
        "step_dir": str(step_dir),
        "code_path": str(code_path),
        "results_path": str(results_path),
        "script_path": script_path or "",
        "timeout_secs": str(timeout_secs),
    }
    quoted = {
        f"quoted_{key}": f'"{value}"' if value else '""'
        for key, value in raw.items()
    }
    return {**raw, **quoted}


def cmd_brief_normalize(args: argparse.Namespace) -> int:
    workspace_root = Path(args.workspace_root or Path.cwd()).resolve()
    run_dir = build_run_dir(workspace_root, args.run_name)
    ensure_run_layout(run_dir)
    spec = load_run_spec(run_dir)
    original_sampling = sampling_config_fingerprint(spec)

    if args.spec_file:
        spec = deep_merge(spec, load_structured_file(Path(args.spec_file)))

    if args.objective is not None:
        spec["objective"] = args.objective
    if args.core_score is not None:
        spec["evaluation"]["core_score"] = args.core_score
    if args.secondary_metric is not None:
        spec["evaluation"]["secondary_metrics"] = flatten_list(args.secondary_metric)
    if args.evaluation_command is not None:
        spec["evaluation"]["command"] = args.evaluation_command
    if args.evaluation_script_path is not None:
        spec["evaluation"]["script_path"] = normalize_spec_path(
            workspace_root, args.evaluation_script_path
        )
    if args.evaluation_timeout_secs is not None:
        spec["evaluation"]["timeout_secs"] = args.evaluation_timeout_secs
    if args.success_criterion is not None:
        spec["evaluation"]["success_criteria"] = flatten_list(args.success_criterion)
    if args.max_rounds is not None:
        spec["budget"]["max_rounds"] = args.max_rounds
    if args.patience is not None:
        spec["budget"]["patience"] = args.patience
    if args.stop_condition is not None:
        spec["stop_conditions"] = flatten_list(args.stop_condition)
    if args.writable_path is not None:
        spec["mutation_scope"]["writable_paths"] = [
            normalize_spec_path(workspace_root, value)
            for value in flatten_list(args.writable_path)
        ]
    if args.primary_target is not None:
        spec["mutation_scope"]["primary_targets"] = [
            normalize_spec_path(workspace_root, value)
            for value in flatten_list(args.primary_target)
        ]
    if args.sampling_algorithm is not None:
        spec["sampling"]["algorithm"] = args.sampling_algorithm
    if args.sample_n is not None:
        spec["sampling"]["sample_n"] = args.sample_n
    if args.sampling_feature is not None:
        spec["sampling"]["feature_dimensions"] = flatten_list(args.sampling_feature)
    if args.sampling_feature_bins is not None:
        spec["sampling"]["feature_bins"] = args.sampling_feature_bins
    if args.sampling_custom_sampler_path is not None:
        spec["sampling"]["custom_sampler_path"] = normalize_spec_path(
            workspace_root, args.sampling_custom_sampler_path
        )
    if args.sampling_custom_sampler_class is not None:
        spec["sampling"]["custom_sampler_class"] = args.sampling_custom_sampler_class
    if args.cognition_source_mode is not None:
        spec["cognition"]["source_mode"] = args.cognition_source_mode
    if args.seed_file is not None:
        spec["cognition"]["seed_files"] = [
            normalize_spec_path(workspace_root, value) for value in flatten_list(args.seed_file)
        ]
    if args.seed_note is not None:
        spec["cognition"]["seed_notes"] = flatten_list(args.seed_note)
    if args.confirmed is not None:
        spec["approval"]["confirmed"] = args.confirmed

    missing = compute_missing_fields_for_workspace(spec, workspace_root)
    custom_sampler_error = validate_custom_sampler_for_workspace(spec, workspace_root)
    if spec.get("approval", {}).get("confirmed") and missing:
        detail = ""
        if custom_sampler_error:
            detail = f" Custom sampler validation failed: {custom_sampler_error}"
        raise SystemExit(
            "Cannot confirm preflight while required fields are missing: "
            + ", ".join(missing)
            + detail
        )

    if run_has_recorded_nodes(run_dir):
        updated_sampling = sampling_config_fingerprint(spec)
        if updated_sampling != original_sampling:
            raise SystemExit(SAMPLING_CONFIG_IMMUTABLE_ERROR)

    spec_file = save_run_spec(run_dir, spec)
    summary_file = write_preflight_summary(run_dir, spec)
    seed_file = initialize_cognition_seed_file(run_dir, spec)
    return emit_json(
        {
            "confirmed": spec["approval"]["confirmed"],
            "missing_fields": missing,
            "custom_sampler_error": custom_sampler_error,
            "preflight_summary": str(summary_file),
            "run_dir": str(run_dir),
            "run_spec": str(spec_file),
            "seed_file": str(seed_file),
        }
    )


def cmd_eval_inspect(args: argparse.Namespace) -> int:
    preview = ""
    exists = False
    if args.script_path:
        script_path = Path(args.script_path).resolve()
        exists = script_path.exists()
        if exists:
            preview = "".join(script_path.read_text(encoding="utf-8").splitlines(True)[:20])
    else:
        script_path = None
    return emit_json(
        {
            "command": args.command or "",
            "exists": exists,
            "preview": preview,
            "script_path": str(script_path) if script_path else "",
        }
    )


def cmd_eval_run(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    spec = require_evolve_ready(run_dir)
    workspace_root = workspace_root_for_run(run_dir)
    ensure_run_layout(run_dir)

    source_code = Path(args.code_path)
    if not source_code.is_absolute():
        source_code = (workspace_root / source_code).resolve()
    ensure_path_allowed(run_dir, source_code)

    step_name = args.step_name or "manual_step"
    step_dir = Path(run_dir) / "steps" / step_name
    step_dir.mkdir(parents=True, exist_ok=True)
    step_code_path = step_dir / "code"
    if source_code != step_code_path:
        shutil.copyfile(source_code, step_code_path)

    results_path = step_dir / "results.json"
    command = args.command or spec.get("evaluation", {}).get("command", "")
    script_path = args.script_path or spec.get("evaluation", {}).get("script_path", "")
    evaluation_timeout = args.timeout
    if evaluation_timeout is None:
        evaluation_timeout = int(spec.get("evaluation", {}).get("timeout_secs", 0) or 0)
    if not command and script_path:
        command = "python {quoted_script_path} {quoted_code_path} {quoted_results_path}"
    if not command:
        raise SystemExit("No evaluation command or script path is configured.")
    if evaluation_timeout <= 0:
        raise SystemExit("Evaluation timeout must be a positive number of seconds.")

    formatted = command.format(
        **command_context(
            workspace_root=workspace_root,
            run_dir=run_dir,
            step_dir=step_dir,
            code_path=step_code_path,
            results_path=results_path,
            script_path=script_path,
            timeout_secs=evaluation_timeout,
        )
    )
    (step_dir / "eval.command.txt").write_text(formatted, encoding="utf-8")

    stdout = ""
    stderr = ""
    return_code = 0
    try:
        completed = subprocess.run(
            formatted,
            shell=True,
            cwd=workspace_root,
            capture_output=True,
            text=True,
            timeout=evaluation_timeout,
        )
        stdout = completed.stdout
        stderr = completed.stderr
        return_code = completed.returncode
    except subprocess.TimeoutExpired as exc:
        stdout = exc.stdout or ""
        stderr = exc.stderr or ""
        return_code = 124

    (step_dir / "eval.stdout").write_text(stdout, encoding="utf-8")
    (step_dir / "eval.stderr").write_text(stderr, encoding="utf-8")

    if results_path.exists():
        results = json.loads(results_path.read_text(encoding="utf-8"))
    else:
        results = {}

    if return_code != 0:
        results.setdefault("success", False)
        results.setdefault("eval_score", 0.0)
        results.setdefault("score", results.get("eval_score", 0.0))
        results.setdefault("error", stderr or f"Evaluator exited with code {return_code}")
        results_path.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    append_round_log(
        run_dir,
        "eval_run",
        {
            "command": formatted,
            "return_code": return_code,
            "step_name": step_name,
            "timeout_secs": evaluation_timeout,
        },
    )
    return emit_json(
        {
            "results_path": str(results_path),
            "return_code": return_code,
            "step_dir": str(step_dir),
            "success": return_code == 0,
        }
    )


def cmd_cognition_init(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    ensure_run_layout(run_dir)
    cognition = build_cognition(run_dir)
    if args.reset:
        cognition.reset()

    seed_path = Path(args.seed_file) if args.seed_file else run_dir / "cognition_seed.md"
    items = extract_seed_items(seed_path) if seed_path.exists() else []
    if items:
        cognition.add_batch(items)

    append_round_log(
        run_dir,
        "cognition_init",
        {"items_added": len(items), "seed_file": str(seed_path)},
    )
    return emit_json({"items_added": len(items), "total_items": len(cognition)})


def cmd_cognition_add(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    ensure_run_layout(run_dir)
    cognition = build_cognition(run_dir)
    items: List[CognitionItem] = []
    for text in flatten_list(args.item):
        items.append(
            CognitionItem(
                content=text,
                source=args.source or "",
                metadata={"kind": args.kind} if args.kind else {},
            )
        )
    if args.json_file:
        payload = load_structured_file(Path(args.json_file))
        if isinstance(payload, dict):
            payload = [payload]
        for raw_item in payload:
            items.append(
                CognitionItem(
                    content=raw_item.get("content", ""),
                    source=raw_item.get("source", ""),
                    metadata=raw_item.get("metadata", {}),
                )
            )
    cognition.add_batch(items)
    append_round_log(run_dir, "cognition_add", {"items_added": len(items)})
    return emit_json({"items_added": len(items), "total_items": len(cognition)})


def cmd_cognition_search(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    cognition = build_cognition(run_dir)
    matches = cognition.retrieve(args.query, top_k=args.top_k)
    return emit_json(
        {
            "matches": [
                {"content": item.content, "metadata": item.metadata, "score": score, "source": item.source}
                for item, score in matches
            ]
        }
    )


def cmd_db_sample(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    spec = require_evolve_ready(run_dir)
    db = build_database(run_dir, spec)
    configured_algorithm = configured_sampling_algorithm(spec)
    n = args.n or configured_sample_n(spec)
    sampled = db.sample(n=n)
    append_round_log(run_dir, "db_sample", {"n": n, "algorithm": configured_algorithm})
    return emit_json({"nodes": [node.to_dict() for node in sampled]})


def cmd_db_record(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    spec = require_evolve_ready(run_dir)
    db = build_database(run_dir, spec)
    snapshot = BestSnapshotManager(Path(run_dir) / "steps")
    workspace_root = workspace_root_for_run(run_dir)

    source_code = Path(args.code_path)
    if not source_code.is_absolute():
        source_code = (workspace_root / source_code).resolve()
    ensure_path_allowed(run_dir, source_code)

    step_name = args.step_name
    step_dir = Path(run_dir) / "steps" / step_name
    step_dir.mkdir(parents=True, exist_ok=True)
    step_code_path = step_dir / "code"
    if source_code != step_code_path:
        shutil.copyfile(source_code, step_code_path)
    code = step_code_path.read_text(encoding="utf-8")

    results: Dict[str, Any] = {}
    if args.results_file:
        results_path = Path(args.results_file)
        if not results_path.is_absolute():
            results_path = (workspace_root / results_path).resolve()
        if results_path.exists():
            ensure_path_allowed(run_dir, results_path)
            results = json.loads(results_path.read_text(encoding="utf-8"))
            if results_path != step_dir / "results.json":
                shutil.copyfile(results_path, step_dir / "results.json")

    analysis = args.analysis or ""
    if args.analysis_file:
        analysis_path = Path(args.analysis_file)
        if not analysis_path.is_absolute():
            analysis_path = (workspace_root / analysis_path).resolve()
        ensure_path_allowed(run_dir, analysis_path)
        analysis = analysis_path.read_text(encoding="utf-8")
    if analysis:
        (step_dir / "analysis.md").write_text(analysis, encoding="utf-8")

    score = args.score
    if score is None:
        score = float(results.get("score", results.get("eval_score", 0.0)))

    node = Node(
        name=args.name,
        parent=args.parent or [],
        motivation=args.motivation or "",
        code=code,
        results=results,
        analysis=analysis,
        score=score,
        meta_info={"step_name": step_name},
    )
    node_id, previous_nodes = db.add_with_previous_nodes(node)
    snapshot.init_from_nodes(previous_nodes)
    node_file = step_dir / "node.json"
    node_file.write_text(json.dumps(node.to_dict(), ensure_ascii=False, indent=2), encoding="utf-8")
    best_updated = snapshot.update_if_better(node, step_name=step_name, source_step_dir=step_dir)
    if best_updated:
        run_best_dir = Path(run_dir) / "best" / step_name
        run_best_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(step_code_path, run_best_dir / "code")
        results_copy = step_dir / "results.json"
        if results_copy.exists():
            shutil.copyfile(results_copy, run_best_dir / "results.json")
    append_round_log(
        run_dir,
        "db_record",
        {"node_id": node_id, "name": node.name, "score": node.score, "step_name": step_name},
    )
    return emit_json({"best_updated": best_updated, "node_id": node_id, "step_dir": str(step_dir)})


def cmd_db_best(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    spec = require_evolve_ready(run_dir)
    db = build_database(run_dir, spec)
    nodes = db.get_all()
    if not nodes:
        return emit_json({"best": None})
    best = max(nodes, key=lambda node: node.score)
    return emit_json({"best": best.to_dict()})


def cmd_db_stats(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    spec = require_evolve_ready(run_dir)
    db = build_database(run_dir, spec)
    nodes, sampler_stats = db.snapshot()
    best_score = max((node.score for node in nodes), default=0.0)
    return emit_json(
        {
            "best_score": best_score,
            "sampler_stats": sampler_stats,
            "total_nodes": len(nodes),
        }
    )


def cmd_files_read(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    workspace_root = workspace_root_for_run(run_dir)
    target = Path(args.path)
    if not target.is_absolute():
        target = (workspace_root / target).resolve()
    ensure_path_allowed(run_dir, target)
    return emit_json({"content": target.read_text(encoding="utf-8"), "path": str(target)})


def cmd_files_write(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    require_evolve_ready(run_dir)
    workspace_root = workspace_root_for_run(run_dir)
    target = Path(args.path)
    if not target.is_absolute():
        target = (workspace_root / target).resolve()
    ensure_path_allowed(run_dir, target)

    if args.from_file:
        content_source = Path(args.from_file)
        if not content_source.is_absolute():
            content_source = (workspace_root / content_source).resolve()
        ensure_path_allowed(run_dir, content_source)
        content = content_source.read_text(encoding="utf-8")
    else:
        content = args.content or ""

    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    append_round_log(run_dir, "file_write", {"path": str(target)})
    return emit_json({"bytes_written": len(content.encode("utf-8")), "path": str(target)})


def cmd_files_diff(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    workspace_root = workspace_root_for_run(run_dir)
    left = Path(args.path)
    right = Path(args.other_path)
    if not left.is_absolute():
        left = (workspace_root / left).resolve()
    if not right.is_absolute():
        right = (workspace_root / right).resolve()
    ensure_path_allowed(run_dir, left)
    ensure_path_allowed(run_dir, right)

    diff = "".join(
        unified_diff(
            left.read_text(encoding="utf-8").splitlines(True),
            right.read_text(encoding="utf-8").splitlines(True),
            fromfile=str(left),
            tofile=str(right),
        )
    )
    return emit_json({"diff": diff})


def cmd_summary_final(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir).resolve()
    spec = require_evolve_ready(run_dir)
    db = build_database(run_dir, spec)
    nodes = db.get_all()
    best = max(nodes, key=lambda node: node.score) if nodes else None
    summary_lines = [
        "# Final Summary",
        "",
        f"- Objective: {spec.get('objective', '')}",
        f"- Total nodes: {len(nodes)}",
        f"- Best score: {best.score if best else 0.0}",
        f"- Best node: {best.name if best else 'none'}",
    ]
    if best:
        summary_lines.append(f"- Best motivation: {best.motivation}")
    summary_path = Path(run_dir) / "final_summary.md"
    summary_path.write_text("\n".join(summary_lines) + "\n", encoding="utf-8")
    append_round_log(run_dir, "summary_final", {"path": str(summary_path)})
    return emit_json({"summary_path": str(summary_path)})


def build_brief_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="evolve-brief")
    subparsers = parser.add_subparsers(dest="command", required=True)
    normalize = subparsers.add_parser("normalize")
    normalize.add_argument("--workspace-root")
    normalize.add_argument("--run-name", required=True)
    normalize.add_argument("--spec-file")
    normalize.add_argument("--objective")
    normalize.add_argument("--core-score")
    normalize.add_argument("--secondary-metric", action="append")
    normalize.add_argument("--evaluation-command")
    normalize.add_argument("--evaluation-script-path")
    normalize.add_argument("--evaluation-timeout-secs", type=int)
    normalize.add_argument("--success-criterion", action="append")
    normalize.add_argument("--max-rounds", type=int)
    normalize.add_argument("--patience", type=int)
    normalize.add_argument("--stop-condition", action="append")
    normalize.add_argument("--writable-path", action="append")
    normalize.add_argument("--primary-target", action="append")
    normalize.add_argument("--sampling-algorithm")
    normalize.add_argument("--sample-n", type=int)
    normalize.add_argument("--sampling-feature", action="append")
    normalize.add_argument("--sampling-feature-bins", type=int)
    normalize.add_argument("--sampling-custom-sampler-path")
    normalize.add_argument("--sampling-custom-sampler-class")
    normalize.add_argument("--cognition-source-mode")
    normalize.add_argument("--seed-file", action="append")
    normalize.add_argument("--seed-note", action="append")
    normalize.add_argument("--confirmed", type=parse_bool)
    normalize.set_defaults(func=cmd_brief_normalize)
    return parser


def build_eval_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="evolve-eval")
    subparsers = parser.add_subparsers(dest="command", required=True)
    inspect_cmd = subparsers.add_parser("inspect")
    inspect_cmd.add_argument("--script-path")
    inspect_cmd.add_argument("--command")
    inspect_cmd.set_defaults(func=cmd_eval_inspect)

    run_cmd = subparsers.add_parser("run")
    run_cmd.add_argument("--run-dir", required=True)
    run_cmd.add_argument("--code-path", required=True)
    run_cmd.add_argument("--step-name")
    run_cmd.add_argument("--command")
    run_cmd.add_argument("--script-path")
    run_cmd.add_argument("--timeout", type=int)
    run_cmd.set_defaults(func=cmd_eval_run)
    return parser


def build_cognition_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="evolve-cognition")
    subparsers = parser.add_subparsers(dest="command", required=True)

    init_cmd = subparsers.add_parser("init")
    init_cmd.add_argument("--run-dir", required=True)
    init_cmd.add_argument("--seed-file")
    init_cmd.add_argument("--reset", action="store_true")
    init_cmd.set_defaults(func=cmd_cognition_init)

    add_cmd = subparsers.add_parser("add")
    add_cmd.add_argument("--run-dir", required=True)
    add_cmd.add_argument("--item", action="append")
    add_cmd.add_argument("--json-file")
    add_cmd.add_argument("--kind")
    add_cmd.add_argument("--source")
    add_cmd.set_defaults(func=cmd_cognition_add)

    search_cmd = subparsers.add_parser("search")
    search_cmd.add_argument("--run-dir", required=True)
    search_cmd.add_argument("--query", required=True)
    search_cmd.add_argument("--top-k", type=int, default=5)
    search_cmd.set_defaults(func=cmd_cognition_search)
    return parser


def build_db_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="evolve-db")
    subparsers = parser.add_subparsers(dest="command", required=True)

    sample_cmd = subparsers.add_parser("sample")
    sample_cmd.add_argument("--run-dir", required=True)
    sample_cmd.add_argument("--n", type=int)
    sample_cmd.set_defaults(func=cmd_db_sample)

    record_cmd = subparsers.add_parser("record")
    record_cmd.add_argument("--run-dir", required=True)
    record_cmd.add_argument("--step-name", required=True)
    record_cmd.add_argument("--name", required=True)
    record_cmd.add_argument("--code-path", required=True)
    record_cmd.add_argument("--motivation")
    record_cmd.add_argument("--analysis")
    record_cmd.add_argument("--analysis-file")
    record_cmd.add_argument("--results-file")
    record_cmd.add_argument("--score", type=float)
    record_cmd.add_argument("--parent", type=int, action="append")
    record_cmd.set_defaults(func=cmd_db_record)

    best_cmd = subparsers.add_parser("best")
    best_cmd.add_argument("--run-dir", required=True)
    best_cmd.set_defaults(func=cmd_db_best)

    stats_cmd = subparsers.add_parser("stats")
    stats_cmd.add_argument("--run-dir", required=True)
    stats_cmd.set_defaults(func=cmd_db_stats)
    return parser


def build_files_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="evolve-files")
    subparsers = parser.add_subparsers(dest="command", required=True)

    read_cmd = subparsers.add_parser("read")
    read_cmd.add_argument("--run-dir", required=True)
    read_cmd.add_argument("--path", required=True)
    read_cmd.set_defaults(func=cmd_files_read)

    write_cmd = subparsers.add_parser("write")
    write_cmd.add_argument("--run-dir", required=True)
    write_cmd.add_argument("--path", required=True)
    write_cmd.add_argument("--content")
    write_cmd.add_argument("--from-file")
    write_cmd.set_defaults(func=cmd_files_write)

    diff_cmd = subparsers.add_parser("diff")
    diff_cmd.add_argument("--run-dir", required=True)
    diff_cmd.add_argument("--path", required=True)
    diff_cmd.add_argument("--other-path", required=True)
    diff_cmd.set_defaults(func=cmd_files_diff)
    return parser


def build_summary_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="evolve-summary")
    subparsers = parser.add_subparsers(dest="command", required=True)
    final_cmd = subparsers.add_parser("final")
    final_cmd.add_argument("--run-dir", required=True)
    final_cmd.set_defaults(func=cmd_summary_final)
    return parser


def main_for(entrypoint: str, argv: Optional[List[str]] = None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    parsers = {
        "brief": build_brief_parser,
        "cognition": build_cognition_parser,
        "db": build_db_parser,
        "eval": build_eval_parser,
        "files": build_files_parser,
        "summary": build_summary_parser,
    }
    parser = parsers[entrypoint]()
    args = parser.parse_args(argv)
    return args.func(args)
