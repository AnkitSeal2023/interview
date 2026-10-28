"""Round B (DSA) endpoints: open→problem, run samples, submit to hidden tests."""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.authz import get_round, owned_session
from app.db import execute, fetchall, fetchone
from app.services import code_run, conductor, dsa_gen, roundsvc

router = APIRouter()


class Submission(BaseModel):
    language: str = "python"        # python|javascript
    code: str


@router.post("/rounds/{round_id}/dsa/problem")
def create_problem(request: Request, round_id: uuid.UUID):
    raise HTTPException(410, "coding exercises are disabled; use the conversational DSA round")
    r = get_round(round_id)
    if r is None or r["round_type"] != "B":
        raise HTTPException(404, "DSA round not found")
    session = owned_session(request, r["session_id"])
    if r["meta"].get("problem_qid"):
        return roundsvc.round_state(str(round_id))
    level = session.get("level") or "entry"
    topics = ((session.get("resume_structured") or {}).get("skills") or [])[:6]
    role = session.get("role") or (session.get("resume_structured") or {}).get("inferred_target_role")
    prob, provenance = dsa_gen.generate_problem(level, topics or None, role,
                                               session_id=str(round_id))
    payload = {k: prob.get(k) for k in
               ("title", "statement", "fn_name", "signature", "samples",
                "difficulty", "expected_complexity")}
    payload["provenance"] = provenance
    qid = roundsvc.add_question(str(round_id), "dsa", ",".join(prob.get("topics") or []),
                                prob.get("difficulty"), payload)
    tests_meta = json.dumps({"hidden": prob["hidden"], "fn_name": prob["fn_name"],
                             "provenance": provenance})
    meta = fetchone("SELECT meta FROM rounds WHERE id=%s", (round_id,))["meta"] or {}
    meta[str(qid)] = {"tests": {"hidden": prob["hidden"], "fn_name": prob["fn_name"],
                                "provenance": provenance}}
    meta["problem_qid"] = str(qid)
    execute("UPDATE rounds SET meta = %s WHERE id = %s", (meta, round_id))
    return roundsvc.round_state(str(round_id))


@router.post("/questions/{question_id}/run")
def run_samples(request: Request, question_id: uuid.UUID, sub: Submission):
    raise HTTPException(410, "code execution is disabled; explain your approach conversationally")
    q = fetchone("SELECT q.*, r.session_id, r.id AS rid FROM questions q "
                 "JOIN rounds r ON r.id=q.round_id WHERE q.id=%s", (question_id,))
    if q is None:
        raise HTTPException(404, "question not found")
    owned_session(request, q["session_id"])
    if q["kind"] != "dsa":
        raise HTTPException(400, "not a DSA question")
    if sub.language not in ("python", "javascript"):
        raise HTTPException(422, "language must be python or javascript")
    samples = (q["payload"] or {}).get("samples") or []
    res = code_run.run_cases(sub.language, sub.code, q["payload"]["fn_name"], samples)
    return {"results": res, "summarized": code_run.summarize(res.get("results", []))}


@router.post("/questions/{question_id}/submit")
def submit(request: Request, question_id: uuid.UUID, sub: Submission):
    raise HTTPException(410, "code submission is disabled; explain your approach conversationally")
    q = fetchone("SELECT q.*, r.session_id, r.id AS rid FROM questions q "
                 "JOIN rounds r ON r.id=q.round_id WHERE q.id=%s", (question_id,))
    if q is None:
        raise HTTPException(404, "question not found")
    session = owned_session(request, q["session_id"])
    if q["kind"] != "dsa":
        raise HTTPException(400, "not a DSA question")
    meta = (fetchone("SELECT meta->%s AS t FROM rounds WHERE id=%s",
                     (str(question_id), q["rid"])) or {}).get("t") or {}
    tests = meta if isinstance(meta, dict) else json.loads(meta)
    tests = tests.get("tests", {})
    if not tests.get("hidden"):
        raise HTTPException(409, "no hidden tests stored for this question")
    cases = [{"input": c["input"], "output": c["output"]} for c in tests["hidden"]]
    res = code_run.run_cases(sub.language, sub.code, tests["fn_name"], cases)
    summ = code_run.summarize(res.get("results", []))
    sid_out = execute(
        """INSERT INTO code_submissions (id, question_id, language, code, test_results,
                                        passed, runtime_ms)
           VALUES (%s, %s, %s, %s, %s, %s, 0) RETURNING id""",
        (uuid.uuid4(), question_id, sub.language, sub.code, json.dumps(summ), summ["all_passed"]))
    # after automatic judging, the interviewer now asks the explanation question (oral)
    expl_q = conductor.next_question(
        str(q["rid"]), session, session["resume_structured"] or {},
        wrap_up=False) if _no_open_dsa_followup(str(q["rid"])) else None
    if expl_q:
        roundsvc.add_question(str(q["rid"]), "oral", "dsa-explanation", "medium",
                              {"text": _explain_prompt(expl_q["question"], summ,
                                                       prob_title=(q["payload"] or {})
                                                       .get("title", "")),
                               "is_followup": True, "probe_reason": "code explanation"})
    return {"submission_id": str(sid_out["id"]), "summary": summ}


def _no_open_dsa_followup(rid: str) -> bool:
    return not fetchone("SELECT 1 FROM questions WHERE round_id=%s AND kind='oral' "
                        "AND payload->>'is_followup'='true'", (rid,))


def _explain_prompt(base_q: str, summary: dict, prob_title: str) -> str:
    passed = summary["passed"]
    total = summary["total"]
    tone = "all tests passed" if summary["all_passed"] else (
        f"{passed}/{total} tests passed")
    return (f"Thanks, code submitted ({tone} on automated tests). "
            f"Now explain: {base_q}")


@router.get("/questions/{question_id}/submission")
def last_submission(request: Request, question_id: uuid.UUID):
    q = fetchone("SELECT q.round_id, r.session_id FROM questions q JOIN rounds r "
                 "ON r.id=q.round_id WHERE q.id=%s", (question_id,))
    if q is None:
        raise HTTPException(404, "not found")
    owned_session(request, q["session_id"])
    row = fetchone("SELECT created_at, language, test_results, passed, runtime_ms "
                   "FROM code_submissions WHERE question_id=%s ORDER BY created_at DESC LIMIT 1",
                   (question_id,))
    return row or None
