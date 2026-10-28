"""Interviewer-side TTS: browser → FastAPI → local Coqui TTS microservice.

Synthesis runs in backend/.venv-tts (torch + coqui-tts, separate venv so the
main venv stays light) managed by scripts/tts.sh on :8001; this endpoint only
proxies. If the service is down we return 503 and the frontend falls back to
browser speechSynthesis, so voice never hard-blocks a session.
"""
from __future__ import annotations

import json

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings

router = APIRouter()


class TtsBody(BaseModel):
    text: str = Field(min_length=1, max_length=4000)


def _proxy_timeout() -> httpx.Timeout:
    return httpx.Timeout(360.0, connect=10.0)  # first call may load/download the model


@router.post("/tts")
def tts(body: TtsBody) -> Response:
    try:
        r = httpx.post(
            f"{settings.tts_service_url}/tts",
            json={"text": body.text},
            headers={"X-TTS-Key": settings.tts_internal_key},
            timeout=_proxy_timeout(),
        )
    except httpx.HTTPError:
        raise HTTPException(503, "tts service unavailable — using browser voice")
    if r.status_code == 403:
        raise HTTPException(502, "tts service rejected the internal key")
    if r.status_code != 200:
        raise HTTPException(502, "tts service error")
    return Response(content=r.content, media_type="audio/wav")


@router.post("/tts-stream")
async def tts_stream(body: TtsBody) -> StreamingResponse:
    """Pass the service's NDJSON sentence stream through to the browser unbuffered,
    so playback starts after the first sentence instead of the full question."""
    async def gen():
        try:
            async with httpx.AsyncClient(timeout=_proxy_timeout()) as client:
                async with client.stream(
                    "POST", f"{settings.tts_service_url}/tts-stream",
                    json={"text": body.text},
                    headers={"X-TTS-Key": settings.tts_internal_key},
                ) as r:
                    if r.status_code == 503:
                        yield json.dumps({"error": "tts service unavailable"}).encode() + b"\n"
                        return
                    if r.status_code != 200:
                        yield json.dumps({"error": f"tts service error {r.status_code}"}).encode() + b"\n"
                        return
                    async for chunk in r.aiter_bytes():
                        yield chunk
        except httpx.HTTPError:
            yield json.dumps({"error": "tts service unreachable"}).encode() + b"\n"

    return StreamingResponse(gen(), media_type="application/x-ndjson")
