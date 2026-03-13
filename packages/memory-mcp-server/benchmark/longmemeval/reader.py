"""
Reader LLM module for the LongMemEval benchmark harness.

Calls a reader LLM (Gemma3:27b via Ollama's OpenAI-compatible endpoint)
with retrieved context and a question to generate an answer hypothesis.
The prompt template mirrors LongMemEval's run_generation.py.
"""

from __future__ import annotations

import asyncio
import sys

from openai import AsyncOpenAI

from .config import BenchmarkConfig

# ---------------------------------------------------------------------------
# Prompt template (mirrors LongMemEval's run_generation.py)
# ---------------------------------------------------------------------------

READER_SYSTEM = (
    "You are a helpful assistant with access to previous chat history with the user. "
    "Answer the user's question based on the provided information."
)

READER_PROMPT = (
    "Retrieved information from previous conversations:\n{context}\n\n"
    "Current Date: {question_date}\n"
    "Question: {question}\n\n"
    "Answer concisely based on the retrieved information. If the information doesn't "
    "contain the answer, say so."
)

# ---------------------------------------------------------------------------
# Retry constants
# ---------------------------------------------------------------------------

_MAX_RETRIES = 3
_RETRY_BACKOFF_SECONDS = 2.0


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def build_reader_client(config: BenchmarkConfig) -> AsyncOpenAI:
    """Create an AsyncOpenAI client configured for the reader LLM."""
    return AsyncOpenAI(
        base_url=config.reader_base_url,
        api_key=config.reader_api_key,
    )


async def generate_answer(
    context: str,
    question: str,
    question_date: str,
    config: BenchmarkConfig,
    *,
    client: AsyncOpenAI | None = None,
) -> str:
    """Generate an answer hypothesis by calling the reader LLM.

    Retries up to 3 times with exponential backoff on failure.
    Returns an error string rather than raising if all attempts fail.
    """
    if client is None:
        client = build_reader_client(config)

    prompt = READER_PROMPT.format(
        context=context,
        question_date=question_date,
        question=question,
    )

    last_error: Exception | None = None

    for attempt in range(1, _MAX_RETRIES + 1):
        try:
            response = await client.chat.completions.create(
                model=config.reader_model,
                messages=[
                    {"role": "system", "content": READER_SYSTEM},
                    {"role": "user", "content": prompt},
                ],
                temperature=0,
                max_tokens=config.reader_max_tokens,
            )
            content = response.choices[0].message.content
            return content.strip() if content else ""
        except Exception as exc:
            last_error = exc
            if attempt < _MAX_RETRIES:
                wait = _RETRY_BACKOFF_SECONDS * attempt
                print(
                    f"  Reader LLM attempt {attempt}/{_MAX_RETRIES} failed: {exc}. "
                    f"Retrying in {wait:.0f}s...",
                    file=sys.stderr,
                    flush=True,
                )
                await asyncio.sleep(wait)

    error_msg = f"[ERROR: Reader LLM failed after {_MAX_RETRIES} attempts: {last_error}]"
    print(f"  {error_msg}", file=sys.stderr, flush=True)
    return error_msg
