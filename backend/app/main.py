"""FastAPI app wiring: routers, CORS, candidate cookie, DB pool lifecycle."""
from __future__ import annotations

import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, Response
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.db import close_pool, init_pool
from app.routers import auth, coding, interview, reports, resume, stt, tts
from app.authz import CANDIDATE_COOKIE


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_pool()
    yield
    close_pool()


app = FastAPI(title="Role Mock Interview", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

CANDIDATE_COOKIE = "cand"  # reuse from app.authz

COOKIE_MAX_AGE = 60 * 60 * 24 * 365


@app.middleware("http")
async def candidate_cookie(request: Request, call_next):
    """Ensure every browser call carries a stable anonymous candidate_id (D4).

    On the very first request (no cookie yet) we mint one immediately so the caller's
    action still succeeds; the cookie is planted on the response for subsequent calls.
    """
    raw = request.cookies.get(CANDIDATE_COOKIE)
    if not raw:
        raw = str(uuid.uuid4())
        request.state.candidate_id = raw
    elif _valid_uuid(raw):
        request.state.candidate_id = raw
    response: Response = await call_next(request)
    if not request.cookies.get(CANDIDATE_COOKIE):
        response.set_cookie(CANDIDATE_COOKIE, raw,
                            max_age=COOKIE_MAX_AGE, httponly=True, samesite="lax")
    return response


def _valid_uuid(raw: str) -> bool:
    try:
        uuid.UUID(raw)
        return True
    except ValueError:
        return False


@app.get("/api/health")
async def health():
    return {"ok": True}


app.include_router(auth.router, prefix="/api")
app.include_router(resume.router, prefix="/api")
app.include_router(interview.router, prefix="/api")
app.include_router(coding.router, prefix="/api")
app.include_router(reports.router, prefix="/api")
app.include_router(stt.router, prefix="/api")
app.include_router(tts.router, prefix="/api")
