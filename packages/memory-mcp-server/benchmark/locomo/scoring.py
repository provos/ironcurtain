"""
Token-level F1 scoring for the LoCoMo benchmark.

Ported from LoCoMo's task_eval/evaluation.py. Uses Porter stemming and
standard text normalization to compute token-level F1 between a predicted
answer and the ground truth.
"""

from __future__ import annotations

import re
import string
import unicodedata
from collections import Counter

from nltk.stem import PorterStemmer

_stemmer = PorterStemmer()

# ---------------------------------------------------------------------------
# Question category names
# ---------------------------------------------------------------------------

ADVERSARIAL_CATEGORY = 5

CATEGORY_NAMES: dict[int, str] = {
    1: "single-hop",
    2: "multi-hop",
    3: "temporal",
    4: "open-domain",
    ADVERSARIAL_CATEGORY: "adversarial",
}

# ---------------------------------------------------------------------------
# Abstention detection phrases
# ---------------------------------------------------------------------------

_ABSTENTION_PHRASES = [
    "i don't know",
    "i do not know",
    "not available",
    "cannot answer",
    "can't answer",
    "no information",
    "unanswerable",
    "not mentioned",
    "not provided",
    "no mention",
    "doesn't mention",
    "does not mention",
    "no evidence",
    "not enough information",
    "unable to answer",
    "unable to determine",
    "cannot determine",
    "can't determine",
]


# ---------------------------------------------------------------------------
# Text normalization (matches LoCoMo paper)
# ---------------------------------------------------------------------------


def normalize_answer(text: str) -> str:
    """Lowercase, remove articles/punctuation/extra-whitespace, NFD normalize."""
    text = unicodedata.normalize("NFD", text)
    text = text.lower()
    # Remove articles
    text = re.sub(r"\b(a|an|the)\b", " ", text)
    # Remove punctuation
    text = text.translate(str.maketrans("", "", string.punctuation))
    # Collapse whitespace
    text = " ".join(text.split())
    return text


def _get_tokens(text: str) -> list[str]:
    """Normalize and stem tokens."""
    normalized = normalize_answer(text)
    return [_stemmer.stem(t) for t in normalized.split()]


# ---------------------------------------------------------------------------
# F1 scoring
# ---------------------------------------------------------------------------


def f1_score(prediction: str, ground_truth: str) -> float:
    """Token-level F1 between normalized prediction and ground truth.

    Uses Porter stemming. Returns 0.0-1.0.
    """
    pred_tokens = _get_tokens(prediction)
    truth_tokens = _get_tokens(ground_truth)

    if not pred_tokens and not truth_tokens:
        return 1.0
    if not pred_tokens or not truth_tokens:
        return 0.0

    common = Counter(pred_tokens) & Counter(truth_tokens)
    num_common = sum(common.values())

    if num_common == 0:
        return 0.0

    precision = num_common / len(pred_tokens)
    recall = num_common / len(truth_tokens)
    return 2 * precision * recall / (precision + recall)


# ---------------------------------------------------------------------------
# Abstention detection
# ---------------------------------------------------------------------------


def is_abstention(response: str) -> bool:
    """Detect whether the response indicates inability to answer."""
    lower = response.lower()
    return any(phrase in lower for phrase in _ABSTENTION_PHRASES)


# ---------------------------------------------------------------------------
# Per-question scoring
# ---------------------------------------------------------------------------


def score_question(
    hypothesis: str,
    answer: str,
    category: int,
    adversarial_answer: str | None = None,
) -> dict:
    """Score a single QA pair.

    Returns:
        {
            "f1": float,           # 0.0 for adversarial
            "correct": bool,       # F1 >= 0.5 for non-adversarial; abstention for adversarial
            "category": int,
            "category_name": str,
            "is_adversarial": bool,
            "abstained": bool,     # only meaningful for adversarial
        }
    """
    is_adv = category == ADVERSARIAL_CATEGORY
    abstained = is_abstention(hypothesis)

    if is_adv:
        return {
            "f1": 0.0,
            "correct": abstained,
            "category": category,
            "category_name": CATEGORY_NAMES.get(category, f"unknown-{category}"),
            "is_adversarial": True,
            "abstained": abstained,
        }

    f1 = f1_score(hypothesis, answer)
    return {
        "f1": f1,
        "correct": f1 >= 0.5,
        "category": category,
        "category_name": CATEGORY_NAMES.get(category, f"unknown-{category}"),
        "is_adversarial": False,
        "abstained": abstained,
    }


# ---------------------------------------------------------------------------
# Aggregate metrics
# ---------------------------------------------------------------------------


def compute_metrics(results: list[dict]) -> dict:
    """Aggregate per-question scores into summary metrics.

    Returns:
        - overall_f1: mean F1 across all non-adversarial questions
        - overall_accuracy: fraction correct (F1>=0.5 or correct abstention)
        - per_category: {category_id: {mean_f1, accuracy, count, category_name}}
        - adversarial_accuracy: fraction of adversarial questions correctly abstained
    """
    if not results:
        return {
            "overall_f1": 0.0,
            "overall_accuracy": 0.0,
            "per_category": {},
            "adversarial_accuracy": 0.0,
            "question_count": 0,
        }

    # Overall accuracy (all categories)
    overall_accuracy = sum(1 for r in results if r["correct"]) / len(results)

    # Non-adversarial F1
    non_adv = [r for r in results if not r["is_adversarial"]]
    overall_f1 = sum(r["f1"] for r in non_adv) / len(non_adv) if non_adv else 0.0

    # Adversarial accuracy
    adv = [r for r in results if r["is_adversarial"]]
    adversarial_accuracy = sum(1 for r in adv if r["correct"]) / len(adv) if adv else 0.0

    # Per-category breakdown
    per_category: dict[int, dict] = {}
    categories = sorted({r["category"] for r in results})
    for cat in categories:
        cat_results = [r for r in results if r["category"] == cat]
        cat_non_adv = [r for r in cat_results if not r["is_adversarial"]]
        mean_f1 = sum(r["f1"] for r in cat_non_adv) / len(cat_non_adv) if cat_non_adv else 0.0
        accuracy = sum(1 for r in cat_results if r["correct"]) / len(cat_results)
        per_category[cat] = {
            "category_name": CATEGORY_NAMES.get(cat, f"unknown-{cat}"),
            "mean_f1": round(mean_f1, 4),
            "accuracy": round(accuracy, 4),
            "count": len(cat_results),
        }

    return {
        "overall_f1": round(overall_f1, 4),
        "overall_accuracy": round(overall_accuracy, 4),
        "per_category": per_category,
        "adversarial_accuracy": round(adversarial_accuracy, 4),
        "question_count": len(results),
    }
