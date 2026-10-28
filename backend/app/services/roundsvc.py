"""Round state persistence + orchestration helpers (D6: everything is durable)."""
from __future__ import annotations

import json
import logging
import uuid
from typing import Iterator

from app.db import execute, fetchall, fetchone
from app.prompts import untrusted_block


def response_window(question: dict, role: str | None, level: str | None) -> dict[str, int]:
    """Derive a candidate response window from the actual turn, not a fixed TTL."""
    payload = question.get("payload") or {}
    words = len(str(payload.get("text") or payload.get("statement") or "").split())
    difficulty = str(question.get("difficulty") or "medium").lower()
    role_factor = 1.15 if role in {"Data Scientist", "AI/ML Engineer", "Data Engineer"} else 1.0
    level_factor = {"senior": 1.18, "lead": 1.25, "mid": 1.08}.get(
        str(level or "").lower(), 1.0
    )
    difficulty_factor = {"easy": 0.88, "hard": 1.22}.get(difficulty, 1.0)
    followup_factor = 0.72 if payload.get("is_followup") else 1.0
    # More context needs more thinking time; cap only prevents pathological model output.
    window = round(max(18, min(150, (18 + words * 0.7) * role_factor
                              * level_factor * difficulty_factor * followup_factor)))
    nudge = round(window * 0.62)
    return {"response_window_seconds": window, "nudge_after_seconds": nudge}

log = logging.getLogger("round")


def new_round(session_id: str, round_type: str, seq: int, budget_min: int,
              status: str = "active") -> str:
    rid = uuid.uuid4()
    execute(
        """INSERT INTO rounds (id, session_id, round_type, seq, time_budget_min, status,
                               started_at)
           VALUES (%s, %s, %s, %s, %s, %s, now())""",
        (rid, session_id, round_type, seq, budget_min, status),
    )
    if status == "active":
        _set_session_current(rid, session_id)
    return str(rid)


def _set_session_current(round_id: str, session_id: str) -> None:
    execute("UPDATE sessions SET status='in_progress', updated_at=now() WHERE id=%s",
            (session_id,))


def round_state(round_id: str) -> dict | None:
    r = fetchone("SELECT r.*, s.role, s.level FROM rounds r "
                 "JOIN sessions s ON s.id = r.session_id WHERE r.id=%s", (round_id,))
    if not r:
        return None
    active = fetchone(
        "SELECT id FROM rounds WHERE session_id=%s AND status IN ('active', 'paused') "
        "ORDER BY seq LIMIT 1",
        (r["session_id"],),
    )
    qs = fetchall("SELECT * FROM questions WHERE round_id=%s ORDER BY ord", (round_id,))
    items = []
    idle_nudge = (r["meta"] or {}).get("idle_nudge")
    for q in qs:
        payload = {**(q["payload"] or {})}
        payload["response_window"] = response_window(
            {"payload": payload, "difficulty": q["difficulty"]},
            r.get("role"), r.get("level"),
        )
        ans = fetchall(
            "SELECT id, answer_text, source, evaluation, created_at FROM answers "
            "WHERE question_id=%s ORDER BY created_at", (q["id"],))
        items.append({
            "question_id": str(q["id"]), "ord": q["ord"], "topic": q["topic"],
            "difficulty": q["difficulty"], "kind": q["kind"], "payload": payload,
            "created_at": str(q["created_at"]),
            "answers": [
                {"id": str(a["id"]), "text": a["answer_text"], "source": a["source"],
                 "evaluation": a["evaluation"]} for a in ans
            ],
        })
    return {
        "round_id": str(r["id"]), "session_id": str(r["session_id"]),
        "round_type": r["round_type"], "status": r["status"],
        "current": bool(active and str(active["id"]) == str(r["id"])),
        "time_budget_min": r["time_budget_min"], "started_at": str(r["started_at"]),
        "meta": r["meta"], "questions": items,
        "idle_nudge": idle_nudge,
    }


def append_answer(round_id: str, question_id: str, text: str, source: str = "text") -> str:
    aid = uuid.uuid4()
    execute(
        """INSERT INTO answers (id, question_id, round_id, answer_text, source)
           VALUES (%s, %s, %s, %s, %s)""",
        (aid, question_id, round_id, text, source),
    )
    return str(aid)


def last_answer_id(round_id: str, question_id: str) -> str | None:
    row = fetchone(
        "SELECT id FROM answers WHERE question_id=%s ORDER BY created_at DESC LIMIT 1",
        (question_id,))
    return str(row["id"]) if row else None


def update_answer_evaluation(answer_id: str, evaluation: dict) -> None:
    execute("UPDATE answers SET evaluation=%s WHERE id=%s", (evaluation, answer_id))


def add_question(round_id: str, kind: str, topic: str | None, difficulty: str | None,
                 payload: dict) -> str:
    seq = fetchone("SELECT COALESCE(MAX(ord),0)+1 AS n FROM questions WHERE round_id=%s",
                   (round_id,))["n"]
    context = fetchone(
        "SELECT s.role, s.level FROM rounds r JOIN sessions s ON s.id=r.session_id "
        "WHERE r.id=%s", (round_id,))
    payload = {**payload}
    payload["response_window"] = response_window(
        {"payload": payload, "difficulty": difficulty},
        context.get("role") if context else None,
        context.get("level") if context else None,
    )
    qid = uuid.uuid4()
    execute(
        """INSERT INTO questions (id, round_id, ord, kind, topic, difficulty, payload)
           VALUES (%s,%s,%s,%s,%s,%s,%s)""",
        (qid, round_id, seq, kind, topic, difficulty, payload),
    )
    return str(qid)


def transcript_block(round_id: str, max_items: int = 40) -> str:
    """Render the Q/A transcript with per-answer verdicts for the conductor."""
    qs = fetchall("SELECT * FROM questions WHERE round_id=%s ORDER BY ord", (round_id,))
    lines: list[str] = []
    for q in qs:
        lines.append(f"Q{q['ord']} [{q['topic'] or ''}]: "
                     f"{untrusted_block('question', (q['payload'] or {}).get('text', ''), 600)}")
        for a in fetchall("SELECT answer_text, evaluation FROM answers WHERE question_id=%s",
                          (q["id"],)):
            verdict = (a["evaluation"] or {}).get("verdict", "assessed_later")
            lines.append(f"A: {untrusted_block('answer', a['answer_text'], 1000)} "
                         f"[quick-verdict: {verdict}]")
    return "\n".join(lines[-max_items * 2:]) or "(no questions yet)"


def asked_questions(round_id: str) -> list[str]:
    qs = fetchall("SELECT payload->>'text' AS t FROM questions WHERE round_id=%s ORDER BY ord",
                  (round_id,))
    return [q["t"] for q in qs if q["t"]]


def minutes_spent(round_id: str) -> float:
    r = fetchone("SELECT started_at FROM rounds WHERE id=%s", (round_id,))
    if r is None or r["started_at"] is None:
        return 0.0
    row = fetchone("SELECT EXTRACT(EPOCH FROM now() - %s::timestamptz)/60.0 AS m",
                   (r["started_at"],))
    return float(row["m"])


def remaining_minutes(round_id: str) -> float:
    r = fetchone("SELECT time_budget_min FROM rounds WHERE id=%s", (round_id,))
    return max(0.0, float(r["time_budget_min"]) - minutes_spent(round_id))


def set_round_status(round_id: str, status: str) -> None:
    extra = ", ended_at=now()" if status in ("completed", "aborted") else ""
    execute(f"UPDATE rounds SET status=%s{extra} WHERE id=%s", (status, round_id))
