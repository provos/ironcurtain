"""Helpers for diff-style code edits."""

from __future__ import annotations

import re
from difflib import unified_diff
from typing import List, Optional, Tuple


def extract_diffs(
    llm_response: str,
    pattern: str = r"<<<<<<< SEARCH\n(.*?)=======\n(.*?)>>>>>>> REPLACE",
) -> List[Tuple[str, str]]:
    matches = re.findall(pattern, llm_response, re.DOTALL)
    return [(search.strip("\n"), replace.strip("\n")) for search, replace in matches]


def apply_diff(
    original_code: str,
    llm_response: str,
    pattern: str = r"<<<<<<< SEARCH\n(.*?)=======\n(.*?)>>>>>>> REPLACE",
) -> str:
    diff_blocks = extract_diffs(llm_response, pattern)
    if not diff_blocks:
        raise ValueError("No valid diff blocks found")

    updated_code = original_code
    for search, replace in diff_blocks:
        if search not in updated_code:
            raise ValueError("SEARCH block not found in target text")
        updated_code = updated_code.replace(search, replace, 1)
    return updated_code


def parse_full_rewrite(llm_response: str, language: str = "python") -> Optional[str]:
    pattern = rf"```{language}\n(.*?)```"
    match = re.search(pattern, llm_response, re.DOTALL)
    if match:
        return match.group(1).strip()
    stripped = llm_response.strip()
    return stripped or None


def format_diff_summary(diff_blocks: List[Tuple[str, str]]) -> str:
    parts: List[str] = []
    for search, replace in diff_blocks:
        lines = list(
            unified_diff(
                search.splitlines(),
                replace.splitlines(),
                fromfile="before",
                tofile="after",
                lineterm="",
            )
        )
        parts.append("\n".join(lines))
    return "\n\n".join(parts)
