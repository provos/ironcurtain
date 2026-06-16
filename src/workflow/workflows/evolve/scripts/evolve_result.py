#!/usr/bin/env python3
"""Translate evolve_core helper output into IronCurtain result-file verdicts."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _numeric_score(results: dict[str, Any]) -> float | None:
    raw = results.get("eval_score", results.get("score"))
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    return None


def _run_helper(argv: list[str]) -> tuple[int, dict[str, Any] | None, str]:
    completed = subprocess.run(argv, capture_output=True, text=True)
    error = completed.stderr.strip()
    try:
        payload = json.loads(completed.stdout) if completed.stdout.strip() else None
    except json.JSONDecodeError as exc:
        payload = None
        error = f"{error}\ninvalid helper JSON: {exc}".strip()
    return completed.returncode, payload, error


def evaluate(args: argparse.Namespace) -> int:
    result_file = Path(args.result_file)
    helper = SCRIPT_DIR / "evolve-eval"
    helper_return_code, engine, helper_error = _run_helper(
        [
            sys.executable,
            str(helper),
            "run",
            "--run-dir",
            args.run_dir,
            "--code-path",
            args.code_path,
            "--step-name",
            args.step_name,
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
    results_path = Path(engine.get("results_path") or Path(args.run_dir) / "steps" / args.step_name / "results.json")
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    eval_parser = subparsers.add_parser("evaluate")
    eval_parser.add_argument("--run-dir", required=True)
    eval_parser.add_argument("--step-name", required=True)
    eval_parser.add_argument("--code-path", required=True)
    eval_parser.add_argument("--result-file", required=True)
    eval_parser.add_argument("--timeout", type=int, default=30)
    eval_parser.set_defaults(func=evaluate)

    record_parser = subparsers.add_parser("record")
    record_parser.add_argument("--run-dir", required=True)
    record_parser.add_argument("--step-name", required=True)
    record_parser.add_argument("--name", required=True)
    record_parser.add_argument("--code-path", required=True)
    record_parser.add_argument("--results-file", required=True)
    record_parser.add_argument("--result-file", required=True)
    record_parser.set_defaults(func=record)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
