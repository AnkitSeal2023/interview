"""LLM provider abstraction (D1).

Every provider implements:
    complete(messages: list[Msg], *, json_schema: object | None, purpose: str,
             session_id: str | None) -> LLMResult

`json_schema` is an optional RAII-free per-call structured-output hint; providers that support
native structured output use it, others fold a wording instruction into the prompt and the
caller is responsible for robust parsing (app/llm/parse.py).

Each purpose (conductor/evaluator/extractor/generator/report) maps to a provider name from
.env, so models are swap-in/swap-out without touching call sites.
"""
from __future__ import annotations

import json
import logging
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Literal

from app.config import settings
from app.db import execute

log = logging.getLogger("llm")

Msg = dict  # {"role": "system"|"user"|"assistant", "content": str}


@dataclass
class LLMResult:
    text: str
    provider: str
    model: str
    tokens_in: int = 0
    tokens_out: int = 0
    latency_ms: int = 0


class LLMError(RuntimeError):
    pass


class Provider(ABC):
    name: str = "abstract"
    model: str = "abstract"

    @abstractmethod
    def complete(self, messages: list[Msg], *, json_schema: object | None = None) -> LLMResult: ...


# ---------------------------------------------------------------- providers


class GeminiProvider(Provider):
    name = "gemini"
    model = "gemini-2.0-flash"

    def __init__(self) -> None:
        from google import genai  # lazy import

        key = settings.google_api_key
        if not key:
            raise LLMError("GOOGLE_API_KEY is not set; cannot use gemini provider")
        self._client = genai.Client(api_key=key)

    def complete(self, messages, *, json_schema=None):
        contents = []
        sys = "\n\n".join(m["content"] for m in messages if m["role"] == "system")
        for m in messages:
            if m["role"] == "system":
                continue
            contents.append({"role": "user" if m["role"] == "user" else "model",
                             "parts": [m["content"]]})
        cfg = {"systemInstruction": sys} if sys else {}
        if json_schema is not None:
            cfg = {**cfg, "responseMimeType": "application/json",
                   "responseSchema": json_schema}
        t0 = time.time()
        resp = self._client.models.generate_content(model=self.model, contents=contents,
                                                    config=cfg)
        return LLMResult(
            text=resp.text or "",
            provider=self.name, model=self.model,
            tokens_in=resp.usage_metadata.prompt_token_count or 0,
            tokens_out=resp.usage_metadata.candidates_token_count or 0,
            latency_ms=int((time.time() - t0) * 1000),
        )


GROQ_MODEL = settings.groq_model  # env-overridable; default = strongest free-tier chat model


class GroqProvider(Provider):
    name = "groq"
    model = GROQ_MODEL

    def __init__(self) -> None:
        from groq import Groq

        if not settings.groq_api_key:
            raise LLMError("GROQ_API_KEY is not set; cannot use groq provider")
        self._client = Groq(api_key=settings.groq_api_key)

    def complete(self, messages, *, json_schema=None):
        kwargs = {"model": self.model, "messages": messages, "temperature": 0.6}
        if json_schema is not None:
            kwargs["response_format"] = {"type": "json_object"}
        t0 = time.time()
        resp = self._client.chat.completions.create(**kwargs)
        ch = resp.choices[0]
        return LLMResult(
            text=ch.message.content or "",
            provider=self.name, model=self.model,
            tokens_in=resp.usage.prompt_tokens,
            tokens_out=resp.usage.completion_tokens,
            latency_ms=int((time.time() - t0) * 1000),
        )


class OllamaProvider(Provider):
    name = "ollama"
    model = settings.ollama_model

    def __init__(self) -> None:
        import openai

        if not settings.ollama_base_url:
            raise LLMError("OLLAMA_BASE_URL is not configured")
        self._client = openai.OpenAI(base_url=f"{settings.ollama_base_url}/v1", api_key="ollama")

    def complete(self, messages, *, json_schema=None):
        kwargs = {"model": self.model, "messages": messages, "temperature": 0.5}
        if json_schema is not None:
            kwargs["response_format"] = {"type": "json_object"}
        t0 = time.time()
        resp = self._client.chat.completions.create(**kwargs)
        ch = resp.choices[0]
        usage = resp.usage
        return LLMResult(
            text=ch.message.content or "",
            provider=self.name, model=self.model,
            tokens_in=getattr(usage, "prompt_tokens", 0) or 0,
            tokens_out=getattr(usage, "completion_tokens", 0) or 0,
            latency_ms=int((time.time() - t0) * 1000),
        )


# ---------------------------------------------------------------- registry

_PROVIDERS: dict[str, type[Provider]] = {
    "gemini": GeminiProvider,
    "groq": GroqProvider,
    "ollama": OllamaProvider,
}

_cache: dict[str, Provider] = {}


def provider_for(purpose: Literal["conductor", "evaluator", "extractor",
                                  "generator", "report"]) -> Provider:
    """Return (and cache) the provider configured for this purpose."""
    name = getattr(settings, f"llm_{purpose}_provider")
    if name not in _PROVIDERS:
        raise LLMError(f"unknown provider {name}")
    key = f"{purpose}:{name}"
    if key not in _cache:
        _cache[key] = _PROVIDERS[name]()
    return _cache[key]


def _record_usage(res: LLMResult, purpose: str, session_id: str | None, ok: bool, err: str = ""):
    try:
        cost = (res.tokens_in / 1e6 * settings.cost_per_mtok_input_usd
                + res.tokens_out / 1e6 * settings.cost_per_mtok_output_usd)
        execute(
            """INSERT INTO llm_usage (session_id, purpose, provider, model, tokens_in,
                                      tokens_out, latency_ms, ok)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (session_id, purpose, res.provider, res.model, res.tokens_in, res.tokens_out,
             res.latency_ms, ok),
        )
        _ = cost  # informational only; see app/metrics.py for aggregate reporting
    except Exception:  # pragma: no cover - usage logging must never break the request
        log.exception("usage log failed")


def complete(purpose: str, messages: list[Msg], *, json_schema: object | None = None,
             session_id: str | None = None, retries: int = 1) -> LLMResult:
    """Single entry point used by all services. Retries transient failures."""
    prov = provider_for(purpose)  # type: ignore[arg-type]
    last_exc: Exception | None = None
    for attempt in range(retries + 1):
        try:
            res = prov.complete(messages, json_schema=json_schema)
            _record_usage(res, purpose, session_id, ok=True)
            return res
        except Exception as e:  # noqa: BLE001 - providers raise diverse errors
            last_exc = e
            log.warning("LLM %s attempt %d failed: %s", purpose, attempt + 1, e)
            if "429" in str(e) or "rate_limit" in str(e).lower():
                break
            time.sleep(1.5 * (attempt + 1))
    raise LLMError(f"{purpose} LLM call failed after retries: {last_exc}")


def parse_json(text: str) -> dict:
    """Robustly parse a JSON object out of an LLM reply (handles ```json fences, prose)."""
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    text = text.strip()
    try:
        out = json.loads(text)
        if isinstance(out, dict):
            return out
    except json.JSONDecodeError:
        pass
    # first {...} block heuristic
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            out = json.loads(text[start:end + 1])
            if isinstance(out, dict):
                return out
        except json.JSONDecodeError:
            pass
    raise LLMError(f"could not parse JSON from LLM reply: {text[:200]!r}")
