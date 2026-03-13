"""
Retrieval evaluation metrics for the LoCoMo benchmark.

Scores whether the memory MCP server retrieved the correct evidence
turns, using dia_id tags from the raw recall response to compare
against the ground-truth evidence field.
"""

from __future__ import annotations

import json
import os
import re
import sys

from .scoring import CATEGORY_NAMES

# Matches dia_id tags: dia_id:D1:3
_DIA_ID_RE = re.compile(r"dia_id:(D\d+:\d+)")


def extract_dia_ids_from_tags(all_tags: list[list[str]]) -> set[str]:
    """Extract dia_id values from per-memory tag lists (from raw format)."""
    dia_ids: set[str] = set()
    for tags in all_tags:
        for tag in tags:
            m = _DIA_ID_RE.match(tag)
            if m:
                dia_ids.add(m.group(1))
    return dia_ids


def score_retrieval(
    evidence: list[str],
    *,
    tags: list[list[str]],
) -> dict:
    """Score retrieval for a single question.

    Extracts dia_ids from per-memory tag lists (from raw recall format).

    Returns:
        {
            evidence_recall, evidence_precision, perfect_retrieval,
            retrieved_count, evidence_count, found_count,
        }
    """
    retrieved = extract_dia_ids_from_tags(tags)

    evidence_set = set(evidence)
    found = retrieved & evidence_set

    evidence_count = len(evidence_set)
    found_count = len(found)
    retrieved_count = len(retrieved)

    evidence_recall = found_count / evidence_count if evidence_count > 0 else 1.0
    evidence_precision = found_count / retrieved_count if retrieved_count > 0 else 0.0
    perfect = found_count == evidence_count and evidence_count > 0

    return {
        "evidence_recall": evidence_recall,
        "evidence_precision": evidence_precision,
        "perfect_retrieval": perfect,
        "retrieved_count": retrieved_count,
        "evidence_count": evidence_count,
        "found_count": found_count,
    }


def compute_retrieval_summary(results: list[dict], categories: list[int] | None = None) -> dict:
    """Aggregate per-question retrieval scores into summary metrics."""
    if not results:
        return {
            "mean_evidence_recall": 0.0,
            "mean_evidence_precision": 0.0,
            "perfect_retrieval_rate": 0.0,
            "question_count": 0,
            "per_category": {},
        }

    n = len(results)
    mean_recall = sum(r["evidence_recall"] for r in results) / n
    mean_precision = sum(r["evidence_precision"] for r in results) / n
    perfect_rate = sum(1 for r in results if r["perfect_retrieval"]) / n

    # Per-category breakdown if categories are provided
    per_category: dict[int, dict] = {}
    if categories and len(categories) == len(results):
        cats = sorted(set(categories))
        for cat in cats:
            cat_results = [r for r, c in zip(results, categories) if c == cat]
            if not cat_results:
                continue
            cn = len(cat_results)
            per_category[cat] = {
                "category_name": CATEGORY_NAMES.get(cat, f"unknown-{cat}"),
                "mean_evidence_recall": round(
                    sum(r["evidence_recall"] for r in cat_results) / cn, 4
                ),
                "mean_evidence_precision": round(
                    sum(r["evidence_precision"] for r in cat_results) / cn, 4
                ),
                "perfect_retrieval_rate": round(
                    sum(1 for r in cat_results if r["perfect_retrieval"]) / cn, 4
                ),
                "count": cn,
            }

    return {
        "mean_evidence_recall": round(mean_recall, 4),
        "mean_evidence_precision": round(mean_precision, 4),
        "perfect_retrieval_rate": round(perfect_rate, 4),
        "question_count": n,
        "per_category": per_category,
    }


def print_retrieval_summary(summary: dict) -> None:
    """Print retrieval summary metrics to stderr."""
    print("\n=== Retrieval Summary ===", file=sys.stderr)
    print(
        f"Mean evidence recall:    {summary['mean_evidence_recall']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Mean evidence precision: {summary['mean_evidence_precision']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Perfect retrieval:       {summary['perfect_retrieval_rate']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Questions evaluated:     {summary['question_count']}",
        file=sys.stderr,
    )

    if summary.get("per_category"):
        print("\nPer-category breakdown:", file=sys.stderr)
        for cat_id in sorted(summary["per_category"]):
            cat = summary["per_category"][cat_id]
            print(
                f"  {cat['category_name']:15s}  "
                f"recall={cat['mean_evidence_recall']:.1%}  "
                f"precision={cat['mean_evidence_precision']:.1%}  "
                f"perfect={cat['perfect_retrieval_rate']:.1%}  "
                f"n={cat['count']}",
                file=sys.stderr,
            )

    print(file=sys.stderr, flush=True)


def write_retrieval_summary(run_dir: str, summary: dict) -> str:
    """Write retrieval summary to a JSON file. Returns the output path."""
    path = os.path.join(run_dir, "retrieval-summary.json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")
    print(f"Retrieval summary written to {path}", file=sys.stderr, flush=True)
    return path
