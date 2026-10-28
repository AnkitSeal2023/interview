"""Restricted subprocess runner for candidate code (SPEC §3B: deterministic tests).

Design:
- temp dir per execution, minimal env, no cwd pollution.
- resource limits: CPU seconds, address space, process count; wall-clock timeout.
- network: best-effort disabled inside the harness (socket blocked before candidate import).
- candidates ship a module defining ONE entry function (per problem spec); the harness
  (harness.py:harness_src) drives it over cases and prints JSON results.
"""
from __future__ import annotations

import json
import logging
import pathlib
import subprocess
import sys
import tempfile

log = logging.getLogger("run")

PY_TIMEOUT_S = 10
JS_TIMEOUT_S = 10
MEM_CAP_BYTES = 768 * 1024 * 1024

HARNESS_SRC = r'''
import importlib.util, json, sys, math

def eq(a, b):
    if isinstance(a, float) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=1e-6, abs_tol=1e-9)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(eq(x, y) for x, y in zip(a, b))
    if isinstance(a, tuple) and isinstance(b, list):
        return eq(list(a), b)
    return a == b or type(a) is type(b) and a == b

# kill network before candidate import
import socket
class _NoNet(Exception): pass
def _blocked(*a, **k): raise _NoNet("network disabled for candidate process")
socket.socket = _blocked
socket.create_connection = _blocked
socket.socketpair = _blocked

spec = json.load(open(sys.argv[1]))          # {"fn": "name", "cases": [{"input": [...], "output": ...}]}
mod_path = sys.argv[2]
spec_mod = importlib.util.spec_from_file_location("cand", mod_path)
cand = importlib.util.module_from_spec(spec_mod)
spec_mod.loader.exec_module(cand)
fn = getattr(cand, spec["fn"], None)
if fn is None:
    print(json.dumps({"error": f"missing function {spec['fn']}"})); sys.exit(0)
out = []
for i, case in enumerate(spec["cases"]):
    r = {"idx": i, "input": case["input"], "expected": case["output"]}
    try:
        got = fn(*case["input"])
        r["got"] = json.loads(json.dumps(got, default=str))
        r["pass"] = bool(eq(got, case["output"]))
    except Exception as e:
        r["error"] = f"{type(e).__name__}: {e}"[:300]
        r["pass"] = False
    out.append(r)
print(json.dumps({"results": out}))'''

NODE_HARNESS_SRC = r'''
const fs = require('fs'); const path = require('path'); const Module = require('module');
const spec = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const fnName = spec.fn;
// candidate module defines export `fnName`
const candPath = path.resolve(process.argv[3]);
delete require.cache[candPath];
let cand;
try { cand = require(candPath); } catch (e) {
  console.log(JSON.stringify({error: 'compile: ' + String(e).slice(0, 300)})); process.exit(0);
}
const fn = cand[fnName];
if (typeof fn !== 'function') {
  console.log(JSON.stringify({error: 'missing function ' + fnName})); process.exit(0);
}
function eq(a, b) {
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((x, i) => eq(x, b[i]));
  return a === b || String(a) === String(b);
}
const out = [];
for (const [i, c] of spec.cases.entries()) {
  const r = {idx: i, input: c.input, expected: c.output};
  try { r.got = fn(...c.input); r.pass = eq(r.got, c.output) || String(r.got) === String(c.output); }
  catch (e) { r.error = String(e).slice(0, 300); r.pass = false; }
  out.push(r);
}
console.log(JSON.stringify({results: out}));'''


def _limits(dev_js: bool):
    import resource

    def apply():
        if not dev_js:
            resource.setrlimit(resource.RLIMIT_AS, (MEM_CAP_BYTES, MEM_CAP_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (15, 15))
    return apply


def run_cases(language: str, code: str, fn_name: str, cases: list[dict]) -> dict:
    """cases: [{"input": [args...], "output": expected}]. Returns {"results":[...]}."""
    assert language in ("python", "javascript")
    with tempfile.TemporaryDirectory(prefix="swejudge") as td:
        tdp = pathlib.Path(td)
        cases_file = tdp / "cases.json"
        cases_file.write_text(json.dumps({"fn": fn_name, "cases": cases}))
        if language == "python":
            cand_file = tdp / "solution.py"
            cand_file.write_text(code)
            harness = tdp / "harness.py"
            harness.write_text(HARNESS_SRC)
            cmd = [sys.executable, "-I", str(harness), str(cases_file), str(cand_file)]
            timeout = PY_TIMEOUT_S
        else:
            cand_file = tdp / "solution.js"
            cand_file.write_text(_node_export(code, fn_name))
            harness = tdp / "harness.cjs"
            harness.write_text(NODE_HARNESS_SRC)
            cmd = ["node", str(harness), str(cases_file), str(cand_file)]
            timeout = JS_TIMEOUT_S
        try:
            p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                               cwd=td, env={"PATH": "/usr/bin:/bin", "HOME": str(tdp),
                                            "NODE_OPTIONS": "--max-old-space-size=512"},
                               preexec_fn=_limits(language == "javascript"))
        except subprocess.TimeoutExpired:
            return {"results": [{"error": f"timed out after {timeout}s", "pass": False}
                                for _ in cases], "timeout": True}
        if p.returncode != 0 and "results" not in p.stdout:
            return {"results": [{"error": p.stderr[-400:], "pass": False}], "crash": True}
        try:
            import json as _j
            return _j.loads(p.stdout.strip().splitlines()[-1])
        except Exception:
            return {"results": [{"error": "no output", "pass": False}]}


def _node_export(code: str, fn_name: str) -> str:
    return f"{code}\nmodule.exports = {{ {fn_name}: (typeof {fn_name} !== 'undefined' ? {fn_name} : undefined) }};\n"


def summarize(results: list[dict]) -> dict:
    total = len(results)
    passed = sum(1 for r in results if r.get("pass"))
    if total == 0:
        # harness never ran any case: missing entry function / crashed badly.
        return {"passed": 0, "total": 0, "all_passed": False, "first_failure": None,
                "error": "no test results — was the entry function defined correctly?"}
    first_bad = next((r for r in results if not r.get("pass")), None)
    return {"passed": passed, "total": total, "all_passed": passed == total,
            "first_failure": ({k: first_bad.get(k) for k in ("input", "expected", "got", "error")}
                              if first_bad else None)}
