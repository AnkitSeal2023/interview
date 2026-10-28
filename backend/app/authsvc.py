"""User accounts + auth tokens (SPEC §8: appropriate auth for stored candidate data).

- Passwords: PBKDF2-HMAC-SHA256, 600k iterations, 16B random salt, stored `salt$hash`.
- Tokens: `base64url(payload).sig` HMAC-SHA256 with AUTH_SECRET, payload {uid, exp}.
 favor their exp in 30 days; invalid/absent token → anonymous (cookie-identity only).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import time
import uuid

from fastapi import HTTPException, Request, Response

from app.config import settings
from app.db import execute, fetchone

log = logging.getLogger("auth")

AUTH_COOKIE = "auth"
TOKEN_TTL_S = 30 * 24 * 3600
PBKDF2_ITER = 600_000


# ---------------------------------------------------------------- passwords

def hash_password(pw: str) -> str:
    salt = uuid.uuid4().bytes
    dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), salt, PBKDF2_ITER)
    return f"{salt.hex()}${dk.hex()}"


def verify_password(pw: str, stored: str) -> bool:
    try:
        salt_hex, hash_hex = stored.split("$", 1)
        dk = hashlib.pbkdf2_hmac("sha256", pw.encode(), bytes.fromhex(salt_hex), PBKDF2_ITER)
        return hmac.compare_digest(dk.hex(), hash_hex)
    except (ValueError, TypeError):
        return False


# ---------------------------------------------------------------- tokens

def _sig(payload_b64: bytes) -> str:
    secret = settings.auth_secret.encode()
    return hmac.new(secret, payload_b64, hashlib.sha256).hexdigest()


def make_token(user_id: str) -> str:
    payload = json.dumps({"uid": user_id, "exp": int(time.time()) + TOKEN_TTL_S}).encode()
    b64 = base64.urlsafe_b64encode(payload).rstrip(b"=")
    return f"{b64.decode()}.{_sig(b64)}"


def parse_token(token: str | None) -> str | None:
    if not token or "." not in token:
        return None
    try:
        b64, sig = token.rsplit(".", 1)
        if not hmac.compare_digest(sig, _sig(b64.encode())):
            return None
        pad = "=" * (-len(b64) % 4)
        payload = json.loads(base64.urlsafe_b64decode(b64 + pad))
        if payload.get("exp", 0) < time.time():
            return None
        uuid.UUID(payload["uid"])  # shape check
        return payload["uid"]
    except Exception:
        return None


# ---------------------------------------------------------------- users/table

def get_user_by_email(email: str) -> dict | None:
    if not email or "@" not in email:
        return None
    return fetchone("SELECT * FROM users WHERE LOWER(email) = LOWER(%s)", (email.strip(),))


def create_user(email: str, password: str, name: str | None = None) -> dict:
    email = email.strip()
    if "@" not in email or len(email) > 200:
        raise HTTPException(422, "enter a valid email address")
    if not 8 <= len(password) <= 200:
        raise HTTPException(422, "password must be 8-200 characters")
    if get_user_by_email(email):
        raise HTTPException(409, "an account with this email already exists")
    uid = uuid.uuid4()
    execute(
        "INSERT INTO users (id, email, name, password_hash) VALUES (%s, %s, %s, %s)",
        (uid, email, name or email.split("@")[0], hash_password(password)),
    )
    return fetchone("SELECT * FROM users WHERE id = %s", (uid,))


# ---------------------------------------------------------------- request user

def current_user(request: Request) -> dict | None:
    uid = parse_token(request.cookies.get(AUTH_COOKIE))
    if not uid:
        return None
    try:
        return fetchone("SELECT id, email, name, created_at FROM users WHERE id = %s", (uid,))
    except Exception:  # db hiccup → treat as anonymous rather than 500ing every call
        log.exception("current_user lookup failed")
        return None


def require_current_user(request: Request) -> dict:
    u = current_user(request)
    if u is None:
        raise HTTPException(401, "sign in required")
    return u


def login_cookie(response: Response, user_id: str) -> None:
    response.set_cookie(AUTH_COOKIE, make_token(user_id), max_age=TOKEN_TTL_S,
                        httponly=True, samesite="lax")


def claim_anonymous_sessions(candidate_cookie_id: str | None, user_id: str) -> int:
    """Adopt the browser's anonymous history into this account (SPEC history)."""
    if not candidate_cookie_id:
        return 0
    try:
        uuid.UUID(candidate_cookie_id)
    except ValueError:
        return 0
    row = execute(
        """UPDATE sessions SET user_id = %s, updated_at = now()
           WHERE candidate_id = %s AND user_id IS NULL AND deleted = FALSE
           RETURNING id""",
        (user_id, candidate_cookie_id),
    )
    return 1 if row else 0


def user_sessions(user_id: str) -> list[dict]:
    from app.db import fetchall

    return [
        {"session_id": str(x["id"]), "status": x["status"], "role": x["role"],
         "level": x["level"], "rounds": x["rounds"], "resume": x["resume_original_name"]}
        for x in fetchall(
            """SELECT id, status, role, level, rounds, resume_original_name
               FROM sessions
               WHERE user_id = %s AND deleted = FALSE
               ORDER BY created_at DESC LIMIT 100""",
            (user_id,),
        )
    ]
