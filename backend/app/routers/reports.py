from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, HTTPException, Request

from app.authz import candidate_id, get_round, owned_session
from app.db import execute, fetchall, fetchone
from app.llm.provider import LLMError
from app.services import report as report_svc
from app.authsvc import current_user, user_sessions

router = APIRouter()


@router.post("/rounds/{round_id}/report")
def generate_round_report(request: Request, round_id: uuid.UUID):
    r = get_round(round_id)
    if r is None:
        raise HTTPException(404, "round not found")
    owned_session(request, r["session_id"])
    try:
        payload = report_svc.build_round_report(str(round_id))
    except LLMError as exc:
        raise HTTPException(503, "report generation is temporarily unavailable") from exc
    if payload is None:
        raise HTTPException(409, "no transcript to report on")
    exec_row = execute(
        """INSERT INTO reports (id, session_id, round_id, kind, payload)
           VALUES (%s, %s, %s, 'round', %s) RETURNING id""",
        (uuid.uuid4(), r["session_id"], round_id, json.dumps(payload)),
    )
    return {"report_id": str(exec_row["id"]), "payload": payload}


@router.get("/sessions/{session_id}/reports")
def list_reports(request: Request, session_id: uuid.UUID):
    owned_session(request, session_id)
    rows = fetchall("SELECT id, kind, round_id, created_at FROM reports "
                    "WHERE session_id=%s ORDER BY created_at", (session_id,))
    return [{"report_id": str(x["id"]), "kind": x["kind"],
             "round_id": str(x["round_id"]) if x["round_id"] else None} for x in rows]


@router.get("/reports/{report_id}")
def get_report(request: Request, report_id: uuid.UUID):
    row = fetchone("SELECT rep.*, s.candidate_id FROM reports rep JOIN sessions s "
                   "ON s.id = rep.session_id WHERE rep.id=%s", (report_id,))
    if row is None:
        raise HTTPException(404, "report not found")
    if row["candidate_id"] != candidate_id(request):
        raise HTTPException(403, "not your report")
    return {"kind": row["kind"], "payload": row["payload"],
            "created_at": str(row["created_at"])}


@router.post("/sessions/{session_id}/final-report")
def final_report(request: Request, session_id: uuid.UUID):
    owned_session(request, session_id)
    payload = report_svc.build_final_report(str(session_id))
    if payload is None:
        raise HTTPException(409, "no completed rounds to report")
    exec_row = execute(
        """INSERT INTO reports (id, session_id, round_id, kind, payload)
           VALUES (%s, %s, NULL, 'final', %s) RETURNING id""",
        (uuid.uuid4(), session_id, json.dumps(payload)),
    )
    execute("UPDATE sessions SET status='completed', updated_at=now() WHERE id=%s",
            (session_id,))
    return {"report_id": str(exec_row["id"]), "payload": payload}


@router.post("/sessions/{session_id}/exit")
def exit_session(request: Request, session_id: uuid.UUID):
    """Abort an in-progress interview without fabricating a completion report."""
    session = owned_session(request, session_id)
    if session["status"] in ("completed", "aborted"):
        return {"ok": True, "status": session["status"]}
    execute(
        "UPDATE rounds SET status='aborted', ended_at=now() "
        "WHERE session_id=%s AND status IN ('active', 'pending')",
        (session_id,),
    )
    execute("UPDATE sessions SET status='aborted', updated_at=now() WHERE id=%s",
            (session_id,))
    return {"ok": True, "status": "aborted"}


@router.delete("/sessions/{session_id}")
def delete_session(request: Request, session_id: uuid.UUID):
    owned_session(request, session_id)
    execute("UPDATE sessions SET deleted=TRUE, updated_at=now() WHERE id=%s", (session_id,))
    return {"ok": True, "deleted": str(session_id)}


@router.get("/sessions")
def list_my_sessions(request: Request):
    """History: user's own sessions when signed in; else this browser's anonymous ones."""
    user = current_user(request)
    if user:
        return user_sessions(str(user["id"]))
    cand = candidate_id(request)
    rows = fetchall(
        """SELECT s.id, s.status, s.role, s.level, s.rounds, s.resume_original_name
           FROM sessions s WHERE s.candidate_id=%s AND s.user_id IS NULL
             AND s.deleted=FALSE
           ORDER BY s.created_at DESC LIMIT 50""", (cand,))
    return [{"session_id": str(x["id"]), "status": x["status"], "role": x["role"],
             "level": x["level"], "rounds": x["rounds"], "resume": x["resume_original_name"]}
            for x in rows]


@router.delete("/me/data")
def delete_my_data(request: Request):
    """Delete every stored session/report/resume for the current identity."""
    user = current_user(request)
    if user:
        execute("UPDATE sessions SET deleted = TRUE WHERE user_id = %s", (str(user["id"]),))
        return {"ok": True, "scope": "account"}
    cand = candidate_id(request)
    execute("UPDATE sessions SET deleted = TRUE WHERE candidate_id = %s", (cand,))
    return {"ok": True, "scope": "browser-only (anonymous)"}
