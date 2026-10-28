"""Small deterministic guards for model-facing and candidate-controlled text."""
from __future__ import annotations

import re


_INJECTION_PATTERNS = (
    r"\bignore\s+(?:all\s+)?(?:previous| prior|above| earlier)\s+instructions\b",
    r"\bdisregard\s+(?:all\s+)?(?:previous| prior|above| earlier)\s+instructions\b",
    r"\boverride\s+(?:the\s+)?(?:system|developer|interview)\s+(?:prompt|instructions|rules)\b",
    r"\b(system|developer)\s+prompt\b.{0,30}\b(reveal|show|print|repeat|leak)\b",
    r"\b(?:jailbreak|dan\s+mode|do\s+anything\s+now)\b",
    r"\breturn\s+(?:only\s+)?(?:the\s+)?system\s+prompt\b",
)


def contains_prompt_injection(text: str) -> bool:
    """Detect common instruction-hijacking attempts without sending them to an LLM."""
    value = re.sub(r"\s+", " ", text or "").strip().lower()
    return any(re.search(pattern, value) for pattern in _INJECTION_PATTERNS)
