"""Embedding helpers with a graceful local fallback."""

from __future__ import annotations

import math
import re
from typing import List, Union

import numpy as np

try:
    from sentence_transformers import SentenceTransformer

    ST_AVAILABLE = True
except Exception:
    SentenceTransformer = None
    ST_AVAILABLE = False


class EmbeddingService:
    """Encode text with sentence-transformers when available, else hash tokens."""

    def __init__(
        self,
        model_name: str = "sentence-transformers/all-MiniLM-L6-v2",
        device: str = "cpu",
        dimension: int = 384,
    ):
        self.dimension = dimension
        self.model = None

        if ST_AVAILABLE and SentenceTransformer is not None:
            try:
                self.model = SentenceTransformer(model_name, device=device)
                self.dimension = self.model.get_sentence_embedding_dimension()
            except Exception:
                self.model = None

    def encode(
        self,
        texts: Union[str, List[str]],
        normalize: bool = True,
    ) -> np.ndarray:
        if isinstance(texts, str):
            texts = [texts]

        if self.model is not None:
            embeddings = self.model.encode(
                texts,
                normalize_embeddings=normalize,
                show_progress_bar=False,
            )
            return np.array(embeddings, dtype=np.float32)

        vectors = np.vstack([self._fallback_encode_one(text) for text in texts]).astype(
            np.float32
        )
        if normalize:
            vectors = self._normalize(vectors)
        return vectors

    def get_dimension(self) -> int:
        return self.dimension

    def _fallback_encode_one(self, text: str) -> np.ndarray:
        vector = np.zeros(self.dimension, dtype=np.float32)
        tokens = re.findall(r"[A-Za-z0-9_]+", text.lower())
        if not tokens:
            return vector

        for token in tokens:
            hashed = hash(token)
            index = abs(hashed) % self.dimension
            sign = -1.0 if hashed % 2 else 1.0
            weight = 1.0 + math.log1p(len(token))
            vector[index] += sign * weight

        return vector

    @staticmethod
    def _normalize(vectors: np.ndarray) -> np.ndarray:
        norms = np.linalg.norm(vectors, axis=1, keepdims=True)
        norms[norms == 0] = 1.0
        return vectors / norms
