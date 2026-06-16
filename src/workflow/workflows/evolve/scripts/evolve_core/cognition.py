"""Persistent cognition store with semantic retrieval."""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from threading import RLock
from typing import Dict, List, Optional, Tuple

from .embedding import EmbeddingService
from .structures import CognitionItem
from .vector_index import FAISSIndex


class Cognition:
    """Persistent cognition store with embedding-backed retrieval."""

    def __init__(
        self,
        storage_dir: Path,
        embedding_model: str = "sentence-transformers/all-MiniLM-L6-v2",
        embedding_dim: int = 384,
        retrieval_top_k: int = 5,
        score_threshold: float = 0.3,
        faiss_index_type: str = "IP",
    ):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.lock = RLock()
        self.retrieval_top_k = retrieval_top_k
        self.score_threshold = score_threshold
        self.items: Dict[str, CognitionItem] = {}
        self.embedding = EmbeddingService(
            model_name=embedding_model,
            dimension=embedding_dim,
        )
        self.faiss = FAISSIndex(
            dimension=embedding_dim,
            index_type=faiss_index_type,
            storage_path=self.storage_dir / "faiss",
        )
        self.str_to_int: Dict[str, int] = {}
        self.int_to_str: Dict[int, str] = {}
        self.next_int_id = 0
        self._load()

    def add(self, item: CognitionItem) -> str:
        with self.lock:
            if not item.id:
                item.id = str(uuid.uuid4())
            self.items[item.id] = item
            if item.content:
                int_id = self._get_int_id(item.id)
                self.faiss.add(int_id, self.embedding.encode(item.content))
            self._save()
            return item.id

    def add_batch(self, items: List[CognitionItem]) -> List[str]:
        return [self.add(item) for item in items]

    def search(self, query: str, top_k: Optional[int] = None) -> List[CognitionItem]:
        return [item for item, _ in self.retrieve(query, top_k=top_k)]

    def retrieve(
        self,
        query: str,
        top_k: Optional[int] = None,
        score_threshold: Optional[float] = None,
    ) -> List[Tuple[CognitionItem, float]]:
        top_k = top_k or self.retrieval_top_k
        threshold = self.score_threshold if score_threshold is None else score_threshold
        results = self.faiss.search(self.embedding.encode(query), top_k, threshold)

        enriched: List[Tuple[CognitionItem, float]] = []
        for int_id, score in results:
            item_id = self.int_to_str.get(int_id)
            if item_id and item_id in self.items:
                enriched.append((self.items[item_id], score))
        return enriched

    def get_all(self) -> List[CognitionItem]:
        return list(self.items.values())

    def reset(self) -> None:
        with self.lock:
            self.items.clear()
            self.str_to_int.clear()
            self.int_to_str.clear()
            self.next_int_id = 0
            self.faiss.reset()
            data_file = self.storage_dir / "cognition.json"
            if data_file.exists():
                data_file.unlink()

    def _get_int_id(self, item_id: str) -> int:
        if item_id not in self.str_to_int:
            self.str_to_int[item_id] = self.next_int_id
            self.int_to_str[self.next_int_id] = item_id
            self.next_int_id += 1
        return self.str_to_int[item_id]

    def _save(self) -> None:
        payload = {
            "items": {item_id: item.to_dict() for item_id, item in self.items.items()},
            "str_to_int": self.str_to_int,
            "int_to_str": {str(key): value for key, value in self.int_to_str.items()},
            "next_int_id": self.next_int_id,
        }
        with open(self.storage_dir / "cognition.json", "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        self.faiss.save()

    def _load(self) -> None:
        data_file = self.storage_dir / "cognition.json"
        if not data_file.exists():
            return
        with open(data_file, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        for item_id, raw_item in payload.get("items", {}).items():
            self.items[item_id] = CognitionItem.from_dict(raw_item)
        self.str_to_int = payload.get("str_to_int", {})
        self.int_to_str = {int(key): value for key, value in payload.get("int_to_str", {}).items()}
        self.next_int_id = payload.get("next_int_id", 0)

    def __len__(self) -> int:
        return len(self.items)
