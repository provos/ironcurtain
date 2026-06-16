"""Greedy sampling strategy."""

from __future__ import annotations

from typing import List, TYPE_CHECKING

from .base import BaseSampler

if TYPE_CHECKING:
    from ..structures import Node


class GreedySampler(BaseSampler):
    def sample(self, nodes: List["Node"], n: int) -> List["Node"]:
        if not nodes:
            return []
        return sorted(nodes, key=lambda node: node.score, reverse=True)[:n]
