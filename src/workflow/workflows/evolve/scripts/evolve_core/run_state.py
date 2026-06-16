"""Run-spec persistence, preflight gating, and path guards."""

from __future__ import annotations

import copy
import json
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import yaml

from .sampling_config import (
    DEFAULT_ISLAND_FEATURE_BINS,
    DEFAULT_ISLAND_FEATURE_DIMENSIONS,
    sampling_summary_lines,
    validate_custom_sampler_for_workspace as validate_sampling_custom_sampler_for_workspace,
)


DEFAULT_RUN_SPEC: Dict[str, Any] = {
    "objective": "",
    "evaluation": {
        "core_score": "",
        "secondary_metrics": [],
        "command": "",
        "script_path": "",
        "timeout_secs": 0,
        "success_criteria": [],
    },
    "budget": {
        "max_rounds": 0,
        "patience": 0,
    },
    "stop_conditions": [],
    "mutation_scope": {
        "writable_paths": [],
        "primary_targets": [],
    },
    "sampling": {
        "algorithm": "ucb1",
        "sample_n": 3,
        "feature_dimensions": list(DEFAULT_ISLAND_FEATURE_DIMENSIONS),
        "feature_bins": DEFAULT_ISLAND_FEATURE_BINS,
        "custom_sampler_path": "",
        "custom_sampler_class": "",
    },
    "cognition": {
        "source_mode": "",
        "seed_files": [],
        "seed_notes": [],
    },
    "approval": {
        "confirmed": False,
    },
}

REQUIRED_FIELD_CHECKS = {
    "objective": lambda spec: bool(str(spec.get("objective", "")).strip()),
    "evaluation.core_score": lambda spec: bool(
        str(spec.get("evaluation", {}).get("core_score", "")).strip()
    ),
    "evaluation.command_or_script": lambda spec: bool(
        str(spec.get("evaluation", {}).get("command", "")).strip()
        or str(spec.get("evaluation", {}).get("script_path", "")).strip()
    ),
    "evaluation.timeout_secs": lambda spec: int(
        spec.get("evaluation", {}).get("timeout_secs", 0) or 0
    )
    > 0,
    "evaluation.success_criteria": lambda spec: bool(
        spec.get("evaluation", {}).get("success_criteria")
    ),
    "budget.max_rounds": lambda spec: int(spec.get("budget", {}).get("max_rounds", 0) or 0)
    > 0,
    "budget.patience": lambda spec: int(spec.get("budget", {}).get("patience", 0) or 0) >= 0,
    "stop_conditions": lambda spec: bool(spec.get("stop_conditions")),
    "mutation_scope.writable_paths": lambda spec: bool(
        spec.get("mutation_scope", {}).get("writable_paths")
    ),
    "mutation_scope.primary_targets": lambda spec: bool(
        spec.get("mutation_scope", {}).get("primary_targets")
    ),
    "sampling.algorithm": lambda spec: bool(
        str(spec.get("sampling", {}).get("algorithm", "")).strip()
    ),
    "sampling.sample_n": lambda spec: int(spec.get("sampling", {}).get("sample_n", 0) or 0) > 0,
    "sampling.custom_sampler": lambda spec: (
        str(spec.get("sampling", {}).get("algorithm", "")).strip() != "custom"
        or (
            bool(str(spec.get("sampling", {}).get("custom_sampler_path", "")).strip())
            and bool(str(spec.get("sampling", {}).get("custom_sampler_class", "")).strip())
        )
    ),
    "cognition.source_mode": lambda spec: bool(
        str(spec.get("cognition", {}).get("source_mode", "")).strip()
    ),
}


def default_run_spec() -> Dict[str, Any]:
    return copy.deepcopy(DEFAULT_RUN_SPEC)


def deep_merge(base: Dict[str, Any], override: Dict[str, Any]) -> Dict[str, Any]:
    merged = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = deep_merge(merged[key], value)
        else:
            merged[key] = copy.deepcopy(value)
    return merged


