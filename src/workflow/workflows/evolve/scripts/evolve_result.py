#!/usr/bin/env python3
"""Translate evolve_core helper output into IronCurtain result-file verdicts."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
DETERMINISTIC_ENV = {**os.environ, "PYTHONHASHSEED": "0"}
IMPROVEMENT_EPS = 1e-9
TARGET_RE = re.compile(
    r"^\s*([A-Za-z_]\w*)\s*(>=|>|==|<=|<)\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?)\s*$"
)
STOCHASTIC_SAMPLERS = {"random", "ucb1", "island"}


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


def _resolve_lane(args: argparse.Namespace) -> int | None:
    raw_lane = getattr(args, "lane", None)
    if raw_lane is None:
        raw_lane = os.environ.get("EVOLVE_LANE")
    if raw_lane is None or raw_lane == "":
        return None
    try:
        lane = int(raw_lane)
    except (TypeError, ValueError) as exc:
        raise SystemExit("evolve_result: --lane / EVOLVE_LANE must be a non-negative integer") from exc
    if lane < 0:
        raise SystemExit("evolve_result: --lane / EVOLVE_LANE must be a non-negative integer")
    return lane


def _current_dir(run_dir: Path, lane: int | None = None) -> Path:
    base = run_dir / "current"
    return base / f"lane_{lane}" if lane is not None else base


def _stop_signals_path(run_dir: Path) -> Path:
    return run_dir / "current" / "stop_signals.json"


def _clear_current_round(run_dir: Path, lane: int | None = None) -> None:
    # stop_signals.json is cleared here so a human "run N more rounds" extension
    # past an early stop does not re-route `complete` on a stale stop_reason from
    # the round that triggered the stop (the human directive resets after one turn).
    current_dir = _current_dir(run_dir, lane)
    names = [
        "step_name",
        "context.json",
        "sample.json",
        "result.json",
        "analysis.md",
        "analysis_record.json",
        "cognition_item.json",
    ]
    if lane is None:
        names.append("stop_signals.json")
    for name in names:
        (current_dir / name).unlink(missing_ok=True)


def _workspace_relative_for(run_dir: Path, path: Path) -> str:
    workspace_root = run_dir.parent.parent
    try:
        return path.relative_to(workspace_root).as_posix()
    except ValueError:
        return str(path)


def _step_name_from_current(run_dir: Path, lane: int | None = None) -> str:
    return (_current_dir(run_dir, lane) / "step_name").read_text(encoding="utf-8").strip()


def _load_current_context(run_dir: Path, lane: int | None = None) -> dict[str, Any]:
    context_path = _current_dir(run_dir, lane) / "context.json"
    loaded = _load_json(context_path)
    if not isinstance(loaded, dict):
        raise ValueError(f"current context is not a JSON object: {context_path}")
    return loaded


def _resolve_step_name(args: argparse.Namespace) -> str:
    if getattr(args, "step_from_current", False):
        return _step_name_from_current(_run_dir(args), _resolve_lane(args))
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
    context = _load_current_context(_run_dir(args), _resolve_lane(args))
    parents = context.get("parents")
    parent_ids: list[int] = []
    for parent in parents if isinstance(parents, list) else []:
        parent_id = parent.get("id") if isinstance(parent, dict) else None
        if isinstance(parent_id, bool) or not isinstance(parent_id, int):
            continue
        parent_ids.append(parent_id)
    return parent_ids


def _node_count(run_dir: Path) -> int:
    return len(_nodes_payload(run_dir))


def _nodes_payload(run_dir: Path) -> dict[str, Any]:
    nodes_path = run_dir / "database_data" / "nodes.json"
    if not nodes_path.exists():
        return {}
    loaded = _load_json(nodes_path)
    if not isinstance(loaded, dict):
        return {}
    nodes = loaded.get("nodes")
    return nodes if isinstance(nodes, dict) else {}


def _node_id(node: dict[str, Any], fallback: str) -> int | None:
    raw = node.get("id")
    if isinstance(raw, bool):
        return None
    if isinstance(raw, int):
        return raw
    try:
        return int(fallback)
    except ValueError:
        return None


def _sorted_nodes(run_dir: Path) -> list[dict[str, Any]]:
    items: list[tuple[int, dict[str, Any]]] = []
    for key, value in _nodes_payload(run_dir).items():
        if not isinstance(value, dict):
            continue
        node_id = _node_id(value, key)
        if node_id is None:
            continue
        items.append((node_id, value))
    return [node for _, node in sorted(items, key=lambda item: item[0])]


def _find_recorded_node_for_step(run_dir: Path, step_name: str) -> dict[str, Any] | None:
    for node in _sorted_nodes(run_dir):
        meta = node.get("meta_info")
        if isinstance(meta, dict) and meta.get("step_name") == step_name:
            return node
    return None


def _safe_int(value: Any, default: int = 0) -> int:
    if isinstance(value, bool) or value is None:
        return default
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value.is_integer():
        return int(value)
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return default
    return default


def _parse_success_target(spec: dict[str, Any]) -> tuple[dict[str, Any] | None, str | None]:
    evaluation = spec.get("evaluation")
    if not isinstance(evaluation, dict):
        return None, "run_spec.yaml has no evaluation object"

    core_score = str(evaluation.get("core_score") or "eval_score")
    raw_criteria = evaluation.get("success_criteria")
    criteria = raw_criteria if isinstance(raw_criteria, list) else []
    for raw in criteria:
        if not isinstance(raw, str):
            continue
        match = TARGET_RE.match(raw)
        if match is None:
            continue
        metric, comparator, threshold = match.groups()
        if metric != core_score:
            continue
        if comparator in {"<", "<="}:
            return None, f"unsupported maximize-only comparator in success criterion: {raw}"
        return (
            {
                "metric": metric,
                "comparator": comparator,
                "threshold": float(threshold),
                "raw": raw,
            },
            None,
        )
    return None, f"no canonical success criterion found for {core_score}"


def _node_score(node: dict[str, Any]) -> float | None:
    raw = node.get("score")
    if isinstance(raw, bool) or raw is None:
        return None
    if isinstance(raw, (int, float)):
        return float(raw)
    return None


def _target_is_met(best_score: float | None, target: dict[str, Any] | None) -> bool:
    if best_score is None or target is None:
        return False
    threshold = float(target["threshold"])
    comparator = target["comparator"]
    if comparator == ">=":
        return best_score + IMPROVEMENT_EPS >= threshold
    if comparator == ">":
        return best_score > threshold + IMPROVEMENT_EPS
    if comparator == "==":
        return abs(best_score - threshold) <= IMPROVEMENT_EPS
    return False


def _compute_stop_signals(run_dir: Path) -> dict[str, Any]:
    spec_path = run_dir / "run_spec.yaml"
    spec = _load_structured(spec_path) if spec_path.exists() else {}
    budget = spec.get("budget")
    if not isinstance(budget, dict):
        budget = {}

    target, target_parse_warning = _parse_success_target(spec)
    max_rounds = _safe_int(budget.get("max_rounds"))
    patience = _safe_int(budget.get("patience"))
    nodes = _sorted_nodes(run_dir)
    warnings: list[str] = []
    best_score: float | None = None
    best_node_id: int | None = None
    rounds_since_improvement = 0

    for index, node in enumerate(nodes):
        node_id = _node_id(node, str(index))
        score = _node_score(node)
        if score is None:
            warnings.append(f"node {node_id if node_id is not None else index} has no numeric score; treated as -inf")

        if score is not None and (best_score is None or score > best_score + IMPROVEMENT_EPS):
            best_score = score
            best_node_id = node_id
            rounds_since_improvement = 0
        elif best_node_id is not None:
            rounds_since_improvement += 1

    done_rounds = len(nodes)
    target_met = _target_is_met(best_score, target)
    patience_exceeded = patience > 0 and rounds_since_improvement >= patience
    max_rounds_reached = max_rounds > 0 and done_rounds >= max_rounds
    if target_met:
        stop_reason = "target_met"
    elif patience_exceeded:
        stop_reason = "patience"
    elif max_rounds_reached:
        stop_reason = "max_rounds"
    else:
        stop_reason = None

    payload: dict[str, Any] = {
        "best_score": best_score,
        "best_node_id": best_node_id,
        "evolution_rounds": done_rounds,
        "rounds_since_improvement": rounds_since_improvement,
        "target": target,
        "target_met": target_met,
        "patience": patience,
        "patience_exceeded": patience_exceeded,
        "done_rounds": done_rounds,
        "max_rounds": max_rounds,
        "stop_reason": stop_reason,
        "improvement_epsilon": IMPROVEMENT_EPS,
    }
    if target_parse_warning is not None:
        payload["target_parse_warning"] = target_parse_warning
    if warnings:
        payload["warnings"] = warnings
    return payload


def _write_stop_signals(run_dir: Path) -> dict[str, Any]:
    signals = _compute_stop_signals(run_dir)
    _write_json(_stop_signals_path(run_dir), signals)
    return signals


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


def _sampling_config(run_dir: Path) -> dict[str, Any]:
    spec_path = run_dir / "run_spec.yaml"
    spec = _load_structured(spec_path) if spec_path.exists() else {}
    sampling = spec.get("sampling")
    return sampling if isinstance(sampling, dict) else {}


def _sample_n_from_spec(run_dir: Path) -> int:
    return max(1, _safe_int(_sampling_config(run_dir).get("sample_n"), default=1))


def _sampling_algorithm(run_dir: Path) -> str:
    # Normalize so the STOCHASTIC_SAMPLERS membership check (and thus the seed
    # requirement) is case/whitespace-insensitive: a spec "UCB1" / " island "
    # must not slip past as non-stochastic and run unseeded.
    algorithm = _sampling_config(run_dir).get("algorithm")
    return str(algorithm or "greedy").strip().lower()


def _sampling_seed(run_dir: Path) -> int | None:
    seed_file = run_dir / "sampling_seed.txt"
    if not seed_file.exists():
        return None
    try:
        return int(seed_file.read_text(encoding="utf-8").strip())
    except ValueError:
        return None


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


def _run_seeded_helper(script_path: Path, helper_args: list[str], seed: int) -> tuple[int, dict[str, Any] | None, str]:
    preamble = (
        "import random, runpy, sys; "
        f"random.seed({seed!r}); "
        f"sys.argv = {[str(script_path), *helper_args]!r}; "
        f"runpy.run_path({str(script_path)!r}, run_name='__main__')"
    )
    return _run_helper([sys.executable, "-c", preamble])


def _promote_lesson(
    run_dir: Path,
    analysis_file: Path,
    step_name: str,
    node_id: Any,
    best_updated: Any,
    lane: int | None = None,
) -> dict[str, Any]:
    if not analysis_file.exists():
        return {"promoted": False, "reason": "no_analysis_file"}
    lesson = analysis_file.read_text(encoding="utf-8").strip()
    if not lesson:
        return {"promoted": False, "reason": "empty_lesson"}
    digest = hashlib.sha256(lesson.encode("utf-8")).hexdigest()
    ledger_path = run_dir / "cognition_promoted.json"
    ledger: Any = {}
    if ledger_path.exists():
        # A crash mid-write can leave the ledger truncated; a corrupt dedup
        # ledger must not fail the whole run — fall back to an empty ledger
        # (worst case: a lesson is promoted twice, which the engine tolerates).
        try:
            ledger = _load_json(ledger_path)
        except (json.JSONDecodeError, OSError):
            ledger = {}
    if not isinstance(ledger, dict):
        ledger = {}
    if digest in ledger:
        return {"promoted": False, "reason": "duplicate", "first_seen": ledger[digest]}

    score: float | None = None
    existing_node = _find_recorded_node_for_step(run_dir, step_name)
    if existing_node is not None:
        score = _node_score(existing_node)
    item = {
        "content": lesson,
        "source": step_name,
        "metadata": {
            "kind": "round_lesson",
            "node_id": node_id,
            "best_updated": bool(best_updated),
            "score": score,
        },
    }
    item_json = _current_dir(run_dir, lane) / "cognition_item.json"
    _write_json(item_json, item)
    code, output, error = _run_helper(
        [
            sys.executable,
            str(SCRIPT_DIR / "evolve-cognition"),
            "add",
            "--run-dir",
            str(run_dir),
            "--json-file",
            str(item_json),
        ]
    )
    if code != 0 or not isinstance(output, dict):
        return {"promoted": False, "reason": "helper_error", "error": error}

    ledger[digest] = step_name
    _write_json(ledger_path, ledger)
    return {
        "promoted": True,
        "items_added": output.get("items_added"),
        "total_items": output.get("total_items"),
    }


def evaluate(args: argparse.Namespace) -> int:
    # Validate --lane / EVOLVE_LANE up front and discard the value: evaluate
    # uses explicit --step-name / --code-path, so it never reads the lane, but
    # we still reject a malformed lane here so no subcommand path can slip past
    # the injection-validation that the --step-from-current path performs.
    _resolve_lane(args)
    result_file = Path(args.result_file)
    step_name = _resolve_step_name(args)
    code_path = _resolve_code_path(args, step_name)
    helper = SCRIPT_DIR / "evolve-eval"
    helper_args = [
        sys.executable,
        str(helper),
        "run",
        "--run-dir",
        args.run_dir,
        "--code-path",
        code_path,
        "--step-name",
        step_name,
    ]
    if args.timeout is not None:
        helper_args.extend(["--timeout", str(args.timeout)])
    helper_return_code, engine, helper_error = _run_helper(helper_args)

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
    lane = _resolve_lane(args)
    result_file = Path(args.result_file)
    current_dir = _current_dir(run_dir, lane)
    current_dir.mkdir(parents=True, exist_ok=True)
    _clear_current_round(run_dir, lane)

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
    if lane is None:
        step_name = f"step_{done_rounds + 1:04d}"
    else:
        step_name = f"step_{done_rounds + 1:04d}_lane_{lane}"
    (current_dir / "step_name").write_text(step_name + "\n", encoding="utf-8")

    n = _sample_n_from_spec(run_dir) if args.n_from_spec else max(1, args.n)
    sampling_algorithm = _sampling_algorithm(run_dir)
    sampling_seed = _sampling_seed(run_dir)
    sample_helper = SCRIPT_DIR / "evolve-db"
    sample_helper_args = [
        "sample",
        "--run-dir",
        args.run_dir,
        "--n",
        str(n),
    ]
    if sampling_algorithm in STOCHASTIC_SAMPLERS:
        if sampling_seed is None:
            seed_file = run_dir / "sampling_seed.txt"
            detail = "exists but is not a single integer" if seed_file.exists() else "is missing"
            _write_json(
                result_file,
                {
                    "verdict": "sample_error",
                    "payload": {
                        "stage": "db_sample",
                        "error": (
                            f"stochastic sampler {sampling_algorithm} requires a sampling_seed.txt "
                            f"with a single integer; the file {detail}"
                        ),
                    },
                    "passed": False,
                },
            )
            return 0
        sample_code, sample_payload, sample_error = _run_seeded_helper(sample_helper, sample_helper_args, sampling_seed)
    else:
        sample_code, sample_payload, sample_error = _run_helper([sys.executable, str(sample_helper), *sample_helper_args])
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
    parents = [node for node in sampled_nodes if isinstance(node, dict)] if isinstance(sampled_nodes, list) else []
    parent_ids = [
        parent_id
        for parent_id in (_node_id(parent, "") for parent in parents)
        if parent_id is not None
    ]
    matches = cognition_payload.get("matches")
    context = {
        "step_name": step_name,
        "parents": parents,
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
                **({"lane": lane} if lane is not None else {}),
                "parent_ids": parent_ids,
                "sample_n": n,
                "sampling_algorithm": sampling_algorithm,
                "sampling_seed": sampling_seed,
                "cognition_seeded_items": seed_payload.get("total_items") if isinstance(seed_payload, dict) else None,
                "cognition_matches": len(context["cognition"]["matches"]),
            },
            "passed": True,
        },
    )
    return 0


def record(args: argparse.Namespace) -> int:
    # Validate --lane / EVOLVE_LANE up front and discard the value: record takes
    # explicit --step-name, so it never reads the lane, but validating here keeps
    # the lane-injection check uniform across every subcommand (see evaluate).
    _resolve_lane(args)
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
    run_dir = _run_dir(args)
    lane = _resolve_lane(args)
    step_name = _resolve_step_name(args)
    existing_node = _find_recorded_node_for_step(run_dir, step_name)
    if existing_node is not None:
        node_id = _node_id(existing_node, "")
        parent = existing_node.get("parent")
        payload: dict[str, Any] = {
            "step_name": step_name,
            "parent": parent if isinstance(parent, list) else [],
            "node_id": node_id,
            "best_updated": False,
            "step_dir": str(run_dir / "steps" / step_name),
            "idempotent_skip": True,
        }
        signals = _write_stop_signals(run_dir)
        payload["stop_reason"] = signals.get("stop_reason")
        payload["stop_signals_path"] = str(_stop_signals_path(run_dir))
        if "target_parse_warning" in signals:
            payload["target_parse_warning"] = signals["target_parse_warning"]
        _write_json(result_file, {"verdict": "recorded", "payload": payload, "passed": True})
        return 0

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

    signals = _write_stop_signals(run_dir)
    payload["stop_reason"] = signals.get("stop_reason")
    payload["stop_signals_path"] = str(_stop_signals_path(run_dir))
    if "target_parse_warning" in signals:
        payload["target_parse_warning"] = signals["target_parse_warning"]
    if verdict == "recorded" and payload.get("node_id") is not None:
        payload["cognition_promoted"] = _promote_lesson(
            run_dir,
            analysis_file=Path(args.analysis_file),
            step_name=step_name,
            node_id=payload.get("node_id"),
            best_updated=payload.get("best_updated"),
            lane=lane,
        )

    _write_json(result_file, {"verdict": verdict, "payload": payload, "passed": passed})
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    def add_lane_argument(subparser: argparse.ArgumentParser) -> None:
        subparser.add_argument("--lane", type=int)

    eval_parser = subparsers.add_parser("evaluate")
    add_lane_argument(eval_parser)
    eval_parser.add_argument("--run-dir", required=True)
    eval_parser.add_argument("--step-name")
    eval_parser.add_argument("--step-from-current", action="store_true")
    eval_parser.add_argument("--code-path")
    eval_parser.add_argument("--code-from-current", action="store_true")
    eval_parser.add_argument("--result-file", required=True)
    eval_parser.add_argument("--timeout", type=int)
    eval_parser.set_defaults(func=evaluate)

    sample_parser = subparsers.add_parser("sample")
    add_lane_argument(sample_parser)
    sample_parser.add_argument("--run-dir", required=True)
    sample_parser.add_argument("--query", default="")
    sample_parser.add_argument("--query-from-spec", action="store_true")
    sample_parser.add_argument("--top-k", type=int, default=5)
    sample_parser.add_argument("--n", type=int, default=1)
    sample_parser.add_argument("--n-from-spec", action="store_true")
    sample_parser.add_argument("--context-file", required=True)
    sample_parser.add_argument("--result-file", required=True)
    sample_parser.set_defaults(func=sample)

    record_parser = subparsers.add_parser("record")
    add_lane_argument(record_parser)
    record_parser.add_argument("--run-dir", required=True)
    record_parser.add_argument("--step-name", required=True)
    record_parser.add_argument("--name", required=True)
    record_parser.add_argument("--code-path", required=True)
    record_parser.add_argument("--results-file", required=True)
    record_parser.add_argument("--result-file", required=True)
    record_parser.set_defaults(func=record)

    attach_parser = subparsers.add_parser("attach_analysis")
    add_lane_argument(attach_parser)
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
