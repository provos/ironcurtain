"""UCB1-based sampling strategy."""

from __future__ import annotations

import math
import random
from typing import List, TYPE_CHECKING

from .base import BaseSampler

if TYPE_CHECKING:
    from ..structures import Node


class UCB1Sampler(BaseSampler):
    def __init__(self, c: float = 1.414):
        self.c = c

    def sample(self, nodes: List["Node"], n: int) -> List["Node"]:
        if not nodes:
            return []

        total_visits = sum(node.visit_count for node in nodes)
        if total_visits == 0:
            selected = random.sample(nodes, min(n, len(nodes)))
            for node in selected:
                node.visit_count += 1
            return selected

        scored_nodes = [node.score for node in nodes if node.visit_count > 0]
        if not scored_nodes:
            selected = random.sample(nodes, min(n, len(nodes)))
            for node in selected:
                node.visit_count += 1
            return selected

        min_score = min(scored_nodes)
        max_score = max(scored_nodes)
        score_range = max(max_score - min_score, 1.0)

        ucb_scores = []
        for node in nodes:
            if node.visit_count == 0:
                value = float("inf")
            else:
                normalized = (node.score - min_score) / score_range
                exploration = self.c * math.sqrt(math.log(total_visits) / node.visit_count)
                value = normalized + exploration
            ucb_scores.append((node, value))

        ucb_scores.sort(key=lambda item: item[1], reverse=True)
        selected = [node for node, _ in ucb_scores[: min(n, len(nodes))]]
        for node in selected:
            node.visit_count += 1
        return selected
