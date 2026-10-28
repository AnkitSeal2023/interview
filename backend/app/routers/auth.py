from __future__ import annotations

import uuid

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.authsvc import (AUTH_COOKIE, claim_anonymous_sessions, create_user,
                         current_user, get_user_by_email, login_cookie,
                         verify_password)
from app.authz import CANDIDATE_COOKIE

router = APIRouter()


class AuthBody(BaseModel):
    email: str = Field(..., max_length=200)
    password: str = Field(..., min_length=1, max_length=200)
    name: str | None = Field(None, max_length=80)


@router.post("/auth/register")
def register(request: Request, body: AuthBody, response: Response):
    user = create_user(body.email, body.password, body.name)
    login_cookie(response, str(user["id"]))
    claimed = claim_anonymous_sessions(request.cookies.get(CANDIDATE_COOKIE, ""),
                                       str(user["id"]))
    return {"user": _view(user), "claimed_sessions": claimed}


@router.post("/auth/login")
def login(request: Request, body: AuthBody, response: Response):
    user = get_user_by_email(body.email)
    if user is None or not verify_password(body.password, user["password_hash"]):
        raise HTTPException(401, "wrong email or password")
    login_cookie(response, str(user["id"]))
    claimed = claim_anonymous_sessions(request.cookies.get(CANDIDATE_COOKIE, ""),
                                       str(user["id"]))
    return {"user": _view(user), "claimed_sessions": claimed}


@router.post("/auth/logout")
def logout(response: Response):
    response.delete_cookie(AUTH_COOKIE)
    return {"ok": True}


@router.get("/auth/me")
def me(request: Request):
    user = current_user(request)
    return {"user": _view(user) if user else None}


def _view(u: dict) -> dict:
    return {"id": str(u["id"]), "email": u["email"], "name": u.get("name")}
