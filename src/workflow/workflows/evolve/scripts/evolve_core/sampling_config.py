"""Shared helpers for run-level sampling configuration."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .algorithms.factory import load_custom_sampler_class


DEFAULT_SAMPLING_ALGORITHM = "ucb1"
DEFAULT_SAMPLE_N = 3
DEFAULT_ISLAND_FEATURE_DIMENSIONS = ["complexity", "diversity"]
DEFAULT_ISLAND_FEATURE_BINS = 10
SAMPLING_CONFIG_IMMUTABLE_ERROR = (
    "Sampling configuration is run-level and cannot change after nodes exist. "
    "Start a new run if you want a different algorithm or island feature setup."
)


def _sampling_section(spec: Dict[str, Any]) -> Dict[str, Any]:
    return spec.get("sampling", {})


def _sampling_algorithm_value(spec: Dict[str, Any]) -> str:
    return str(_sampling_section(spec).get("algorithm", "") or "").strip()


def configured_sampling_algorithm(spec: Dict[str, Any]) -> str:
    return _sampling_algorithm_value(spec) or DEFAULT_SAMPLING_ALGORITHM


def configured_sample_n(spec: Dict[str, Any]) -> int:
    return int(_sampling_section(spec).get("sample_n", DEFAULT_SAMPLE_N) or DEFAULT_SAMPLE_N)


def sampling_config_fingerprint(spec: Dict[str, Any]) -> Dict[str, Any]:
    sampling = _sampling_section(spec)
    return {
        "algorithm": sampling.get("algorithm", DEFAULT_SAMPLING_ALGORITHM),
        "feature_dimensions": list(
            sampling.get("feature_dimensions", []) or DEFAULT_ISLAND_FEATURE_DIMENSIONS
        ),
        "feature_bins": int(sampling.get("feature_bins", DEFAULT_ISLAND_FEATURE_BINS) or DEFAULT_ISLAND_FEATURE_BINS),
        "custom_sampler_path": str(sampling.get("custom_sampler_path", "") or ""),
        "custom_sampler_class": str(sampling.get("custom_sampler_class", "") or ""),
    }


def run_has_recorded_nodes(run_dir: Path) -> bool:
    data_file = Path(run_dir) / "database_data" / "nodes.json"
    if not data_file.exists():
        return False
    try:
        payload = json.loads(data_file.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return True
    return bool(payload.get("nodes", {}))


def resolve_sampling_path(workspace_root: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path.resolve()
    return (Path(workspace_root).resolve() / path).resolve()


def custom_sampler_runtime_config(
    spec: Dict[str, Any],
    workspace_root: Optional[Path] = None,
) -> Dict[str, Any]:
    sampling = _sampling_section(spec)
    custom_path = str(sampling.get("custom_sampler_path", "") or "").strip()
    custom_class = str(sampling.get("custom_sampler_class", "") or "").strip()
    if not custom_path:
        return {}

    resolved_path = (
        resolve_sampling_path(Path(workspace_root), custom_path)
        if workspace_root is not None
        else Path(custom_path).resolve()
    )
    search_paths = [str(resolved_path.parent)]
    if workspace_root is not None:
        search_paths.append(str(Path(workspace_root).resolve()))
    runtime_config: Dict[str, Any] = {
        "custom_sampler_path": str(resolved_path),
        "custom_sampler_search_paths": search_paths,
    }
    if custom_class:
        runtime_config["custom_sampler_class"] = custom_class
    return runtime_config


def build_database_sampling_config(
    spec: Dict[str, Any],
    workspace_root: Path,
) -> Tuple[str, Dict[str, Any]]:
    algorithm = configured_sampling_algorithm(spec)
    if algorithm == "island":
        return (
            algorithm,
            {
                "feature_dimensions": list(
                    _sampling_section(spec).get("feature_dimensions")
                    or DEFAULT_ISLAND_FEATURE_DIMENSIONS
                ),
                "feature_bins": int(
                    _sampling_section(spec).get("feature_bins", DEFAULT_ISLAND_FEATURE_BINS)
                    or DEFAULT_ISLAND_FEATURE_BINS
                ),
            },
        )
    if algorithm == "custom":
        return algorithm, custom_sampler_runtime_config(spec, workspace_root)
    return algorithm, {}


def validate_custom_sampler_for_workspace(
    spec: Dict[str, Any],
    workspace_root: Optional[Path] = None,
) -> str:
    if configured_sampling_algorithm(spec) != "custom":
        return ""

    runtime_config = custom_sampler_runtime_config(spec, workspace_root)
    custom_path = str(_sampling_section(spec).get("custom_sampler_path", "") or "").strip()
    custom_class = str(_sampling_section(spec).get("custom_sampler_class", "") or "").strip()
    if not custom_path or not custom_class:
        return ""

    try:
        load_custom_sampler_class(
            runtime_config["custom_sampler_path"],
            custom_class,
            search_paths=runtime_config.get("custom_sampler_search_paths"),
        )
    except Exception as exc:  # pragma: no cover - surfaced validation path
        return str(exc)
    return ""


def sampling_summary_lines(
    spec: Dict[str, Any],
    workspace_root: Optional[Path] = None,
) -> List[str]:
    sampling = _sampling_section(spec)
    sampling_algorithm = _sampling_algorithm_value(spec) or "(missing)"
    lines = [
        f"- Sampling algorithm: {sampling_algorithm}",
        f"- Sample count: {sampling.get('sample_n', 0)}",
    ]
    if sampling_algorithm == "island":
        feature_dimensions = sampling.get("feature_dimensions", []) or DEFAULT_ISLAND_FEATURE_DIMENSIONS
        lines.extend(
            [
                f"- Island feature dimensions: {', '.join(feature_dimensions)}",
                f"- Island feature bins: {sampling.get('feature_bins', DEFAULT_ISLAND_FEATURE_BINS)}",
                "- Island built-ins: complexity=len(code), diversity=code-difference heuristic",
            ]
        )
    elif sampling_algorithm == "custom":
        lines.extend(
            [
                f"- Custom sampler path: {sampling.get('custom_sampler_path', '') or '(missing)'}",
                f"- Custom sampler class: {sampling.get('custom_sampler_class', '') or '(missing)'}",
            ]
        )
        custom_sampler_error = validate_custom_sampler_for_workspace(spec, workspace_root)
        if custom_sampler_error:
            lines.append(f"- Custom sampler validation error: {custom_sampler_error}")
    return lines