def build_run_dir(workspace_root: Path, run_name: str) -> Path:
    return Path(workspace_root).resolve() / ".evolve_runs" / run_name


def ensure_run_layout(run_dir: Path) -> Dict[str, Path]:
    run_dir = Path(run_dir).resolve()
    layout = {
        "run_dir": run_dir,
        "best": run_dir / "best",
        "cognition_data": run_dir / "cognition_data",
        "database_data": run_dir / "database_data",
        "steps": run_dir / "steps",
    }
    run_dir.mkdir(parents=True, exist_ok=True)
    for path in layout.values():
        path.mkdir(parents=True, exist_ok=True)
    round_log = run_dir / "round_log.jsonl"
    if not round_log.exists():
        round_log.write_text("", encoding="utf-8")
    return layout


def workspace_root_for_run(run_dir: Path) -> Path:
    run_dir = Path(run_dir).resolve()
    return run_dir.parent.parent


def spec_path(run_dir: Path) -> Path:
    return Path(run_dir) / "run_spec.yaml"


def load_run_spec(run_dir: Path) -> Dict[str, Any]:
    path = spec_path(run_dir)
    if not path.exists():
        return default_run_spec()
    with open(path, "r", encoding="utf-8") as handle:
        loaded = yaml.safe_load(handle) or {}
    return deep_merge(default_run_spec(), loaded)


def save_run_spec(run_dir: Path, spec: Dict[str, Any]) -> Path:
    path = spec_path(run_dir)
    with open(path, "w", encoding="utf-8") as handle:
        yaml.safe_dump(spec, handle, allow_unicode=True, sort_keys=False)
    return path


def normalize_spec_path(workspace_root: Path, raw_path: str) -> str:
    path = Path(raw_path)
    if not path.is_absolute():
        return raw_path.replace("\\", "/")

    resolved = path.resolve()
    workspace_root = Path(workspace_root).resolve()
    try:
        return resolved.relative_to(workspace_root).as_posix()
    except ValueError:
        return str(resolved)


