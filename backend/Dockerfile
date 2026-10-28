# SWE Mock Interview — backend (FastAPI + local STT). Built from backend/ context.
# Secrets are injected at runtime via docker-compose environment; nothing is baked in.
FROM python:3.12-slim

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
WORKDIR /app

# lockfile/pj first for layer caching; no-dev keeps the image lean (pytest/fpdf2 not needed)
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev

COPY app ./app
COPY scripts ./scripts
COPY migrations ./migrations

# faster-whisper downloads its model here on first STT use → kept in a named volume
ENV HF_HOME=/app/whisper_models
ENV HF_HUB_DISABLE_TELEMETRY=1
VOLUME /app/whisper_models

EXPOSE 8000
# migrations are idempotent (CREATE IF NOT EXISTS) so every container start repairs the schema
CMD ["sh", "-c", "uv run --no-sync python scripts/apply_migrations.py && exec uv run --no-sync uvicorn app.main:app --host 0.0.0.0 --port 8000"]
