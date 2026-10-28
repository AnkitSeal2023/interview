"""Helpers for candidate identity + session ownership.

Identity = EITHER a logged-in user (HMAC `auth` cookie) OR an anonymous browser
`cand` cookie. Sessions created while logged in are stamped with `user_id` and then
require that user; anonymous sessions stay claimable at register/login time.
"""
import uuid

from fastapi import HTTPException, Request

from app.authsvc import current_user
from app.db import fetchone

CANDIDATE_COOKIE = "cand"


def candidate_id(request: Request) -> uuid.UUID:
    raw = (getattr(request, "state", None) and request.state.candidate_id) \
        or request.cookies.get(CANDIDATE_COOKIE)
    if not raw:
        raise HTTPException(400, "no candidate cookie; reload the app")
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise HTTPException(400, "invalid candidate cookie") from None


def owned_session(request: Request, session_id: uuid.UUID) -> dict:
    row = fetchone(
        "SELECT * FROM sessions WHERE id = %s AND deleted = FALSE", (session_id,))
    if row is None:
        raise HTTPException(404, "session not found")
    if row["user_id"] is not None:
        # user-scoped session: only its owner may touch it
        u = current_user(request)
        if u is None or str(u["id"]) != str(row["user_id"]):
            raise HTTPException(403, "sign in to access this interview")
    else:
        if row["candidate_id"] != candidate_id(request):
            raise HTTPException(403, "not your session")
    return row


def get_round(round_id: uuid.UUID) -> dict | None:
    return fetchone("SELECT * FROM rounds WHERE id = %s", (round_id,))
