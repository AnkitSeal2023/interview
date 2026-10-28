"""Interview session + round A flow endpoints."""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.authz import candidate_id, get_round, owned_session
from app.db import execute, fetchall, fetchone
from app.llm.provider import LLMError
from app.role_profiles import profile_for, public_profiles
from app.security import contains_prompt_injection
from app.services import conductor, resume_struct, roundsvc

router = APIRouter()


@router.get("/roles")
def list_roles():
    return public_profiles()


class StartBody(BaseModel):
    rounds: list[str] = Field(..., min_length=1)          # e.g. ["A","B"]
    durations: dict[str, int] = Field(default_factory=dict)   # {"A":15,...}
    role: str | None = None
    level: str | None = None


class AnswerBody(BaseModel):
    text: str = Field(..., max_length=8000)
    source: str = "text"       # text|stt


class JobDescriptionBody(BaseModel):
    text: str = Field(default="", max_length=20000)


class IdleBody(BaseModel):
    question_id: uuid.UUID
    phase: str = Field(..., pattern="^(nudge|advance)$")


@router.get("/sessions/{session_id}")
def get_session(request: Request, session_id: uuid.UUID):
    row = owned_session(request, session_id)
    return _session_view(row)


@router.post("/sessions/{session_id}/jd")
def update_job_description(
    request: Request,
    session_id: uuid.UUID,
    body: JobDescriptionBody,
):
    owned_session(request, session_id)
    execute(
        "UPDATE sessions SET jd_text=%s, updated_at=now() WHERE id=%s",
        (body.text.strip() or None, session_id),
    )
    return _session_view(fetchone("SELECT * FROM sessions WHERE id = %s", (session_id,)))


@router.post("/resume/{session_id}/structure")
def structure(request: Request, session_id: uuid.UUID):
    """Run resume structuring (LLM-first, heuristic fallback) and store it."""
    row = owned_session(request, session_id)
    text = row.get("resume_text") or ""
    if not text:
        raise HTTPException(400, "session has no resume text")
    structured = resume_struct.structure_resume(str(session_id), text)
    execute("UPDATE sessions SET resume_structured = %s, updated_at = now() WHERE id = %s",
            (structured.model_dump(mode="json"), session_id))
    return _session_view(fetchone("SELECT * FROM sessions WHERE id = %s", (session_id,)))


@router.post("/sessions/{session_id}/start")
def start(request: Request, session_id: uuid.UUID, body: StartBody):
    session = owned_session(request, session_id)
    if any(r not in ("A", "B", "C") for r in body.rounds):
        raise HTTPException(422, "rounds must be subset of A,B,C")
    inferred = (session["resume_structured"] or {}).get("inferred_target_role")
    role = profile_for(body.role, inferred).key
    if "B" in body.rounds and role != "Software Engineer":
        raise HTTPException(
            422,
            "DSA rounds are available only for Software Engineer interviews",
        )
    level = body.level or (session["resume_structured"] or {}).get("inferred_level") or "entry"
    # merge with rounds already created (start may be called again to add rounds later)
    existing = fetchall(
        "SELECT id::text AS id, round_type FROM rounds WHERE session_id = %s ORDER BY seq",
        (session_id,))
    have = {r["round_type"] for r in existing}
    to_create = [r for r in body.rounds if r not in have]
    execute(
        """UPDATE sessions SET rounds=%s, durations=%s, role=COALESCE(%s, role), level=%s,
           status='in_progress', updated_at=now() WHERE id=%s""",
        (json.dumps(sorted(set(have) | set(body.rounds))),
         json.dumps(body.durations), role, level, session_id),
    )
    if not to_create:
        return {"round_id": str(existing[0]["id"]) if existing else None,
                "round_type": existing[0]["round_type"] if existing else None}
    first = roundsvc.new_round(str(session_id), to_create[0], seq=len(existing),
                               budget_min=int(body.durations.get(to_create[0], 15)),
                               status="active" if not existing else "pending")
    for i, rt in enumerate(to_create[1:], start=1):
        roundsvc.new_round(str(session_id), rt, seq=len(existing) + i,
                           budget_min=int(body.durations.get(rt, 15)), status="pending")
    return {"round_id": first, "round_type": to_create[0]}


@router.get("/sessions/{session_id}/rounds")
def list_rounds(request: Request, session_id: uuid.UUID):
    owned_session(request, session_id)
    rows = fetchall("SELECT id, round_type, seq, status FROM rounds WHERE session_id=%s "
                    "ORDER BY seq", (session_id,))
    active = next((r for r in rows if r["status"] in ("active", "paused")), None)
    return [{"round_id": str(r["id"]), "round_type": r["round_type"],
             "status": r["status"], "current": bool(active and r["id"] == active["id"])}
            for r in rows]


