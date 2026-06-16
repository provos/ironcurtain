"""Island-based sampler with optional diversity features."""

from __future__ import annotations

import ast
import random
import time
from typing import Any, Dict, List, Optional, Set, Tuple, TYPE_CHECKING

from .base import BaseSampler

if TYPE_CHECKING:
    from ..structures import Node


class IslandSampler(BaseSampler):
    def __init__(
        self,
        num_islands: int = 5,
        migration_interval: int = 10,
        migration_rate: float = 0.1,
        exploration_ratio: float = 0.2,
        exploitation_ratio: float = 0.3,
        c: float = 1.414,
        feature_dimensions: Optional[List[str]] = None,
        feature_bins: int = 10,
    ):
        self.num_islands = num_islands
        self.migration_interval = migration_interval
        self.migration_rate = migration_rate
        self.exploration_ratio = exploration_ratio
        self.exploitation_ratio = exploitation_ratio
        self.c = c
        self.feature_dimensions = feature_dimensions or []
        self.feature_bins = feature_bins

        self.islands: List[Set[int]] = [set() for _ in range(num_islands)]
        self.island_generations: List[int] = [0] * num_islands
        self.island_best_nodes: List[Optional[int]] = [None] * num_islands
        self.island_feature_maps: List[Dict[Tuple[int, ...], int]] = [
            {} for _ in range(num_islands)
        ]
        self.feature_stats: Dict[str, Dict[str, Any]] = {}
        self.current_island = 0
        self.last_migration_generation = 0
        self.archive: Set[int] = set()
        self.archive_size = 100
        self.diversity_cache: Dict[int, Dict[str, float]] = {}
        self.diversity_cache_size = 1000
        self.diversity_reference_set: List[str] = []
        self.diversity_reference_size = 20
        self.all_nodes: Dict[int, "Node"] = {}

    def sample(self, nodes: List["Node"], n: int) -> List["Node"]:
        if not nodes:
            return []

        for node in nodes:
            if node.id is not None:
                self.all_nodes[node.id] = node

        if self._should_migrate():
            self._migrate(nodes)

        island_id = self.current_island % self.num_islands
        island_nodes = self._get_island_nodes(island_id, nodes) or nodes
        self.island_generations[island_id] += 1
        self.current_island = (self.current_island + 1) % self.num_islands

        selected: List["Node"] = []
        while len(selected) < min(n, len(island_nodes)):
            roll = random.random()
            if roll < self.exploration_ratio:
                candidate = self._sample_random(island_nodes)
            elif roll < self.exploration_ratio + self.exploitation_ratio:
                candidate = self._sample_from_archive(nodes) or self._sample_weighted(
                    island_nodes
                )
            else:
                candidate = self._sample_weighted(island_nodes)

            if candidate is None or candidate in selected:
                continue
            candidate.visit_count += 1
            selected.append(candidate)

        return selected

    def on_node_added(self, node: "Node") -> None:
        if node.id is None:
            return
        self.all_nodes[node.id] = node
        island_id = node.meta_info.get("island", self.current_island) % self.num_islands
        node.meta_info["island"] = island_id
        self.islands[island_id].add(node.id)
        self._update_archive(node)
        if self.feature_dimensions:
            feature_coords = self._calculate_feature_coords(node)
            if feature_coords is not None:
                self.island_feature_maps[island_id][tuple(feature_coords)] = node.id

    def on_node_removed(self, node: "Node") -> None:
        if node.id is None:
            return
        self.all_nodes.pop(node.id, None)
        island_id = node.meta_info.get("island")
        if island_id is not None and island_id < len(self.islands):
            self.islands[island_id].discard(node.id)
        self.archive.discard(node.id)

    def get_state(self) -> Dict[str, Any]:
        return {
            "archive": list(self.archive),
            "current_island": self.current_island,
            "diversity_cache": {str(key): value for key, value in self.diversity_cache.items()},
            "diversity_reference_set": self.diversity_reference_set,
            "feature_stats": self.feature_stats,
            "island_best_nodes": self.island_best_nodes,
            "island_feature_maps": [
                {str(key): value for key, value in feature_map.items()}
                for feature_map in self.island_feature_maps
            ],
            "island_generations": self.island_generations,
            "last_migration_generation": self.last_migration_generation,
        }

    def load_state(self, state: Dict[str, Any]) -> None:
        self.archive = set(state.get("archive", []))
        self.current_island = state.get("current_island", 0) % self.num_islands
        self.diversity_cache = {
            int(key): value for key, value in state.get("diversity_cache", {}).items()
        }
        self.diversity_reference_set = state.get("diversity_reference_set", [])
        self.feature_stats = state.get("feature_stats", {})
        self.island_best_nodes = state.get("island_best_nodes", [None] * self.num_islands)
        self.island_generations = state.get("island_generations", [0] * self.num_islands)
        self.last_migration_generation = state.get("last_migration_generation", 0)

        feature_maps = []
        for raw_feature_map in state.get("island_feature_maps", []):
            feature_maps.append(
                {ast.literal_eval(key): value for key, value in raw_feature_map.items()}
            )
        if feature_maps:
            self.island_feature_maps = feature_maps

    def rebuild_from_nodes(self, nodes: List["Node"]) -> None:
        self.islands = [set() for _ in range(self.num_islands)]
        self.all_nodes = {node.id: node for node in nodes if node.id is not None}
        self.island_feature_maps = [{} for _ in range(self.num_islands)]

        for node in nodes:
            if node.id is None:
                continue
            island_id = node.meta_info.get("island", 0) % self.num_islands
            self.islands[island_id].add(node.id)
            if self.feature_dimensions:
                coords = self._calculate_feature_coords(node)
                if coords is not None:
                    self.island_feature_maps[island_id][tuple(coords)] = node.id

    def get_island_stats(self, nodes: List["Node"]) -> Dict[str, Any]:
        populations = []
        for island_id in range(self.num_islands):
            island_nodes = self._get_island_nodes(island_id, nodes)
            populations.append(
                {
                    "island_id": island_id,
                    "size": len(island_nodes),
                    "best_score": max((node.score for node in island_nodes), default=0.0),
                }
            )
        return {
            "archive_size": len(self.archive),
            "current_island": self.current_island,
            "island_populations": populations,
            "num_islands": self.num_islands,
        }

    def reset(self) -> None:
        self.islands = [set() for _ in range(self.num_islands)]
        self.island_generations = [0] * self.num_islands
        self.island_best_nodes = [None] * self.num_islands
        self.island_feature_maps = [{} for _ in range(self.num_islands)]
        self.feature_stats.clear()
        self.current_island = 0
        self.last_migration_generation = 0
        self.archive.clear()
        self.diversity_cache.clear()
        self.diversity_reference_set = []

    def _get_island_nodes(self, island_id: int, nodes: List["Node"]) -> List["Node"]:
        return [node for node in nodes if node.id in self.islands[island_id]]

    @staticmethod
    def _sample_random(nodes: List["Node"]) -> Optional["Node"]:
        if not nodes:
            return None
        return random.choice(nodes)

    @staticmethod
    def _sample_weighted(nodes: List["Node"]) -> Optional["Node"]:
        if not nodes:
            return None
        weights = [max(node.score, 0.001) for node in nodes]
        return random.choices(nodes, weights=weights, k=1)[0]

    def _sample_from_archive(self, nodes: List["Node"]) -> Optional["Node"]:
        archive_nodes = [node for node in nodes if node.id in self.archive]
        if not archive_nodes:
            return None
        return random.choice(archive_nodes)

    def _update_archive(self, node: "Node") -> None:
        if node.id is None:
            return
        self.archive.add(node.id)
        if len(self.archive) > self.archive_size:
            self.archive = set(sorted(self.archive)[-self.archive_size :])

    def _calculate_feature_coords(self, node: "Node") -> Optional[List[int]]:
        if not self.feature_dimensions:
            return None

        coords: List[int] = []
        for feature in self.feature_dimensions:
            if feature == "complexity":
                value = float(len(node.code))
            elif feature == "diversity":
                value = self._get_cached_diversity(node)
            else:
                raw_value = node.results.get(feature)
                if not isinstance(raw_value, (int, float)):
                    return None
                value = float(raw_value)

            self._update_feature_stats(feature, value)
            scaled = self._scale_feature_value(feature, value)
            coords.append(max(0, min(self.feature_bins - 1, int(scaled * self.feature_bins))))

        return coords

    def _update_feature_stats(self, feature: str, value: float) -> None:
        stats = self.feature_stats.setdefault(feature, {"min": value, "max": value})
        stats["min"] = min(stats["min"], value)
        stats["max"] = max(stats["max"], value)

    def _scale_feature_value(self, feature: str, value: float) -> float:
        stats = self.feature_stats.get(feature)
        if not stats:
            return 0.5
        if stats["max"] - stats["min"] < 1e-10:
            return 0.5
        return max(0.0, min(1.0, (value - stats["min"]) / (stats["max"] - stats["min"])))

    def _get_cached_diversity(self, node: "Node") -> float:
        if not node.code:
            return 0.0

        code_hash = hash(node.code)
        cached = self.diversity_cache.get(code_hash)
        if cached:
            return cached["value"]

        if (
            not self.diversity_reference_set
            or len(self.diversity_reference_set) < self.diversity_reference_size
        ):
            self._update_diversity_reference_set()

        scores = [
            self._fast_code_diversity(node.code, reference)
            for reference in self.diversity_reference_set
            if reference != node.code
        ]
        diversity = sum(scores) / max(1, len(scores)) if scores else 0.0

        if len(self.diversity_cache) >= self.diversity_cache_size:
            oldest = min(self.diversity_cache.items(), key=lambda item: item[1]["timestamp"])[0]
            del self.diversity_cache[oldest]
        self.diversity_cache[code_hash] = {"timestamp": time.time(), "value": diversity}
        return diversity

    def _update_diversity_reference_set(self) -> None:
        all_programs = [node.code for node in self.all_nodes.values() if node.code]
        self.diversity_reference_set = all_programs[: self.diversity_reference_size]

    @staticmethod
    def _fast_code_diversity(code1: str, code2: str) -> float:
        if code1 == code2:
            return 0.0
        chars = len(set(code1).symmetric_difference(set(code2)))
        return abs(len(code1) - len(code2)) * 0.1 + chars * 0.5

    def _should_migrate(self) -> bool:
        return (
            max(self.island_generations, default=0) - self.last_migration_generation
        ) >= self.migration_interval

    def _migrate(self, nodes: List["Node"]) -> None:
        if self.num_islands < 2:
            return
        self.last_migration_generation = max(self.island_generations, default=0)
        for island_id in range(self.num_islands):
            island_nodes = sorted(
                self._get_island_nodes(island_id, nodes),
                key=lambda node: node.score,
                reverse=True,
            )
            if not island_nodes:
                continue
            count = max(1, int(len(island_nodes) * self.migration_rate))
            for node in island_nodes[:count]:
                if node.id is None:
                    continue
                self.islands[(island_id + 1) % self.num_islands].add(node.id)
