import os
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings

BASE_DIR = Path(__file__).resolve().parent.parent          # backend/
PROJECT_DIR = BASE_DIR.parent                               # repo root


class Settings(BaseSettings):
    database_url: str = "postgresql://postgres@localhost:5432/interview"

    llm_conductor_provider: Literal["gemini", "groq", "ollama"] = "ollama"
    llm_evaluator_provider: Literal["gemini", "groq", "ollama"] = "ollama"
    llm_extractor_provider: Literal["gemini", "groq", "ollama"] = "ollama"
    llm_generator_provider: Literal["gemini", "groq", "ollama"] = "ollama"
    llm_report_provider: Literal["gemini", "groq", "ollama"] = "ollama"

    google_api_key: str = ""
    groq_api_key: str = ""
    groq_model: str = "openai/gpt-oss-120b"  # strongest Groq free-tier chat model (verified live 2026-10-27)

    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "qwen2.5:7b-instruct-q4_K_M"

    cost_per_mtok_input_usd: float = 0.0
    cost_per_mtok_output_usd: float = 0.0

    salary_cap_inr: int = 200_000

    auth_secret: str = "dev-insecure-secret"  # HMAC secret for login cookies; override in .env

    stt_model: str = "base"
    tts_service_url: str = "http://localhost:8001"
    tts_internal_key: str = "dev-insecure-tts-key"  # shared secret with the local tts_service
    max_resume_mb: int = 15
    frontend_origin: str = "http://localhost:3000"

    model_config = {
        "env_file": (".env", str(PROJECT_DIR / ".env")),
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
os.environ.setdefault("HF_HOME", str(BASE_DIR / "whisper_models"))