@router.get("/rounds/{round_id}")
def get_round_state(request: Request, round_id: uuid.UUID):
    r = get_round(round_id)
    if r is None:
        raise HTTPException(404, "round not found")
    owned_session(request, r["session_id"])
    return roundsvc.round_state(str(round_id))


@router.post("/rounds/{round_id}/open")
def open_round(request: Request, round_id: uuid.UUID):
    """Generate the interview's first question (called right after start).

    Idempotent: React StrictMode double-mounts fire this twice concurrently, so
    the 'opened' marker is claimed atomically (conditional UPDATE first, only the
    winner generates — and pending rounds become active on claiming). If generation
    fails, the claim is released for a retry.
    """
    r = get_round(round_id)
    if r is None:
        raise HTTPException(404, "round not found")
    session = owned_session(request, r["session_id"])
    earlier = fetchone(
        "SELECT id, round_type FROM rounds WHERE session_id=%s AND seq < %s "
        "AND status NOT IN ('completed', 'aborted') ORDER BY seq LIMIT 1",
        (r["session_id"], r["seq"]),
    )
    if earlier:
        raise HTTPException(409, f"complete round {earlier['round_type']} before opening this round")
    structured = session["resume_structured"] or {}
    marker = fetchone("SELECT meta FROM rounds WHERE id=%s", (round_id,))
    question_count = fetchone(
        "SELECT COUNT(*) AS n FROM questions WHERE round_id=%s", (round_id,)
    )["n"]
    if marker and question_count == 0 and (marker["meta"] or {}).get("opening"):
        # A provider failure before question insertion can strand the opener
        # marker. The next explicit open is safe to retry when no question exists.
        execute(
            "UPDATE rounds SET meta = meta - 'opened' - 'opening', status = 'pending' "
            "WHERE id=%s AND NOT EXISTS (SELECT 1 FROM questions WHERE round_id=%s)",
            (round_id, round_id),
        )
    claimed = execute(
        """UPDATE rounds SET status = 'active',
             meta = meta || '{"opened": true, "opening": true}'::jsonb
           WHERE id = %s AND status IN ('active', 'pending')
             AND (
               NOT (meta ? 'opened')
               OR NOT EXISTS (
                 SELECT 1 FROM questions q WHERE q.round_id = rounds.id
               )
             ) AND NOT (meta ? 'opening')
           RETURNING id""",
        (round_id,),
    )
    if claimed:
        role = session.get("role") or (structured or {}).get("inferred_target_role")
        profile = profile_for(role)
        if r["round_type"] == "B" and profile.practical_mode == "code":
            try:
                q = conductor.dsa_intuition_opening(str(round_id), session, structured)
            except Exception as exc:
                execute("UPDATE rounds SET meta = meta - 'opened' - 'opening', status = 'pending' "
                        "WHERE id = %s", (round_id,))
                raise HTTPException(503, f"Unable to open interview round: {exc}") from exc
        elif r["round_type"] == "C":
            try:
                q = conductor.design_opening(str(round_id), session, structured)
            except Exception as exc:
                execute("UPDATE rounds SET meta = meta - 'opened' - 'opening', status = 'pending' "
                        "WHERE id = %s", (round_id,))
                raise HTTPException(503, f"Unable to open interview round: {exc}") from exc
        elif r["round_type"] == "B":
            try:
                q = conductor.practical_opening(str(round_id), session, structured)
            except Exception as exc:
                execute("UPDATE rounds SET meta = meta - 'opened' - 'opening', status = 'pending' "
                        "WHERE id = %s", (round_id,))
                raise HTTPException(503, f"Unable to open interview round: {exc}") from exc
        else:
            try:
                q = conductor.opening_question(str(round_id), session, structured)
            except Exception as exc:
                execute("UPDATE rounds SET meta = meta - 'opened' - 'opening', status = 'pending' "
                        "WHERE id = %s", (round_id,))
                raise HTTPException(503, f"Unable to open interview round: {exc}") from exc
        try:
            payload = {"text": q["question"], "is_followup": q.get("is_followup", False),
                       "probe_reason": q.get("probe_reason", "")}
            if r["seq"] == 0:
                payload["text"] = conductor.opening_intro(session, structured) + q["question"]
            roundsvc.add_question(str(round_id), "oral", q.get("topic"), q.get("difficulty"),
                                  payload)
            meta = fetchone("SELECT meta FROM rounds WHERE id=%s", (round_id,))["meta"] or {}
            meta.pop("opening", None)
            execute("UPDATE rounds SET meta=%s WHERE id=%s", (json.dumps(meta), round_id))
        except Exception:
            execute("UPDATE rounds SET meta = meta - 'opened' - 'opening', status = 'pending' "
                    "WHERE id = %s", (round_id,))
            raise
    elif r["status"] in ("active", "pending"):
        # we lost the claim race: another concurrent /open is generating. Wait (bounded)
        # so whoever's response lands last in the UI still shows the opening question.
        import time
        deadline = time.time() + 20
        while time.time() < deadline:
            time.sleep(0.4)
            if roundsvc.round_state(str(round_id))["questions"]:
                break
    return roundsvc.round_state(str(round_id))


