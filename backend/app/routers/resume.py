import logging
import uuid

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile

from app.authz import candidate_id, owned_session
from app.authsvc import current_user, user_sessions
from app.config import settings
from app.db import execute
from app.services.resume_extract import extract_text

log = logging.getLogger("resume")
from fastapi import APIRouter

router = APIRouter()


@router.post("/resume")
async def upload_resume(request: Request,
                        file: UploadFile = File(...),
                        jd: str | None = Form(None)) -> dict:
    """Upload resume PDF (+optional JD) → create a draft session. SPEC §2/§8."""
    cand = candidate_id(request)
    if not file.filename or not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "please upload a PDF resume")
    data = await file.read()
    if len(data) == 0:
        raise HTTPException(400, "empty file")
    limit = settings.max_resume_mb * 1024 * 1024
    if len(data) > limit:
        raise HTTPException(413, f"resume exceeds {settings.max_resume_mb} MB")

    try:
        text = extract_text(data)
    except Exception:  # malformed PDFs must never 500 the API
        log.exception("pdf parse failure")
        raise HTTPException(422, "could not parse this PDF — try exporting it again")

    if len(text) < 200:
        raise HTTPException(422, "could not read enough text from this PDF — it may be "
                                 "scanned/image-only; try a text-based PDF export")

    session_id = uuid.uuid4()
    user = current_user(request)
    execute(
        """INSERT INTO sessions (id, candidate_id, user_id, resume_original_name,
                                 resume_text, jd_text)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        (session_id, cand, user["id"] if user else None,
         file.filename, text, jd or None),
    )
    return {"session_id": str(session_id), "resume_chars": len(text), "preview": text[:400]}