def resolve_path(workspace_root: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path.resolve()
    return (Path(workspace_root).resolve() / path).resolve()


def compute_missing_fields(spec: Dict[str, Any]) -> List[str]:
    return compute_missing_fields_for_workspace(spec)


def compute_missing_fields_for_workspace(
    spec: Dict[str, Any],
    workspace_root: Optional[Path] = None,
) -> List[str]:
    missing = []
    for field, check in REQUIRED_FIELD_CHECKS.items():
        if not check(spec):
            missing.append(field)
    custom_sampler_error = validate_custom_sampler_for_workspace(spec, workspace_root)
    if custom_sampler_error:
        missing.append("sampling.custom_sampler_valid")
    return missing


def validate_custom_sampler_for_workspace(
    spec: Dict[str, Any],
    workspace_root: Optional[Path] = None,
) -> str:
    return validate_sampling_custom_sampler_for_workspace(spec, workspace_root)


def write_preflight_summary(run_dir: Path, spec: Dict[str, Any]) -> Path:
    workspace_root = workspace_root_for_run(run_dir)
    missing = compute_missing_fields_for_workspace(spec, workspace_root)
    confirmed = bool(spec.get("approval", {}).get("confirmed", False))
    status = "READY" if confirmed and not missing else "PENDING"
    lines = [
        "# Preflight Summary",
        "",
        f"- Status: `{status}`",
        f"- Objective: {spec.get('objective', '') or '(missing)'}",
        f"- Core score: {spec.get('evaluation', {}).get('core_score', '') or '(missing)'}",
        f"- Secondary metrics: {', '.join(spec.get('evaluation', {}).get('secondary_metrics', [])) or '(none)'}",
        f"- Evaluation command: {spec.get('evaluation', {}).get('command', '') or '(missing)'}",
        f"- Evaluation script: {spec.get('evaluation', {}).get('script_path', '') or '(missing)'}",
        f"- Evaluation timeout (s): {spec.get('evaluation', {}).get('timeout_secs', 0) or '(missing)'}",
        f"- Success criteria: {', '.join(spec.get('evaluation', {}).get('success_criteria', [])) or '(missing)'}",
        f"- Budget: max_rounds={spec.get('budget', {}).get('max_rounds', 0)}, patience={spec.get('budget', {}).get('patience', 0)}",
        f"- Stop conditions: {', '.join(spec.get('stop_conditions', [])) or '(missing)'}",
        f"- Writable paths: {', '.join(spec.get('mutation_scope', {}).get('writable_paths', [])) or '(missing)'}",
        f"- Primary targets: {', '.join(spec.get('mutation_scope', {}).get('primary_targets', [])) or '(missing)'}",
        *sampling_summary_lines(spec, workspace_root),
        f"- Cognition source mode: {spec.get('cognition', {}).get('source_mode', '') or '(missing)'}",
        f"- Cognition seed files: {', '.join(spec.get('cognition', {}).get('seed_files', [])) or '(none)'}",
        f"- Cognition seed notes: {', '.join(spec.get('cognition', {}).get('seed_notes', [])) or '(none)'}",
        f"- Approval confirmed: {confirmed}",
    ]
    lines.extend(
        [
            "",
            "## Missing fields",
        ]
    )
    if missing:
        lines.extend([f"- {field}" for field in missing])
    else:
        lines.append("- none")

    path = Path(run_dir) / "preflight_summary.md"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


def initialize_cognition_seed_file(run_dir: Path, spec: Dict[str, Any]) -> Path:
    path = Path(run_dir) / "cognition_seed.md"
    if path.exists():
        return path

    notes = spec.get("cognition", {}).get("seed_notes", [])
    lines = [
        "# Cognition Seed Draft",
        "",
        f"- source_mode: {spec.get('cognition', {}).get('source_mode', '') or 'pending'}",
        "- Fill this file during preflight and keep the JSON blocks machine-readable.",
        "",
        "## Notes",
    ]
    if notes:
        lines.extend([f"- {note}" for note in notes])
    else:
        lines.append("- Add user-provided or approved research notes here.")
    lines.extend(
        [
            "",
            "## JSON seeds",
            "",
            "```json",
            "[",
            '  {',
            '    "content": "Replace this with a reusable heuristic or observation.",',
            '    "source": "user",',
            '    "metadata": {"kind": "heuristic"}',
            "  }",
            "]",
            "```",
            "",
        ]
    )
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def require_evolve_ready(run_dir: Path) -> Dict[str, Any]:
    spec = load_run_spec(run_dir)
    missing = compute_missing_fields_for_workspace(spec, workspace_root_for_run(run_dir))
    if missing:
        raise ValueError(
            "Preflight is incomplete. Missing fields: " + ", ".join(missing)
        )
    if not spec.get("approval", {}).get("confirmed", False):
        raise PermissionError("Preflight is not confirmed yet.")
    return spec


def ensure_path_allowed(run_dir: Path, target_path: Path) -> Path:
    spec = load_run_spec(run_dir)
    run_dir = Path(run_dir).resolve()
    target_path = Path(target_path).resolve()

    if target_path.is_relative_to(run_dir):
        return target_path

    workspace_root = workspace_root_for_run(run_dir)
    allowed_paths = spec.get("mutation_scope", {}).get("writable_paths", [])
    resolved_roots = [resolve_path(workspace_root, raw_path) for raw_path in allowed_paths]

    for allowed_root in resolved_roots:
        if target_path.is_relative_to(allowed_root):
            return target_path

    raise PermissionError(
        f"Path is outside the approved mutation scope: {target_path}"
    )


def append_round_log(run_dir: Path, event: str, payload: Dict[str, Any]) -> Path:
    entry = {
        "timestamp": datetime.now().isoformat(),
        "event": event,
        "payload": payload,
    }
    path = Path(run_dir) / "round_log.jsonl"
    with open(path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return path


def load_structured_file(path: Path) -> Dict[str, Any]:
    path = Path(path)
    if path.suffix.lower() == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def flatten_list(values: Iterable[str] | None) -> List[str]:
    if not values:
        return []
    return [value for value in values if value]
