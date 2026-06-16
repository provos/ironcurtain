#!/usr/bin/env python3
"""Translate evolve_core helper output into IronCurtain result-file verdicts."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DETERMINISTIC_ENV = {**os.environ, "PYTHONHASHSEED": "0"}


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _load_structured(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    try:
        loaded = json.loads(text)
    except json.JSONDecodeError:
        try:
            import yaml
        except Exception as exc:  # pragma: no cover - dependency is present in the workflow image
            raise RuntimeError(f"could not import yaml to read {path}") from exc
        loaded = yaml.safe_load(text)
    if not isinstance(loaded, dict):
        return {}
    return loaded


def _run_dir(args: argparse.Namespace) -> Path:
    return Path(args.run_dir)


def _current_dir(run_dir: Path) -> Path:
    return run_dir / "current"


def _clear_current_round(current_dir: Path) -> None:
    for name in ("step_name", "context.json", "sample.json", "result.json", "analysis.md", "analysis_record.json"):
        (current_dir / name).unlink(missing_ok=True)


def _workspace_relative_for(run_dir: Path, path: Path) -> str:
    workspace_root = run_dir.parent.parent
    try:
        return path.relative_to(workspace_root).as_posix()
    except ValueError:
        return str(path)


def _step_name_from_current(run_dir: Path) -> str:
    return (_current_dir(run_dir) / "step_name").read_text(encoding="utf-8").strip()


def _load_current_context(run_dir: Path) -> dict[str, Any]:
    context_path = _current_dir(run_dir) / "context.json"
    loaded = _load_json(context_path)
    if not isinstance(loaded, dict):
        raise ValueError(f"current context is not a JSON object: {context_path}")
    return loaded


def _resolve_step_name(args: argparse.Namespace) -> str:
    if getattr(args, "step_from_current", False):
        return _step_name_from_current(_run_dir(args))
    if args.step_name is None:
        raise SystemExit("evolve_result: one of --step-name or --step-from-current is required")
    return args.step_name


def _resolve_code_path(args: argparse.Namespace, step_name: str) -> str:
    if getattr(args, "code_from_current", False):
        run_dir = _run_dir(args)
        return _workspace_relative_for(run_dir, run_dir / "steps" / step_name / "code")
    if args.code_path is None:
        raise SystemExit("evolve_result: one of --code-path or --code-from-current is required")
    return args.code_path


def _resolve_results_file(args: argparse.Namespace, step_name: str) -> str:
    if getattr(args, "results_from_current", False):
        run_dir = _run_dir(args)
        return _workspace_relative_for(run_dir, run_dir / "steps" / step_name / "results.json")
    if args.results_file is None:
        raise SystemExit("evolve_result: one of --results-file or --results-from-current is required")
    return args.results_file


def _resolve_round_name(args: argparse.Namespace, step_name: str) -> str:
    if getattr(args, "name_from_current", False):
        try:
            round_num = int(step_name.removeprefix("step_"))
        except ValueError:
            return step_name
        return f"round-{round_num}"
    if args.name is None:
        raise SystemExit("evolve_result: one of --name or --name-from-current is required")
    return args.name


def _resolve_parent(args: argparse.Namespace) -> list[int]:
    if not getattr(args, "parent_from_current", False):
        return list(args.parent or [])
    context = _load_current_context(_run_dir(args))
    parent = context.get("parent")
    if not isinstance(parent, dict):
        return []
    parent_id = parent.get("id")
    if isinstance(parent_id, bool) or not isinstance(parent_id, int):
        return []
    return [parent_id]


def _node_count(run_dir: Path) -> int:
    nodes_path = run_dir / "database_data" / "nodes.json"
    if not nodes_path.exists():
        return 0
    loaded = _load_json(nodes_path)
    if not isinstance(loaded, dict):
        return 0
    nodes = loaded.get("nodes")
    return len(nodes) if isinstance(nodes, dict) else 0


def _cognition_item_count(run_dir: Path) -> int:
    cognition_path = run_dir / "cognition_data" / "cognition.json"
    if not cognition_path.exists():
        return 0
    loaded = _load_json(cognition_path)
    if not isinstance(loaded, dict):
        return 0
    items = loaded.get("items")
    return len(items) if isinstance(items, dict) else 0


def _objective_query(run_dir: Path) -> str:
    spec = _load_structured(run_dir / "run_spec.yaml")
    return str(spec.get("objective", "") or "")


def _numeric_score(results: dict[str, Any]) -> float | None:
    raw = results.get("eval_score", results.get("score"))
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    return None


def _run_helper(argv: list[str]) -> tuple[int, dict[str, Any] | None, str]:
    completed = subprocess.run(argv, capture_output=True, text=True, env=DETERMINISTIC_ENV)
    error = completed.stderr.strip()
    try:
        payload = json.loads(completed.stdout) if completed.stdout.strip() else None
    except json.JSONDecodeError as exc:
        payload = None
        error = f"{error}\ninvalid helper JSON: {exc}".strip()
    return completed.returncode, payload, error


def evaluate(args: argparse.Namespace) -> int:
    result_file = Path(args.result_file)
    step_name = _resolve_step_name(args)
    code_path = _resolve_code_path(args, step_name)
    helper = SCRIPT_DIR / "evolve-eval"
    helper_return_code, engine, helper_error = _run_helper(
        [
            sys.executable,
            str(helper),
            "run",
            "--run-dir",
            args.run_dir,
            "--code-path",
            code_path,
            "--step-name",
            step_name,
            "--timeout",
            str(args.timeout),
        ]
    )

    payload: dict[str, Any] = {}
    if isinstance(engine, dict):
        payload.update(
            {
                "return_code": engine.get("return_code"),
                "success": engine.get("success"),
                "results_path": engine.get("results_path"),
                "step_dir": engine.get("step_dir"),
            }
        )

    if helper_return_code != 0 or not isinstance(engine, dict):
        payload["error"] = helper_error or f"evolve-eval exited with code {helper_return_code}"
        _write_json(result_file, {"verdict": "evaluator_blocked", "payload": payload, "passed": False})
        return 0

    engine_return_code = engine.get("return_code")
    results_path = Path(engine.get("results_path") or Path(args.run_dir) / "steps" / step_name / "results.json")
    results: dict[str, Any] = {}
    if results_path.exists():
        try:
            loaded = _load_json(results_path)
            if isinstance(loaded, dict):
                results = loaded
            else:
                payload["error"] = f"results file is not a JSON object: {results_path}"
        except Exception as exc:
            payload["error"] = f"could not read results file {results_path}: {exc}"
    else:
        payload["error"] = f"results file not found: {results_path}"

    score = _numeric_score(results)
    if score is not None:
        payload["score"] = score

    if engine_return_code == 0 and score is not None:
        verdict = "evaluated"
        passed = True
    else:
        verdict = "evaluator_blocked"
        passed = False
        if "error" not in payload:
            payload["error"] = results.get("error") or f"evaluator returned code {engine_return_code}"

    _write_json(result_file, {"verdict": verdict, "payload": payload, "passed": passed})
    return 0


def sample(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir)
    result_file = Path(args.result_file)
    current_dir = _current_dir(run_dir)
    current_dir.mkdir(parents=True, exist_ok=True)
    _clear_current_round(current_dir)

    seed_payload: dict[str, Any] | None = None
    if _cognition_item_count(run_dir) == 0:
        seed_file = run_dir / "cognition_seed.md"
        if seed_file.exists():
            seed_code, seed_payload, seed_error = _run_helper(
                [
                    sys.executable,
                    str(SCRIPT_DIR / "evolve-cognition"),
                    "init",
                    "--run-dir",
                    args.run_dir,
                    "--seed-file",
                    str(seed_file),
                ]
            )
            if seed_code != 0 or not isinstance(seed_payload, dict):
                _write_json(
                    result_file,
                    {
                        "verdict": "sample_error",
                        "payload": {"stage": "cognition_init", "error": seed_error},
                        "passed": False,
                    },
                )
                return 0

    done_rounds = _node_count(run_dir)
    step_name = f"step_{done_rounds + 1:04d}"
    (current_dir / "step_name").write_text(step_name + "\n", encoding="utf-8")

    sample_code, sample_payload, sample_error = _run_helper(
        [
            sys.executable,
            str(SCRIPT_DIR / "evolve-db"),
            "sample",
            "--run-dir",
            args.run_dir,
            "--n",
            str(args.n),
        ]
    )
    if sample_code != 0 or not isinstance(sample_payload, dict):
        _write_json(
            result_file,
            {
                "verdict": "sample_error",
                "payload": {"stage": "db_sample", "error": sample_error},
                "passed": False,
            },
        )
        return 0

    query = _objective_query(run_dir) if args.query_from_spec else args.query
    cognition_code, cognition_payload, cognition_error = _run_helper(
        [
            sys.executable,
            str(SCRIPT_DIR / "evolve-cognition"),
            "search",
            "--run-dir",
            args.run_dir,
            "--query",
            query,
            "--top-k",
            str(args.top_k),
        ]
    )
    if cognition_code != 0 or not isinstance(cognition_payload, dict):
        _write_json(
            result_file,
            {
                "verdict": "sample_error",
                "payload": {"stage": "cognition_search", "error": cognition_error},
                "passed": False,
            },
        )
        return 0

    sampled_nodes = sample_payload.get("nodes")
    parent = sampled_nodes[0] if isinstance(sampled_nodes, list) and sampled_nodes else None
    matches = cognition_payload.get("matches")
    context = {
        "step_name": step_name,
        "parent": parent if isinstance(parent, dict) else None,
        "cognition": {
            "query": query,
            "matches": matches if isinstance(matches, list) else [],
        },
    }
    context_file = Path(args.context_file)
    _write_json(context_file, context)

    _write_json(
        result_file,
        {
            "verdict": "sampled",
            "payload": {
                "step_name": step_name,
                "parent_id": context["parent"].get("id") if isinstance(context["parent"], dict) else None,
                "cognition_seeded_items": seed_payload.get("total_items") if isinstance(seed_payload, dict) else None,
                "cognition_matches": len(context["cognition"]["matches"]),
            },
            "passed": True,
        },
    )
    return 0


def record(args: argparse.Namespace) -> int:
    result_file = Path(args.result_file)
    helper = SCRIPT_DIR / "evolve-db"
    helper_return_code, engine, helper_error = _run_helper(
        [
            sys.executable,
            str(helper),
            "record",
            "--run-dir",
            args.run_dir,
            "--step-name",
            args.step_name,
            "--name",
            args.name,
            "--code-path",
            args.code_path,
            "--results-file",
            args.results_file,
        ]
    )

    payload: dict[str, Any] = {}
    if isinstance(engine, dict):
        payload.update(
            {
                "node_id": engine.get("node_id"),
                "best_updated": engine.get("best_updated"),
                "step_dir": engine.get("step_dir"),
            }
        )

    if helper_return_code == 0 and isinstance(engine, dict) and engine.get("node_id") is not None:
        verdict = "recorded"
        passed = True
    else:
        verdict = "needs_repair"
        passed = False
        payload["error"] = helper_error or f"evolve-db exited with code {helper_return_code}"

    _write_json(result_file, {"verdict": verdict, "payload": payload, "passed": passed})
    return 0


def attach_analysis(args: argparse.Namespace) -> int:
    result_file = Path(args.result_file)
    step_name = _resolve_step_name(args)
    code_path = _resolve_code_path(args, step_name)
    results_file = _resolve_results_file(args, step_name)
    name = _resolve_round_name(args, step_name)
    parents = _resolve_parent(args)

    argv = [
        sys.executable,
        str(SCRIPT_DIR / "evolve-db"),
        "record",
        "--run-dir",
        args.run_dir,
        "--step-name",
        step_name,
        "--name",
        name,
        "--code-path",
        code_path,
        "--results-file",
        results_file,
        "--analysis-file",
        args.analysis_file,
    ]
    for parent_id in parents:
        argv.extend(["--parent", str(parent_id)])

    helper_return_code, engine, helper_error = _run_helper(argv)

    payload: dict[str, Any] = {"step_name": step_name, "parent": parents}
    if isinstance(engine, dict):
        payload.update(
            {
                "node_id": engine.get("node_id"),
                "best_updated": engine.get("best_updated"),
                "step_dir": engine.get("step_dir"),
            }
        )

    if helper_return_code == 0 and isinstance(engine, dict) and engine.get("node_id") is not None:
        verdict = "recorded"
        passed = True
    else:
        verdict = "needs_repair"
        passed = False
        payload["error"] = helper_error or f"evolve-db exited with code {helper_return_code}"

    _write_json(result_file, {"verdict": verdict, "payload": payload, "passed": passed})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    eval_parser = subparsers.add_parser("evaluate")
    eval_parser.add_argument("--run-dir", required=True)
    eval_parser.add_argument("--step-name")
    eval_parser.add_argument("--step-from-current", action="store_true")
    eval_parser.add_argument("--code-path")
    eval_parser.add_argument("--code-from-current", action="store_true")
    eval_parser.add_argument("--result-file", required=True)
    eval_parser.add_argument("--timeout", type=int, default=30)
    eval_parser.set_defaults(func=evaluate)

    sample_parser = subparsers.add_parser("sample")
    sample_parser.add_argument("--run-dir", required=True)
    sample_parser.add_argument("--query", default="")
    sample_parser.add_argument("--query-from-spec", action="store_true")
    sample_parser.add_argument("--top-k", type=int, default=5)
    sample_parser.add_argument("--n", type=int, default=1)
    sample_parser.add_argument("--context-file", required=True)
    sample_parser.add_argument("--result-file", required=True)
    sample_parser.set_defaults(func=sample)

    record_parser = subparsers.add_parser("record")
    record_parser.add_argument("--run-dir", required=True)
    record_parser.add_argument("--step-name", required=True)
    record_parser.add_argument("--name", required=True)
    record_parser.add_argument("--code-path", required=True)
    record_parser.add_argument("--results-file", required=True)
    record_parser.add_argument("--result-file", required=True)
    record_parser.set_defaults(func=record)

    attach_parser = subparsers.add_parser("attach_analysis")
    attach_parser.add_argument("--run-dir", required=True)
    attach_parser.add_argument("--step-name")
    attach_parser.add_argument("--step-from-current", action="store_true")
    attach_parser.add_argument("--name")
    attach_parser.add_argument("--name-from-current", action="store_true")
    attach_parser.add_argument("--parent", type=int, action="append")
    attach_parser.add_argument("--parent-from-current", action="store_true")
    attach_parser.add_argument("--code-path")
    attach_parser.add_argument("--code-from-current", action="store_true")
    attach_parser.add_argument("--results-file")
    attach_parser.add_argument("--results-from-current", action="store_true")
    attach_parser.add_argument("--analysis-file", required=True)
    attach_parser.add_argument("--result-file", required=True)
    attach_parser.set_defaults(func=attach_analysis)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
