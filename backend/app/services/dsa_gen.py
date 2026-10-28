"""DSA problem generation with GENERATION-TIME cross-validation (D3).

The LLM must ship: statement, function signature, sample + hidden cases, and a reference
solution. We actually RUN the reference against every hidden case in the sandbox before
accepting the problem. 3 strikes -> curated bank fallback. Never LLM-judged-only.
"""
from __future__ import annotations

import json
import logging
import random

from app.services import code_run
from app.services.bank import BANK
from app.llm.provider import LLMError, complete, parse_json

log = logging.getLogger("dsa")

GEN_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "topics": {"type": "array", "items": {"type": "string"}},
        "difficulty": {"type": "string", "enum": ["easy", "medium"]},
        "statement": {"type": "string"},
        "fn_name": {"type": "string"},
        "signature": {"type": "string"},
        "samples": {"type": "array", "items": {"type": "object", "properties": {
            "input": {}, "output": {}}}},
        "hidden": {"type": "array", "items": {"type": "object", "properties": {
            "input": {}, "output": {}}}},
        "reference_py": {"type": "string"},
        "reference_js": {"type": "string"},
        "expected_complexity": {"type": "string"},
    },
    "required": ["title", "statement", "fn_name", "samples", "hidden",
                 "reference_py", "reference_js"],
}

GEN_PROMPT = """Invent ONE practical problem for a {role} interview.
- Level: {level}. {hint}
- Single pure function (no classes, no I/O). Inputs/outputs must be JSON-serializable
  (numbers, strings, booleans, or (nested) lists). `input` in each case is ALWAYS a LIST of
  the function arguments.
- Give 2 sample cases shown to the candidate and {n_hidden} hidden test cases you choose:
  normal cases first, then edge cases (empty/single/negative/duplicates/large-ish, max ~50k
  elements) and tricky-but-defined cases. Output JSON EXACTLY matching this shape:
{{"title": "...", "topics": [...], "difficulty": "easy|medium", "statement":
   "markdown, <=180 words, include constraints and ONE worked example",
 "fn_name": "snake_case_name", "signature": "python-ish type signature",
 "samples": [{{"input": [<args as JSON], "output": <expected JSON>}}, ...],
 "hidden": [...], "reference_py": "full python solution",
 "reference_js": "full plain-nodejs solution as `function name(...){{...}}`",
 "expected_complexity": "expected O(...) with 1-line reason"}}
Rules: exactly one valid optimal approach exists; no ambiguous/undefined behavior; the
reference solutions MUST be correct for every case including hidden ones. Output JSON only."""


def generate_problem(level: str, preferred_topics: list[str],
                     target_role: str | None = None,
                     session_id: str | None = None) -> tuple[dict, str]:
    """Returns (problem dict, provenance 'generated'|'bank'). Validated by execution."""
    hint = (f"Prefer these topics if at all reasonable: {', '.join(preferred_topics)}."
            if preferred_topics else "Any standard interview topic (arrays, hash maps, "
            "strings, two pointers, stacks, simple DP).")
    last_err = None
    for attempt in range(3):
        try:
            res = complete("generator", [
                {"role": "system", "content": GEN_PROMPT.format(level=level, hint=hint,
                                                                role=target_role or "general professional",
                                                                n_hidden=8)},
            ], json_schema=GEN_SCHEMA, session_id=session_id)
            prob = _normalize(parse_json(res.text))
        except (LLMError, ValueError) as e:
            last_err = e
            log.warning("gen attempt %d failed: %s", attempt + 1, e)
            continue
        verdict = _validate(prob)
        if verdict is None:
            prob["provenance"] = "generated"
            return _strip_refs(prob), "generated"
        last_err = verdict
        log.warning("gen attempt %d invalid (%s)", attempt + 1, verdict)
    log.warning("generator falling back to bank after failures: %s", last_err)
    return _strip_refs(random.choice(BANK)), "bank"


def _normalize(p: dict) -> dict:
    p.setdefault("topics", [])
    p.setdefault("difficulty", "medium")
    p.setdefault("expected_complexity", "O(n)")
    if not isinstance(p.get("samples"), list) or not p["samples"]:
        raise ValueError(f"samples must be a non-empty list (got {type(p.get('samples')).__name__})")
    if not isinstance(p.get("hidden"), list) or len(p["hidden"]) < 3:
        raise ValueError(f"hidden must be a list of >=3 cases (got {type(p.get('hidden')).__name__})")
    fn = p["fn_name"] or ""
    if not fn.isidentifier():
        raise ValueError(f"bad fn_name {fn!r}")
    for c in [*p["samples"], *p["hidden"]]:
        if not isinstance(c, dict) or not isinstance(c.get("input"), list):
            raise ValueError(f"sample/hidden case must be an object with an ARG LIST input: "
                             f"{json.dumps(c)[:150]}")
        if "output" not in c:
            raise ValueError(f"case missing output: {json.dumps(c)[:150]}")
    for c in p["hidden"]:
        if len(json.dumps(c["input"])) > 400_000:
            raise ValueError("hidden case too large to store")
    return p


def _validate(p: dict) -> str | None:
    """Run reference solutions against ALL cases. None == valid."""
    cases = [*p["samples"], *p["hidden"]]
    py = code_run.run_cases("python", p.get("reference_py") or "", p["fn_name"], cases)
    bad = [r for r in py.get("results", []) if not r.get("pass")]
    if py.get("results") and len(py["results"]) != len(cases):
        return f"python reference produced {len(py['results'])} results vs {len(cases)} cases"
    if bad:
        return "py reference failed: " + json.dumps(bad[0])[:300]
    js = code_run.run_cases("javascript", _wrap_js(p), p["fn_name"], cases)
    bad = [r for r in js.get("results", []) if not r.get("pass")]
    if js.get("results") and len(js["results"]) != len(cases):
        return f"js reference produced {len(js['results'])} results vs {len(cases)} cases"
    if bad:
        return "js reference failed: " + json.dumps(bad[0])[:300]
    return None


def _wrap_js(p: dict) -> str:
    body = (p.get("reference_js") or "").strip()
    if not body:
        return "function boom(){ throw new Error('no js ref'); }"
    return (f"{body}\nmodule.exports = {{ {p['fn_name']}: (typeof {p['fn_name']} !=="
            f"'undefined' ? {p['fn_name']} : undefined) }};")


def _strip_refs(p: dict) -> dict:
    return {k: v for k, v in p.items() if k not in ("reference_py", "reference_js")}


def pick_bank(side_features: dict | None = None) -> dict:
    return random.choice(BANK)
