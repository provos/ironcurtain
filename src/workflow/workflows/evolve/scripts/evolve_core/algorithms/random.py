"""Random sampling strategy."""

from __future__ import annotations

import random
from typing import List, TYPE_CHECKING

from .base import BaseSampler

if TYPE_CHECKING:
    from ..structures import Node


class RandomSampler(BaseSampler):
    def sample(self, nodes: List["Node"], n: int) -> List["Node"]:
        if not nodes:
            return []
        return random.sample(nodes, min(n, len(nodes)))
