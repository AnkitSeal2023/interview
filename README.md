# SWE Mock Interview — AI-powered interview platform

An end-to-end mock-interview platform for entry/mid SDE–SWE roles: upload a resume (PDF),
optionally a JD, pick rounds — run a realistic one-question-at-a-time interview with local STT
and browser TTS — get evidence-backed reports and an INR salary estimate.

Stack: **FastAPI + Postgres (existing docker) + Next.js (Tailwind/shadcn) + pluggable LLMs**
(free local Ollama by default; Groq/Gemini free tiers switchable via `.env` only).

## Quickstart

```bash
./scripts/quickstart.sh        # Ubuntu/Arch: installs deps, asks for the Groq API key,
                               # writes .env, sets up Postgres, migrates, launches all
                               # services (backend :8000 · tts :8001 · frontend :3000)
./scripts/quickstart.sh stop   # or: status | restart; -tts also installs the local voice
```

Manual setup still works:

```bash
# 1. DB (idempotent; uses the running docker Postgres on :5432 — check .env creds)
cd backend && uv run python scripts/apply_migrations.py

# 2. Backend  (or: scripts/backend.sh start from the repo root)
cd backend && uv run uvicorn app.main:app --port 8000

# 3. Frontend
cd frontend && npm run dev        # http://localhost:3000 (proxies /api → :8000)
```

Local models (default config): `ollama pull qwen2.5:7b-instruct-q4_K_M` (~4.7GB, CPU, ~15GB RAM
needed), and the STT model downloads on first use into `backend/whisper_models`.

## Configuration (`.env` — see `.env.example`)

| Var | Meaning |
|---|---|
| `DATABASE_URL` | existing Postgres (default `postgresql://postgres:2004@localhost:5432/interview`) |
| `LLM_<PURPOSE>_PROVIDER` | per-purpose model routing: `conductor` (turns), `evaluator` (per-answer), `report`, `generator` (DSA problems), `extractor` (resume) — values `ollama|groq|gemini` |
| `GOOGLE_API_KEY` / `GROQ_API_KEY` | only for hosted providers (free tiers OK) |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | local Ollama endpoint/model |
| `SALARY_CAP_INR` | salary estimator cap (**default 200000/yr — deliberately configurable**, see SPEC §6) |
| `STT_MODEL` | faster-whisper size: `tiny|base|small` |

**Quotas & limits (documented, not guaranteed):** Groq free tier ≈ 30 req/min & 14.4k req/day;
Gemini 2.0 Flash free tier ≈ 15 RPM / 1500 req/day — both rotate/change; the app always works
with the local Ollama fallback. Every LLM call is recorded in the `llm_usage` table.

## What it does

- **Round A** – technical/project oral: anti-regurgitation probing, ≤2 follow-ups per answer,
  topic-breadth enforcement, "I don't know" handled as skipped, wrap-up when time budget ends.
- **Round B** – DSA: generated problem **validated at generation time by actually running the
  reference solution against the generated hidden tests** in a sandbox; falls back to a curated
  bank if generation fails thrice. Candidate runs samples + submits; hidden tests run in a
  restricted subprocess (no network, CPU/mem limits, timeouts). Judging is deterministic —
  the LLM only evaluates the explanation.
- **Round C** – system design: staged (problem → schema/API → failure/security → trade-offs).
- **Reports** – per-round + final: overall /10, per-competency scores (only scored when
  actually tested), evidence quotes, misconceptions, prioritized study plan, and a salary range
  with explicit assumptions (score only modulates salary ±15%).
- **Voice** – mic (faster-whisper, local) for answers; browser speechSynthesis for questions.
- **Accounts & history** – optional accounts (email + PBKDF2-hashed password, signed HttpOnly
  cookie). Interviews are anonymous by default and **claimed into your account at
  register/login**, so history survives across browsers; `Delete all my data` hard-soft-deletes
  every account session/report (delete capability, SPEC §8). `AUTH_SECRET` in `.env` signs
  tokens (set a long random string in any real deployment).
- **Data** – every question/answer/report persisted to Postgres (`llm_usage` logs each model call).

## Testing

```bash
cd backend && uv run pytest            # smoke tests (health, upload happy/sad, ownership)
uv run python backend/scripts/apply_migrations.py
python3 backend/../scripts/benchmark.py --tasks all   # model comparison; records to benchmark_results/
```

Benchmark results so far (local `qwen2.5:7b-instruct-q4_K_M`, see PLAN.md + `benchmark_results/`):
mechanical checks 100% JSON-valid, but only **0/3 vague-answer follow-ups pushed for concrete
evidence** — hosted models are benchmarked with `GROQ_API_KEY`/`GOOGLE_API_KEY` set.

## Project layout

```
backend/app/llm/            provider abstraction (ollama|groq|gemini), usage logging
backend/app/routers/        resume, interview (rounds A/B/C), coding, reports, stt
backend/app/services/       extraction, conductor, code_run (sandbox), dsa_gen, report, salary
backend/migrations/         init.sql
frontend/src/app/           / (setup) · /session/[id] (chat+editor) · /reports (list/detail)
scripts/benchmark.py        reproducible model comparison
```