@router.post("/rounds/{round_id}/answer")
def answer(request: Request, round_id: uuid.UUID, body: AnswerBody):
    r = get_round(round_id)
    if r is None:
        raise HTTPException(404, "round not found")
    session = owned_session(request, r["session_id"])
    state = roundsvc.round_state(str(round_id))
    if state["status"] != "active":
        raise HTTPException(409, "this round is no longer accepting answers")
    current = fetchone(
        "SELECT id FROM rounds WHERE session_id=%s AND status='active' ORDER BY seq LIMIT 1",
        (r["session_id"],),
    )
    if not current or str(current["id"]) != str(round_id):
        raise HTTPException(409, "this is not the current interview round")
    if roundsvc.remaining_minutes(str(round_id)) <= 0:
        roundsvc.set_round_status(str(round_id), "completed")
        raise HTTPException(409, "this round's time has expired")
    if contains_prompt_injection(body.text):
        raise HTTPException(422, "That message contains an instruction-hijacking attempt. "
                                "Please answer the interview question directly.")
    if not state["questions"]:
        raise HTTPException(409, "no question yet")
    q = state["questions"][-1]

    aid = roundsvc.append_answer(str(round_id), q["question_id"], body.text, body.source)
    last_q = q["payload"].get("text") or (
        f"{q['payload'].get('title', 'DSA problem')}: "
        f"{q['payload'].get('statement', '')}"
    )
    evaluation = conductor.quick_evaluate(str(round_id), session, session["resume_structured"]
                                          or {}, last_q, body.text)
    roundsvc.update_answer_evaluation(aid, evaluation)
    if (r["meta"] or {}).get("idle_nudge"):
        meta = r["meta"] or {}
        meta.pop("idle_nudge", None)
        execute("UPDATE rounds SET meta=%s WHERE id=%s", (json.dumps(meta), round_id))

    # Decide: wrap-up now? (time spent >= budget-2.5min, or candidate explicitly done)
    remaining = roundsvc.remaining_minutes(str(round_id))
    already_wrapped = any(x["payload"].get("is_wrapup") for x in state["questions"])
    wrap_up = not already_wrapped and remaining <= 2.5

    if already_wrapped:
        # the wrap-up question was answered -> close the round
        roundsvc.set_round_status(str(round_id), "completed")
        return {"round_complete": True, "verdict": evaluation,
                "remaining_minutes": remaining}

    nxt = conductor.next_question(str(round_id), session, session["resume_structured"] or {},
                                  wrap_up=wrap_up, round_type=r["round_type"])
    payload = {"text": nxt["question"], "is_followup": bool(nxt.get("is_followup")),
               "probe_reason": nxt.get("probe_reason", ""), "is_wrapup": wrap_up}
    roundsvc.add_question(str(round_id), "oral", nxt.get("topic"), nxt.get("difficulty"),
                          payload)
    return {"round_complete": False, "verdict": evaluation,
            "remaining_minutes": remaining,
            "question": {"ord": _next_ord(str(round_id)), "text": nxt["question"],
                         "topic": nxt.get("topic"), "difficulty": nxt.get("difficulty")}}


