"""Core data structures for the Evolve skill runtime."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Dict, List, Optional


@dataclass
class Node:
    """One recorded evolution node."""

    name: str = ""
    created_at: str = ""
    parent: List[int] = field(default_factory=list)
    motivation: str = ""
    code: str = ""
    results: Dict[str, Any] = field(default_factory=dict)
    analysis: str = ""
    meta_info: Dict[str, Any] = field(default_factory=dict)
    id: Optional[int] = None
    visit_count: int = 0
    score: float = 0.0

    def __post_init__(self) -> None:
        if not self.created_at:
            self.created_at = datetime.now().isoformat()

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "created_at": self.created_at,
            "parent": self.parent,
            "motivation": self.motivation,
            "code": self.code,
            "results": self.results,
            "analysis": self.analysis,
            "meta_info": self.meta_info,
            "visit_count": self.visit_count,
            "score": self.score,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Node":
        return cls(
            id=data.get("id"),
            name=data.get("name", ""),
            created_at=data.get("created_at", ""),
            parent=data.get("parent", []),
            motivation=data.get("motivation", ""),
            code=data.get("code", ""),
            results=data.get("results", {}),
            analysis=data.get("analysis", ""),
            meta_info=data.get("meta_info", {}),
            visit_count=data.get("visit_count", 0),
            score=data.get("score", 0.0),
        )

    def get_context_text(self) -> str:
        return " ".join(
            value
            for value in [self.name, self.motivation, self.analysis]
            if value
        )


@dataclass
class CognitionItem:
    """One cognition item stored for semantic retrieval."""

    content: str
    source: str = ""
    metadata: Dict[str, Any] = field(default_factory=dict)
    id: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "content": self.content,
            "source": self.source,
            "metadata": self.metadata,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "CognitionItem":
        return cls(
            id=data.get("id"),
            content=data.get("content", ""),
            source=data.get("source", ""),
            metadata=data.get("metadata", {}),
        )
