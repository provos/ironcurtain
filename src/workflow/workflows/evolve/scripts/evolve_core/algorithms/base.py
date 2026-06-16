"""Base interface for node samplers."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, TYPE_CHECKING

if TYPE_CHECKING:
    from ..structures import Node


class BaseSampler(ABC):
    @abstractmethod
    def sample(self, nodes: List["Node"], n: int) -> List["Node"]:
        raise NotImplementedError

    def on_node_added(self, node: "Node") -> None:
        return None

    def on_node_removed(self, node: "Node") -> None:
        return None
