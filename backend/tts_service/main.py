"""Standalone local TTS microservice (the interviewer's voice).

Runs in its own venv (backend/.venv-tts: CPU torch + coqui-tts) on port 8001 so
the heavy pytorch stack never pollutes the main backend venv. The FastAPI
backend proxies POST /api/tts → POST /tts here; the browser never talks to this
service directly.

Model: tts_models/en/ljspeech/tacotron2-DDC (single-speaker, ~2x realtime on CPU).
Concurrent syntheses are serialized (CPU-bound); responses cached by text hash.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import re
import threading
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

log = logging.getLogger("tts_service")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")

TTS_PORT = int(os.environ.get("TTS_PORT", "8001"))
TTS_KEY = os.environ.get("TTS_INTERNAL_KEY", "dev-insecure-tts-key")
MODEL_NAME = os.environ.get("TTS_MODEL", "tts_models/en/ljspeech/tacotron2-DDC")
CACHE_DIR = Path(os.environ.get("TTS_CACHE_DIR", "/tmp/opencode/tts_cache"))
MAX_CHARS = 4000

_model = None            # TTS instance, loaded once (downloads ~110MB on first use)
_load_lock = threading.Lock()
_gen_lock = threading.Lock()   # one synthesis at a time on CPU
_splitter = None         # pysbd sentence segmenter (cheap, usable pre-model-load)
MAX_SENTENCE_CHARS = 110


def _sentences(text: str) -> list[str]:
    """pysbd split (same splitter the Synthesizer uses internally)."""
    global _splitter
    if _splitter is None:
        try:
            import pysbd
            _splitter = pysbd.Segmenter(language="en", clean=True)
        except Exception:  # noqa: BLE001 — degrade to naive punctuation split
            _splitter = False
    if _splitter is False:
        import re
        parts = re.split(r"(?<=[.!?])\s+", text)
        return [p for p in (p.strip() for p in parts) if p]
    base = [s.strip() for s in _splitter.segment(_tts_text(text)) if s.strip()]
    out: list[str] = []
    for sentence in base or [_tts_text(text)]:
        remaining = sentence
        while len(remaining) > MAX_SENTENCE_CHARS:
            cut = max(
                remaining.rfind(", ", 0, MAX_SENTENCE_CHARS),
                remaining.rfind("; ", 0, MAX_SENTENCE_CHARS),
                remaining.rfind(": ", 0, MAX_SENTENCE_CHARS),
                remaining.rfind(" ", 0, MAX_SENTENCE_CHARS),
            )
            if cut < 30:
                cut = MAX_SENTENCE_CHARS
            out.append(remaining[:cut].strip(" ,;:"))
            remaining = remaining[cut:].lstrip(" ,;:")
        if remaining:
            out.append(remaining)
    return out or [_tts_text(text)]


def _tts_text(text: str) -> str:
    """Convert interview copy to the ASCII vocabulary supported by the LJSpeech model."""
    normalized = unicodedata.normalize("NFKC", text).translate(str.maketrans({
        "\u2018": "'",
        "\u2019": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u2013": "-",
        "\u2014": ",",
        "\u2212": "-",
        "\u2026": "...",
        "/": " or ",
        "&": " and ",
    }))
    normalized = normalized.encode("ascii", "ignore").decode("ascii")
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized or " "


def _get_tts():
    global _model
    with _load_lock:
        if _model is None:
            log.info("loading %s (first call only; may download the model)", MODEL_NAME)
            from TTS.api import TTS
            _model = TTS(model_name=MODEL_NAME)
            log.info("model loaded")
        return _model


def _synth(text: str) -> bytes:
    text = _tts_text(text)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(f"{MODEL_NAME}|{text}".encode()).hexdigest()
    cached = CACHE_DIR / f"{key}.wav"
    if cached.exists():
        return cached.read_bytes()
    tts = _get_tts()
    with _gen_lock:  # serialize CPU synthesis; harmless for a single client
        if cached.exists():  # a concurrent twin may have finished while we queued
            return cached.read_bytes()
        tmp = cached.with_suffix(".tmp.wav")
        tts.tts_to_file(text=text, file_path=str(tmp))
        data = tmp.read_bytes()
        tmp.unlink(missing_ok=True)
        cached.write_bytes(data)
        return data


class Handler(BaseHTTPRequestHandler):
    def _json(self, code: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        if self.path == "/health":
            loaded = _model is not None
            self._json(200, {"ok": True, "model loaded": loaded})
        else:
            self._json(404, {"detail": "not found"})

    def do_POST(self) -> None:
        if self.path not in ("/tts", "/tts-stream"):
            self._json(404, {"detail": "not found"})
            return
        if self.headers.get("X-TTS-Key") != TTS_KEY:
            self._json(403, {"detail": "bad key"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            text = json.loads(self.rfile.read(length) or b"{}").get("text", "")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"detail": "bad json"})
            return
        text = (text or "").strip()
        if not text:
            self._json(422, {"detail": "empty text"})
            return
        if self.path == "/tts-stream":
            self._stream_sentences(text[:MAX_CHARS])  # body already consumed — never re-read
            return
        try:
            wav = _synth(text[:MAX_CHARS])
        except Exception as e:  # noqa: BLE001 — surface any synth failure to the proxy
            log.exception("synthesis failed")
            self._json(500, {"detail": f"synthesis failed: {e}"})
            return
        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)

    def _stream_sentences(self, text: str) -> None:
        """NDJSON stream: one line per sentence — {"b64": "<base64 wav>"} (or {"error": ...}).

        HTTP/1.0 connection-close delimits the stream (no Content-Length needed);
        each line is flushed as soon as its sentence is synthesized, so the
        browser starts playing sentence 1 while sentence N is still rendering.
        NOTE: the request body was already consumed by do_POST.
        """
        sents = _sentences(text)
        log.info("stream: %d sentence(s), %d chars", len(sents), len(text))
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.end_headers()
        for s in sents:
            try:
                wav = _synth(s)
            except Exception as e:  # noqa: BLE001 — mid-stream we can only send an error line
                log.exception("sentence synthesis failed")
                self.wfile.write(json.dumps({"error": f"synthesis failed: {e}"}).encode() + b"\n")
                self.wfile.flush()
                return
            try:
                self.wfile.write(json.dumps(
                    {"b64": base64.b64encode(wav).decode(), "text": s}).encode() + b"\n")
                self.wfile.flush()
            except BrokenPipeError:
                log.info("stream client disconnected; stopping synthesis response")
                return

    def log_message(self, fmt: str, *args) -> None:  # quiet default access spam
        log.info(fmt, *args)


def _preload() -> None:
    """Warm the model at service boot so the first spoken question only pays synthesis."""
    try:
        _get_tts()
        log.info("model preloaded — first request will synthesize immediately")
    except Exception:  # noqa: BLE001 — lazily retried on the first real request
        log.exception("preload failed; will retry on first request")


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", TTS_PORT), Handler)
    log.info("TTS service on 127.0.0.1:%d (model=%s)", TTS_PORT, MODEL_NAME)
    threading.Thread(target=_preload, daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
