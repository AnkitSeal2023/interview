"""Local STT via faster-whisper (SPEC §7/§10: no hosted STT in v1).

Model loaded once lazily from backend/whisper_models (HF_HOME is set in config).
CPU-only; sensible for 5-20s mic clips (base model ≈1-3s on 12 cores).
"""
from __future__ import annotations

import logging
import threading

from fastapi import APIRouter, HTTPException, Request
from faster_whisper import WhisperModel

from app.config import settings

log = logging.getLogger("stt")
router = APIRouter()

_lock = threading.Lock()
_model: WhisperModel | None = None


def _patch_av_open() -> None:
    """faster-whisper 1.2.1 calls av.open(..., metadata_errors='ignore') but PyAV>=15
    removed that kwarg (TypeError on any decode → HTTP 500). Drop the cosmetic kwarg;
    only affects ignoring malformed-container metadata which is unrelated to transcription.
    """
    import av
    orig = av.open
    if getattr(orig, "_fw_compat", False):
        return
    def open_compat(*args, **kw):
        kw.pop("metadata_errors", None)
        return orig(*args, **kw)
    open_compat._fw_compat = True
    av.open = open_compat


_patch_av_open()


def _get_model() -> WhisperModel:
    global _model
    with _lock:
        if _model is None:
            log.info("loading STT model %r (once)", settings.stt_model)
            _model = WhisperModel(settings.stt_model, device="cpu", compute_type="int8")
        return _model


@router.post("/stt")
async def transcribe(request: Request):
    form = await request.form()
    upload = form.get("file")
    if upload is None or not hasattr(upload, "read"):
        raise HTTPException(400, "missing audio file field 'file'")
    data = await upload.read()
    if not data:
        raise HTTPException(400, "empty audio")
    if len(data) > 15 * 1024 * 1024:
        raise HTTPException(413, "audio too large (15MB max)")
    model = _get_model()
    import io
    import tempfile

    with tempfile.TemporaryDirectory() as td:
        path = f"{td}/clip.webm"
        open(path, "wb").write(data)
        # Force English: the interview is English-only, and letting whisper guess on
        # short/noisy mic clips misfires into Arabic/Urdu hallucinations.
        segments, info = model.transcribe(
            path, beam_size=1, vad_filter=True, language="en"
        )
        text = " ".join(s.text.strip() for s in segments).strip()
    return {"text": text, "language": info.language, "duration_s": round(info.duration, 1)}
