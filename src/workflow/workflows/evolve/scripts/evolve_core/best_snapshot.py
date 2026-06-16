"""Utilities for persisting the best-scoring step outputs."""

from __future__ import annotations

import json
from pathlib import Path
from threading import Lock
from typing import List, Optional

from .structures import Node


class BestSnapshotManager:
    """Maintain a `steps/best` directory with the strongest snapshots."""

    def __init__(self, steps_dir: Path):
        self.steps_dir = Path(steps_dir)
        self.steps_dir.mkdir(parents=True, exist_ok=True)
        self.best_dir = self.steps_dir / "best"
        self.best_dir.mkdir(parents=True, exist_ok=True)
        self.best_score = float("-inf")
        self._lock = Lock()

    def init_from_nodes(self, nodes: List[Node]) -> None:
        if nodes:
            self.best_score = max(node.score for node in nodes)

    def update_if_better(
        self,
        node: Node,
        step_name: str,
        source_step_dir: Optional[Path] = None,
    ) -> bool:
        with self._lock:
            if node.score <= self.best_score:
                return False
            self.best_score = node.score
            self._write_snapshot(node, step_name, source_step_dir)
            return True

    def _write_snapshot(
        self,
        node: Node,
        step_name: str,
        source_step_dir: Optional[Path],
    ) -> None:
        best_step_dir = self.best_dir / step_name
        best_step_dir.mkdir(parents=True, exist_ok=True)
        (best_step_dir / "code").write_text(node.code or "", encoding="utf-8")

        results_file = best_step_dir / "results.json"
        source_results_file = source_step_dir / "results.json" if source_step_dir else None
        if source_results_file and source_results_file.exists():
            results_file.write_text(
                source_results_file.read_text(encoding="utf-8"),
                encoding="utf-8",
            )
        else:
            results_file.write_text(
                json.dumps(node.results or {}, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
