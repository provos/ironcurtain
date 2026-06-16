"""Factory for sampler implementations."""

from __future__ import annotations

import hashlib
import importlib.util
from pathlib import Path
import sys

from .base import BaseSampler
from .greedy import GreedySampler
from .island import IslandSampler
from .random import RandomSampler
from .ucb1 import UCB1Sampler


def get_sampler(algorithm: str, **kwargs) -> BaseSampler:
    kwargs = {key: value for key, value in kwargs.items() if value is not None}
    if algorithm == "custom":
        custom_path = str(kwargs.pop("custom_sampler_path", "") or "").strip()
        custom_class = str(kwargs.pop("custom_sampler_class", "") or "").strip()
        custom_search_paths = kwargs.pop("custom_sampler_search_paths", None)
        sampler_class = load_custom_sampler_class(
            custom_path,
            custom_class,
            search_paths=custom_search_paths,
        )
        sampler = sampler_class(**kwargs)
        if not callable(getattr(sampler, "sample", None)):
            raise ValueError(
                f"Custom sampler '{custom_class}' must define a callable sample(nodes, n) method."
            )
        return sampler

    samplers = {
        "greedy": GreedySampler,
        "island": IslandSampler,
        "random": RandomSampler,
        "ucb1": UCB1Sampler,
    }
    if algorithm not in samplers:
        raise ValueError(
            f"Unknown sampling algorithm: {algorithm}. Available: {sorted(samplers)}"
        )
    return samplers[algorithm](**kwargs)


def load_custom_sampler_class(
    custom_path: str,
    custom_class: str,
    search_paths: list[str] | None = None,
):
    if not custom_path or not custom_class:
        raise ValueError(
            "Custom sampling requires both custom_sampler_path and custom_sampler_class."
        )

    path = Path(custom_path)
    if not path.exists():
        raise ValueError(f"Custom sampler path does not exist: {path}")

    module_name = "evolve_custom_sampler_" + hashlib.sha1(str(path).encode("utf-8")).hexdigest()
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise ValueError(f"Unable to load custom sampler module from: {path}")

    module = importlib.util.module_from_spec(spec)
    effective_search_paths: list[str] = []
    for candidate in [str(path.parent), *(search_paths or [])]:
        if candidate and candidate not in effective_search_paths:
            effective_search_paths.append(candidate)

    inserted_paths: list[str] = []
    try:
        for candidate in reversed(effective_search_paths):
            if candidate not in sys.path:
                sys.path.insert(0, candidate)
                inserted_paths.append(candidate)
        spec.loader.exec_module(module)
    finally:
        for candidate in inserted_paths:
            if candidate in sys.path:
                sys.path.remove(candidate)

    sampler_class = getattr(module, custom_class, None)
    if sampler_class is None:
        raise ValueError(
            f"Custom sampler class '{custom_class}' was not found in: {path}"
        )
    return sampler_class
