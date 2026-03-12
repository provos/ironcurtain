"""
Judge LLM evaluation module for the LongMemEval benchmark harness.

Ports the judge prompt variants from LongMemEval's evaluate_qa.py exactly.
Supports both Ollama and Anthropic as judge backends via AsyncOpenAI.
Produces per-type and overall accuracy metrics.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
from collections import defaultdict

from openai import AsyncOpenAI
from tqdm import tqdm

from .config import BenchmarkConfig
from .dataset import Question

# ---------------------------------------------------------------------------
# Judge prompt variants (ported verbatim from LongMemEval evaluate_qa.py)
# ---------------------------------------------------------------------------

STANDARD_PROMPT = (
    "I will give you a question, a correct answer, and a response from a model. "
    "You need to determine whether the model's response correctly answers the "
    "question. The response does not need to be an exact match of the correct "
    "answer, but it should contain the key information.\n\n"
    "Question: {question}\n"
    "Correct Answer: {answer}\n"
    "Model Response: {hypothesis}\n\n"
    "Does the model's response correctly answer the question? "
    'Answer with only "yes" or "no".'
)

TEMPORAL_PROMPT = (
    "I will give you a question about time/dates, a correct answer, and a "
    "response from a model. The model's response is considered correct if it "
    "mentions the right time/date or is within 1 day of the correct answer.\n\n"
    "Question: {question}\n"
    "Correct Answer: {answer}\n"
    "Model Response: {hypothesis}\n\n"
    "Does the model's response correctly answer the question? "
    'Answer with only "yes" or "no".'
)

KNOWLEDGE_UPDATE_PROMPT = (
    "I will give you a question, the most up-to-date correct answer, and a "
    "response from a model. The question may involve information that has been "
    "updated over time. The model's response is correct if it provides the most "
    "current answer. It is also acceptable if the model mentions both old and new "
    "information as long as it acknowledges the update.\n\n"
    "Question: {question}\n"
    "Correct Answer: {answer}\n"
    "Model Response: {hypothesis}\n\n"
    "Does the model's response correctly answer the question with the most "
    'up-to-date information? Answer with only "yes" or "no".'
)

PREFERENCE_PROMPT = (
    "I will give you a question that asks for a personalized response based on "
    "user preferences, the correct personalization criteria, and a response from "
    "a model. The model's response is correct if it reflects the user's stated "
    "preferences.\n\n"
    "Question: {question}\n"
    "Correct Personalization: {answer}\n"
    "Model Response: {hypothesis}\n\n"
    "Does the model's response correctly reflect the user's preferences? "
    'Answer with only "yes" or "no".'
)

ABSTENTION_PROMPT = (
    "I will give you a question and a response from a model. The correct "
    "behavior is for the model to indicate that it cannot answer the question or "
    "that the information is not available in the chat history. The model should "
    "NOT make up an answer.\n\n"
    "Question: {question}\n"
    "Model Response: {hypothesis}\n\n"
    "Does the model correctly abstain from answering (e.g., by saying it "
    "doesn't know, the information isn't available, etc.)? "
    'Answer with only "yes" or "no".'
)

# Map question_type to prompt template for non-abstention questions
_TYPE_TO_PROMPT: dict[str, str] = {
    "single-session-user": STANDARD_PROMPT,
    "single-session-assistant": STANDARD_PROMPT,
    "multi-session": STANDARD_PROMPT,
    "temporal-reasoning": TEMPORAL_PROMPT,
    "knowledge-update": KNOWLEDGE_UPDATE_PROMPT,
    "single-session-preference": PREFERENCE_PROMPT,
}

# ---------------------------------------------------------------------------
# Retry constants
# ---------------------------------------------------------------------------

_MAX_RETRIES = 3
_RETRY_BACKOFF_SECONDS = 2.0

# ---------------------------------------------------------------------------
# Prompt selection
# ---------------------------------------------------------------------------


def get_judge_prompt(
    question_id: str,
    question_type: str,
    question: str,
    answer: str,
    hypothesis: str,
) -> str:
    """Select the appropriate judge prompt variant based on question type and ID."""
    if "_abs" in question_id:
        return ABSTENTION_PROMPT.format(question=question, hypothesis=hypothesis)

    template = _TYPE_TO_PROMPT.get(question_type, STANDARD_PROMPT)
    return template.format(question=question, answer=answer, hypothesis=hypothesis)


# ---------------------------------------------------------------------------
# Single-question judging
# ---------------------------------------------------------------------------


def _parse_judge_response(text: str) -> bool:
    """Parse a yes/no response from the judge LLM.

    Returns True if the response contains 'yes', False otherwise.
    """
    cleaned = text.strip().lower()
    if "yes" in cleaned:
        return True
    return False


def _build_judge_client(config: BenchmarkConfig) -> AsyncOpenAI:
    """Create an AsyncOpenAI client configured for the judge LLM."""
    return AsyncOpenAI(
        base_url=config.judge_base_url,
        api_key=config.judge_api_key,
    )


async def judge_one(
    question_id: str,
    question_type: str,
    question: str,
    answer: str,
    hypothesis: str,
    config: BenchmarkConfig,
    *,
    client: AsyncOpenAI | None = None,
) -> bool:
    """Judge a single hypothesis. Returns True if the judge considers it correct.

    Retries up to 3 times with backoff on failure. Defaults to False if
    all attempts fail.
    """
    if client is None:
        client = _build_judge_client(config)
    prompt = get_judge_prompt(question_id, question_type, question, answer, hypothesis)

    last_error: Exception | None = None

    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=config.judge_model,
                messages=[{"role": "user", "content": prompt}],
                temperature=0,
                max_tokens=10,
            )
            content = response.choices[0].message.content or ""
            return _parse_judge_response(content)
        except Exception as exc:
            last_error = exc
            if attempt < _MAX_RETRIES:
                wait = _RETRY_BACKOFF_SECONDS * attempt
                print(
                    f"  Judge attempt {attempt}/{_MAX_RETRIES} failed for "
                    f"{question_id}: {exc}. Retrying in {wait:.0f}s...",
                    file=sys.stderr,
                    flush=True,
                )
                await asyncio.sleep(wait)

    print(
        f"  Judge failed for {question_id} after {_MAX_RETRIES} attempts: "
        f"{last_error}. Defaulting to False.",
        file=sys.stderr,
        flush=True,
    )
    return False


# ---------------------------------------------------------------------------
# Aggregate evaluation
# ---------------------------------------------------------------------------


def _load_hypotheses(path: str) -> dict[str, str]:
    """Load hypotheses from a JSONL file. Returns {question_id: hypothesis}."""
    hypotheses: dict[str, str] = {}
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            entry = json.loads(line)
            hypotheses[entry["question_id"]] = entry["hypothesis"]
    return hypotheses


def _compute_metrics(
    results: list[dict],
) -> dict:
    """Compute overall, per-type, and abstention accuracy from judged results."""
    per_type: dict[str, dict[str, int]] = defaultdict(lambda: {"correct": 0, "total": 0})
    abstention_correct = 0
    abstention_total = 0

    for r in results:
        qtype = r["question_type"]
        label = r["label"]
        is_abstention = "_abs" in r["question_id"]

        per_type[qtype]["total"] += 1
        if label:
            per_type[qtype]["correct"] += 1

        if is_abstention:
            abstention_total += 1
            if label:
                abstention_correct += 1

    total = len(results)
    total_correct = sum(1 for r in results if r["label"])

    overall_accuracy = total_correct / total if total > 0 else 0.0

    per_type_metrics: dict[str, dict] = {}
    type_accuracies: list[float] = []
    for qtype, counts in sorted(per_type.items()):
        acc = counts["correct"] / counts["total"] if counts["total"] > 0 else 0.0
        per_type_metrics[qtype] = {
            "accuracy": acc,
            "correct": counts["correct"],
            "total": counts["total"],
        }
        type_accuracies.append(acc)

    task_averaged = sum(type_accuracies) / len(type_accuracies) if type_accuracies else 0.0

    abstention_accuracy = abstention_correct / abstention_total if abstention_total > 0 else 0.0

    return {
        "overall_accuracy": overall_accuracy,
        "task_averaged_accuracy": task_averaged,
        "per_type": per_type_metrics,
        "abstention_accuracy": abstention_accuracy,
        "results": results,
    }


async def evaluate_all(
    hypotheses_path: str,
    references: list[Question],
    config: BenchmarkConfig,
) -> dict:
    """Evaluate all hypotheses against reference answers using the judge LLM.

    Reads hypotheses from JSONL, judges each one, and returns aggregate metrics.
    Writes eval-results.jsonl and summary.json to the run directory.
    """
    hypotheses = _load_hypotheses(hypotheses_path)
    ref_by_id = {q.question_id: q for q in references}

    # Match hypotheses to reference questions
    matched = []
    for qid, hyp in hypotheses.items():
        if qid in ref_by_id:
            matched.append((ref_by_id[qid], hyp))
        else:
            print(
                f"  Warning: hypothesis for {qid} has no matching reference, skipping",
                file=sys.stderr,
                flush=True,
            )

    # Judge each hypothesis
    judge_client = _build_judge_client(config)
    results: list[dict] = []
    for ref, hyp in tqdm(matched, desc="Evaluating", file=sys.stderr):
        label = await judge_one(
            question_id=ref.question_id,
            question_type=ref.question_type,
            question=ref.question,
            answer=ref.answer,
            hypothesis=hyp,
            config=config,
            client=judge_client,
        )
        results.append(
            {
                "question_id": ref.question_id,
                "question_type": ref.question_type,
                "hypothesis": hyp,
                "label": label,
            }
        )

    metrics = _compute_metrics(results)

    # Write output files
    _write_eval_results(config, metrics["results"])
    _write_summary(config, metrics)

    return metrics


def _write_eval_results(config: BenchmarkConfig, results: list[dict]) -> None:
    """Write per-question evaluation results to eval-results.jsonl."""
    eval_path = os.path.join(config.run_dir, "eval-results.jsonl")
    os.makedirs(os.path.dirname(eval_path), exist_ok=True)

    with open(eval_path, "w") as f:
        for r in results:
            entry = {
                "question_id": r["question_id"],
                "hypothesis": r["hypothesis"],
                "autoeval_label": {
                    "model": config.judge_model,
                    "label": r["label"],
                },
            }
            json.dump(entry, f)
            f.write("\n")

    print(
        f"Evaluation results written to {eval_path}",
        file=sys.stderr,
        flush=True,
    )


def _write_summary(config: BenchmarkConfig, metrics: dict) -> None:
    """Write aggregate metrics to summary.json."""
    summary_path = os.path.join(config.run_dir, "summary.json")
    os.makedirs(os.path.dirname(summary_path), exist_ok=True)

    # Strip per-question results from the summary (they're in eval-results.jsonl)
    summary = {k: v for k, v in metrics.items() if k != "results"}
    summary["judge_model"] = config.judge_model
    summary["judge_provider"] = config.judge_provider

    with open(summary_path, "w") as f:
        json.dump(summary, f, indent=2)
        f.write("\n")

    # Print summary to stderr
    print("\n=== Evaluation Summary ===", file=sys.stderr)
    print(
        f"Overall accuracy:      {metrics['overall_accuracy']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Task-averaged accuracy: {metrics['task_averaged_accuracy']:.1%}",
        file=sys.stderr,
    )
    print(
        f"Abstention accuracy:   {metrics['abstention_accuracy']:.1%}",
        file=sys.stderr,
    )
    print("\nPer-type breakdown:", file=sys.stderr)
    for qtype, vals in sorted(metrics["per_type"].items()):
        print(
            f"  {qtype:30s}  {vals['accuracy']:.1%}  ({vals['correct']}/{vals['total']})",
            file=sys.stderr,
        )
    print(f"\nSummary written to {summary_path}", file=sys.stderr, flush=True)
