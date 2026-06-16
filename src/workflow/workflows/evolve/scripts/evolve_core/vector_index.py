"""Vector index wrapper with FAISS and pickle-backed fallbacks."""

from __future__ import annotations

import pickle
from pathlib import Path
from threading import RLock
from typing import Dict, List, Optional, Tuple

import numpy as np

try:
    import faiss

    FAISS_AVAILABLE = True
except Exception:
    faiss = None
    FAISS_AVAILABLE = False


class FAISSIndex:
    """Manage semantic retrieval with FAISS when available, else brute force."""

    def __init__(
        self,
        dimension: int = 384,
        index_type: str = "IP",
        storage_path: Optional[Path] = None,
    ):
        self.dimension = dimension
        self.index_type = index_type
        self.storage_path = Path(storage_path) if storage_path else None
        self.lock = RLock()
        self.use_faiss = FAISS_AVAILABLE
        self.id_to_idx: Dict[int, int] = {}
        self.idx_to_id: Dict[int, int] = {}
        self.next_idx = 0
        self.vectors: Dict[int, np.ndarray] = {}

        if self.use_faiss:
            self.index = self._create_faiss_index()
        else:
            self.index = None

        if self.storage_path:
            self._load()

    def add(self, node_id: int, vector: np.ndarray) -> None:
        with self.lock:
            if node_id in self.id_to_idx or node_id in self.vectors:
                return

            normalized = self._normalize(vector.reshape(1, -1).astype(np.float32))[0]
            if self.use_faiss and self.index is not None:
                self.index.add(normalized.reshape(1, -1))
                self.id_to_idx[node_id] = self.next_idx
                self.idx_to_id[self.next_idx] = node_id
                self.next_idx += 1
            else:
                self.vectors[node_id] = normalized

    def search(
        self,
        query_vector: np.ndarray,
        top_k: int = 5,
        score_threshold: float = 0.0,
    ) -> List[Tuple[int, float]]:
        with self.lock:
            if self.use_faiss and self.index is not None:
                if self.index.ntotal == 0:
                    return []
                query = self._normalize(query_vector.reshape(1, -1).astype(np.float32))
                k = min(top_k, self.index.ntotal)
                scores, indices = self.index.search(query, k)
                results: List[Tuple[int, float]] = []
                for score, idx in zip(scores[0], indices[0]):
                    if idx < 0 or score < score_threshold:
                        continue
                    node_id = self.idx_to_id.get(int(idx))
                    if node_id is not None:
                        results.append((node_id, float(score)))
                return results

            if not self.vectors:
                return []

            query = self._normalize(query_vector.reshape(1, -1).astype(np.float32))[0]
            scored: List[Tuple[int, float]] = []
            for node_id, vector in self.vectors.items():
                if self.index_type == "IP":
                    score = float(np.dot(query, vector))
                else:
                    score = -float(np.linalg.norm(query - vector))
                if score >= score_threshold:
                    scored.append((node_id, score))
            scored.sort(key=lambda item: item[1], reverse=True)
            return scored[:top_k]

    def remove(self, node_id: int) -> None:
        with self.lock:
            if self.use_faiss and node_id in self.id_to_idx:
                idx = self.id_to_idx.pop(node_id)
                self.idx_to_id.pop(idx, None)
            self.vectors.pop(node_id, None)

    def save(self) -> None:
        if not self.storage_path:
            return

        with self.lock:
            self.storage_path.mkdir(parents=True, exist_ok=True)
            if self.use_faiss and self.index is not None:
                faiss.write_index(self.index, str(self.storage_path / "faiss.index"))
                meta = {
                    "id_to_idx": self.id_to_idx,
                    "idx_to_id": self.idx_to_id,
                    "next_idx": self.next_idx,
                    "use_faiss": True,
                    "dimension": self.dimension,
                    "index_type": self.index_type,
                }
                with open(self.storage_path / "faiss_meta.pkl", "wb") as handle:
                    pickle.dump(meta, handle)
            else:
                payload = {
                    "vectors": {node_id: vector.tolist() for node_id, vector in self.vectors.items()},
                    "use_faiss": False,
                    "dimension": self.dimension,
                    "index_type": self.index_type,
                }
                with open(self.storage_path / "vector_store.pkl", "wb") as handle:
                    pickle.dump(payload, handle)

    def reset(self) -> None:
        with self.lock:
            if self.use_faiss:
                self.index = self._create_faiss_index()
                self.id_to_idx.clear()
                self.idx_to_id.clear()
                self.next_idx = 0
            else:
                self.vectors.clear()

            if self.storage_path and self.storage_path.exists():
                for path in self.storage_path.glob("*"):
                    if path.is_file():
                        path.unlink()

    def _load(self) -> None:
        if not self.storage_path:
            return

        faiss_index = self.storage_path / "faiss.index"
        faiss_meta = self.storage_path / "faiss_meta.pkl"
        vector_store = self.storage_path / "vector_store.pkl"

        if self.use_faiss and faiss_index.exists() and faiss_meta.exists():
            try:
                self.index = faiss.read_index(str(faiss_index))
                with open(faiss_meta, "rb") as handle:
                    meta = pickle.load(handle)
                self.id_to_idx = meta.get("id_to_idx", {})
                self.idx_to_id = meta.get("idx_to_id", {})
                self.next_idx = meta.get("next_idx", 0)
                return
            except Exception:
                self.use_faiss = False
                self.index = None

        if vector_store.exists():
            with open(vector_store, "rb") as handle:
                payload = pickle.load(handle)
            self.use_faiss = False
            self.vectors = {
                int(node_id): np.array(vector, dtype=np.float32)
                for node_id, vector in payload.get("vectors", {}).items()
            }

    def _create_faiss_index(self):
        if not self.use_faiss:
            return None
        if self.index_type == "IP":
            return faiss.IndexFlatIP(self.dimension)
        return faiss.IndexFlatL2(self.dimension)

    def _normalize(self, vectors: np.ndarray) -> np.ndarray:
        if self.index_type == "IP":
            norms = np.linalg.norm(vectors, axis=1, keepdims=True)
            norms[norms == 0] = 1.0
            return vectors / norms
        return vectors
