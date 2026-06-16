"""Persistent node database for skill-driven evolution runs."""

from __future__ import annotations

import copy
import json
import os
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from threading import RLock
from typing import Any, Dict, List, Optional, Tuple

from .algorithms import get_sampler
from .embedding import EmbeddingService
from .file_lock import InterProcessFileLock
from .structures import Node
from .vector_index import FAISSIndex


class Database:
    """Persistent experiment database with sampler pluggability."""

    def __init__(
        self,
        storage_dir: Path,
        embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim: int = 384,
        sampling_algorithm: str = "ucb1",
        sampling_kwargs: Optional[Dict[str, Any]] = None,
        faiss_index_type: str = "IP",
        max_size: Optional[int] = None,
    ):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.lock_path = self.storage_dir / ".database.lock"
        self.nodes: Dict[int, Node] = {}
        self.next_id = 0
        self.max_size = max_size
        self.embedding_dim = embedding_dim
        self.faiss_index_type = faiss_index_type
        self.embedding = EmbeddingService(
            model_name=embedding_model,
            dimension=embedding_dim,
        )
        self.sampling_algorithm = sampling_algorithm
        self.sampling_kwargs = sampling_kwargs or {}
        self.default_sampler = get_sampler(sampling_algorithm, **self.sampling_kwargs)
        self.faiss = self._build_faiss_index()

    def sample(self, n: int, algorithm: Optional[str] = None, **kwargs) -> List[Node]:
        with self._database_guard():
            nodes = list(self.nodes.values())
            sampler = (
                get_sampler(algorithm, **kwargs) if algorithm else self.default_sampler
            )
            selected = sampler.sample(nodes, n)
            self._save_locked()
            return self._clone_nodes(selected)

    def add(self, node: Node) -> int:
        node_id, _ = self.add_with_previous_nodes(node)
        return node_id

    def add_with_previous_nodes(self, node: Node) -> Tuple[int, List[Node]]:
        with self._database_guard():
            previous_nodes = self._clone_nodes(self.nodes.values())
            if self.max_size is not None and len(self.nodes) >= self.max_size:
                self._remove_worst_node_locked()

            node.id = self.next_id
            self.next_id += 1
            self.nodes[node.id] = node
            if hasattr(self.default_sampler, "on_node_added"):
                self.default_sampler.on_node_added(node)

            context_text = node.get_context_text()
            if context_text:
                vector = self.embedding.encode(context_text)
                self.faiss.add(node.id, vector)

            self._save_locked()
            return node.id, previous_nodes

    def get_all(self) -> List[Node]:
        with self._database_guard():
            return self._clone_nodes(self.nodes.values())

    def get(self, node_id: int) -> Optional[Node]:
        with self._database_guard():
            node = self.nodes.get(node_id)
            if node is None:
                return None
            return self._clone_node(node)

    def remove(self, node_id: int) -> bool:
        with self._database_guard():
            if node_id not in self.nodes:
                return False
            node = self.nodes[node_id]
            if hasattr(self.default_sampler, "on_node_removed"):
                self.default_sampler.on_node_removed(node)
            del self.nodes[node_id]
            self.faiss.remove(node_id)
            self._save_locked()
            return True

    def reset(self) -> None:
        with self._database_guard(refresh=False):
            if hasattr(self.default_sampler, "reset"):
                self.default_sampler.reset()
            self.nodes.clear()
            self.next_id = 0
            self.faiss.reset()
            data_file = self.storage_dir / "nodes.json"
            if data_file.exists():
                data_file.unlink()

    def get_sampler_stats(self) -> Optional[Dict[str, Any]]:
        _, sampler_stats = self.snapshot()
        return sampler_stats

    def snapshot(self) -> Tuple[List[Node], Optional[Dict[str, Any]]]:
        with self._database_guard():
            return self._clone_nodes(self.nodes.values()), self._get_sampler_stats_locked()

    def _remove_worst_node_locked(self) -> None:
        if not self.nodes:
            return
        worst_id = min(self.nodes, key=lambda node_id: (self.nodes[node_id].score, node_id))
        node = self.nodes[worst_id]
        if hasattr(self.default_sampler, "on_node_removed"):
            self.default_sampler.on_node_removed(node)
        del self.nodes[worst_id]
        self.faiss.remove(worst_id)

    def _save_locked(self) -> None:
        payload = {
            "next_id": self.next_id,
            "nodes": {str(node_id): node.to_dict() for node_id, node in self.nodes.items()},
        }
        if hasattr(self.default_sampler, "get_state"):
            payload["sampler_state"] = self.default_sampler.get_state()

        temp_path: Optional[Path] = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.storage_dir,
                prefix="nodes.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.flush()
                os.fsync(handle.fileno())
                temp_path = Path(handle.name)

            os.replace(temp_path, self.storage_dir / "nodes.json")
        finally:
            if temp_path is not None and temp_path.exists():
                temp_path.unlink(missing_ok=True)

        self.faiss.save()

    def _load_locked(self) -> None:
        data_file = self.storage_dir / "nodes.json"
        self.nodes = {}
        self.next_id = 0
        self.default_sampler = get_sampler(self.sampling_algorithm, **self.sampling_kwargs)
        self.faiss = self._build_faiss_index()
        if not data_file.exists():
            return
        with open(data_file, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        self.next_id = payload.get("next_id", 0)
        for node_id, node_data in payload.get("nodes", {}).items():
            self.nodes[int(node_id)] = Node.from_dict(node_data)
        if hasattr(self.default_sampler, "load_state") and "sampler_state" in payload:
            self.default_sampler.load_state(payload["sampler_state"])
        if hasattr(self.default_sampler, "rebuild_from_nodes"):
            self.default_sampler.rebuild_from_nodes(list(self.nodes.values()))

    def _build_faiss_index(self) -> FAISSIndex:
        return FAISSIndex(
            dimension=self.embedding_dim,
            index_type=self.faiss_index_type,
            storage_path=self.storage_dir / "faiss",
        )

    def _get_sampler_stats_locked(self) -> Optional[Dict[str, Any]]:
        if hasattr(self.default_sampler, "get_island_stats"):
            return self.default_sampler.get_island_stats(list(self.nodes.values()))
        return None

    @staticmethod
    def _clone_node(node: Node) -> Node:
        return Node.from_dict(copy.deepcopy(node.to_dict()))

    def _clone_nodes(self, nodes: List[Node] | Any) -> List[Node]:
        return [self._clone_node(node) for node in nodes]

    @contextmanager
    def _database_guard(self, refresh: bool = True):
        with self.lock:
            with InterProcessFileLock(self.lock_path):
                if refresh:
                    self._load_locked()
                hold_ms = int(os.environ.get("EVOLVE_DB_TEST_HOLD_LOCK_MS", "0") or 0)
                if hold_ms > 0:
                    time.sleep(hold_ms / 1000.0)
                yield

    def __len__(self) -> int:
        return len(self.get_all())