@router.post("/rounds/{round_id}/idle")
def idle_round(request: Request, round_id: uuid.UUID, body: IdleBody):
    """Deliver interviewer-side inactivity nudges and advance unanswered turns."""
    r = get_round(round_id)
    if r is None:
        raise HTTPException(404, "round not found")
    session = owned_session(request, r["session_id"])
    state = roundsvc.round_state(str(round_id))
    if state["status"] != "active" or not state.get("current"):
        raise HTTPException(409, "this round is not the current active round")
    q = next((item for item in state["questions"]
              if item["question_id"] == str(body.question_id)), None)
    if q is None or q["question_id"] != state["questions"][-1]["question_id"]:
        raise HTTPException(409, "question is no longer awaiting a response")
    if q["answers"]:
        raise HTTPException(409, "candidate has already answered this question")
    timing = q["payload"].get("response_window") or {}
    created = fetchone("SELECT EXTRACT(EPOCH FROM now() - created_at) AS age "
                       "FROM questions WHERE id=%s", (body.question_id,))
    age = float((created or {}).get("age") or 0)
    nudge = (state.get("idle_nudge") or {})
    if body.phase == "nudge":
        if age < timing.get("nudge_after_seconds", 0):
            raise HTTPException(409, "inactivity nudge is not due yet")
        if nudge.get("question_id") == str(body.question_id):
            return {"round_complete": False, "nudged": True,
                    "state": roundsvc.round_state(str(round_id))}
        meta = r["meta"] or {}
        meta["idle_nudge"] = {
            "question_id": str(body.question_id),
            "text": "Take your time. I haven’t heard your answer yet. "
                    "Would you like to continue with this question, or should we move on?",
        }
        execute("UPDATE rounds SET meta=%s WHERE id=%s", (json.dumps(meta), round_id))
        return {"round_complete": False, "nudged": True,
                "state": roundsvc.round_state(str(round_id))}
    if nudge.get("question_id") != str(body.question_id):
        raise HTTPException(409, "the interviewer nudge has not been delivered")
    if age < timing.get("response_window_seconds", 0):
        raise HTTPException(409, "the response window is still open")
    if roundsvc.remaining_minutes(str(round_id)) <= 0:
        roundsvc.set_round_status(str(round_id), "completed")
        return {"round_complete": True, "state": roundsvc.round_state(str(round_id))}
    meta = r["meta"] or {}
    meta.pop("idle_nudge", None)
    execute("UPDATE rounds SET meta=%s WHERE id=%s", (json.dumps(meta), round_id))
    nxt = conductor.next_question(str(round_id), session, session["resume_structured"] or {},
                                  wrap_up=False, round_type=r["round_type"])
    payload = {"text": nxt["question"], "is_followup": bool(nxt.get("is_followup")),
               "probe_reason": nxt.get("probe_reason", ""), "is_wrapup": False}
    roundsvc.add_question(str(round_id), "oral", nxt.get("topic"), nxt.get("difficulty"),
                          payload)
    return {"round_complete": False, "advanced": True,
            "state": roundsvc.round_state(str(round_id))}


def _next_ord(round_id: str) -> int:
    return int(fetchone("SELECT COALESCE(MAX(ord),0) AS n FROM questions WHERE round_id=%s",
                        (round_id,))["n"])


@router.post("/rounds/{round_id}/close")
def close_round(request: Request, round_id: uuid.UUID):
    r = get_round(round_id)
    if r is None:
        raise HTTPException(404, "round not found")
    owned_session(request, r["session_id"])
    if r["status"] != "active":
        raise HTTPException(409, "only the current active round can be closed")
    roundsvc.set_round_status(str(round_id), "completed")
    return {"ok": True}


@router.post("/sessions/{session_id}/pause")
def pause_session(request: Request, session_id: uuid.UUID):
    session = owned_session(request, session_id)
    if session["status"] != "in_progress":
        raise HTTPException(409, "only an active interview can be paused")
    current = fetchone(
        "SELECT id, meta FROM rounds WHERE session_id=%s AND status='active' "
        "ORDER BY seq LIMIT 1",
        (session_id,),
    )
    if not current:
        raise HTTPException(409, "no active round to pause")
    execute(
        """UPDATE rounds
           SET status='paused',
               meta = meta || jsonb_build_object('paused_at', now()::text)
           WHERE id=%s AND status='active'""",
        (current["id"],),
    )
    execute("UPDATE sessions SET status='paused', updated_at=now() WHERE id=%s", (session_id,))
    return {"ok": True, "status": "paused"}


@router.post("/sessions/{session_id}/resume")
def resume_session(request: Request, session_id: uuid.UUID):
    session = owned_session(request, session_id)
    if session["status"] != "paused":
        raise HTTPException(409, "interview is not paused")
    current = fetchone(
        "SELECT id FROM rounds WHERE session_id=%s AND status='paused' "
        "ORDER BY seq DESC LIMIT 1",
        (session_id,),
    )
    if not current:
        raise HTTPException(409, "no paused round to resume")
    execute(
        """UPDATE rounds
           SET status='active',
               started_at = started_at + (now() - ((meta->>'paused_at')::timestamptz)),
               meta = meta - 'paused_at'
           WHERE id=%s AND status='paused' AND meta ? 'paused_at'""",
        (current["id"],),
    )
    execute("UPDATE sessions SET status='in_progress', updated_at=now() WHERE id=%s", (session_id,))
    return {"ok": True, "status": "in_progress"}


def _session_view(row: dict) -> dict:
    return {
        "session_id": str(row["id"]),
        "status": row["status"], "role": row["role"], "level": row["level"],
        "rounds": row["rounds"], "durations": row["durations"],
        "jd_text": row["jd_text"],
        "resume_structured": row["resume_structured"],
        "resume_original_name": row["resume_original_name"],
        "stages": list(profile_for(row["role"], (row["resume_structured"] or {}).get("inferred_target_role")).stages),
    }
