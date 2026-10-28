# Tech Mock Interview — AI-powered interview platform

An end-to-end mock-interview platform for entry/mid tech roles: pick your
track (Software Engineer, Data Analyst, Data Scientist, AI/ML Engineer, Data Engineer,
DevOps/Cloud, others, or auto-detect from your resume/JD), upload the resume (PDF) and optionally a JD, pick
rounds — run a realistic one-question-at-a-time interview with local STT and browser TTS —
get evidence-backed reports and an INR salary estimate.

Stack: **FastAPI + Postgres (dockerized) + Next.js (Tailwind/shadcn) + pluggable LLMs**
(Groq hosted free tier is the tested default; Ollama/Gemini accepted via `.env` — Ollama is experimental).

## Installation

### What you need (prerequisites)

- **A Groq API key (free)** — the only thing you must provide. Get one in ~30 seconds:
  1. Go to **https://console.groq.com/keys** and sign in (email or Google — no card needed)
  2. Click **Create API Key**, copy it (starts with `gsk_`)

  That key runs the interviewer LLMs on Groq's free tier (~30 req/min, plenty for practice).
- **bash and curl** — present by default on Linux (on Windows use WSL; terminal-on-mac is untested — Linux is the supported path).
- **~10 GB disk + internet** for the Docker path (one-time image builds; the ~2 GB build is only for the optional local TTS voice).
- The **no-Docker path** needs ~1.5 GB disk and installs Node 20, uv and Postgres itself.

### 1. Get the code

```bash
git clone https://github.com/AnkitSeal2023/interview interview && cd interview      # or download & unzip
```

### 2. Run one command

**Recommended — Docker (plug & play, everything in containers):**

```bash
./scripts/compose.sh
```

It is safe to re-run at any time — every step is idempotent. On first run it will:

1. install Docker if it's missing (one-time, uses sudo)
2. ask you to **paste your Groq API key** (the only input required) and verify it
3. write database/TTS/auth secrets to `.env` (generated fresh, `chmod 600`, gitignored — never printed, never committed)
4. build and start three containers — frontend **:3000**, backend **:8000**, Postgres (internal only)
5. wait for health checks and tell you when it's ready

Want the interviewer to *speak* with a real (local) voice instead of the browser's built-in one?

```bash
./scripts/compose.sh --voice    # adds a ~2 GB one-time TTS image build; browser voice works fine without
```

> **Windows?** Use WSL2 (`wsl --install` in PowerShell, then everything above inside Ubuntu).
> **macOS / other?** Not tested — file an issue rather than pushing random fixes.

**No Docker installed and don't want it — native/dev path** (Ubuntu/Arch, tested e2e on fresh Ubuntu 24.04):

```bash
./scripts/quickstart.sh          # installs Node 20 + uv + Postgres natively, same Groq-key flow,
                                 # launches backend :8000 · tts :8001 · frontend :3000
```

Manual dev setup (you know your way around):

```bash
cp .env.example .env             # fill in your own DATABASE_URL + GROQ_API_KEY
cd backend && uv sync && uv run python scripts/apply_migrations.py
cd backend && uv run uvicorn app.main:app --port 8000
cd frontend && npm install && npm run dev   # http://localhost:3000 (proxies /api → :8000)
```

### 3. Verify it's up

Open **http://localhost:3000** in your browser — you should see the setup page where you
upload a resume (PDF), pick a role and rounds, and start your first interview.

From a terminal you can also check:

```bash
curl http://localhost:8000/api/health     # -> {"ok":true}
```

Note: the first interview answer may take a few extra seconds while the local
faster-whisper STT model (~150 MB) downloads once into a named docker volume.

### Daily commands

| command | does |
|---|---|
| `./scripts/compose.sh status` | show which services are running |
| `./scripts/compose.sh stop` | stop containers, **data is kept** |
| `./scripts/compose.sh down` | remove containers, data volumes still kept |
| `./scripts/compose.sh logs frontend` | tail any service's logs (`backend`, `frontend`, `db`, `tts`) |
| `./scripts/compose.sh stop && ./scripts/compose.sh` | restart everything |

Data lives in docker volumes (Postgres DB, whisper models, TTS cache); nothing on the
host except the project folder and `.env`. To **wipe everything** (containers + data +
secrets) and start clean:

```bash
./scripts/compose.sh down
docker volume rm interview_pgdata interview_stt-models interview_tts-cache
rm .env        # next run will re-ask for the Groq key and mint fresh secrets
```

### Troubleshooting

| Symptom | Fix |
|---|---|
| "port 3000/8000 already in use" | something else binds those ports (e.g. dev servers) — stop it, `./scripts/compose.sh stop` then up again |
| `error: curl not found` and no sudo | run as root (`su -c 'bash scripts/compose.sh'`) or install curl first |
| "cannot run sudo" | you're not root and have no sudoers rights — run as root instead |
| frontend responds but interviews fail | your Groq key was never verified — check `GROQ_API_KEY` in `.env`, then `./scripts/compose.sh restart` (or `docker compose restart` manually — `compose.sh restart` re-reads `.env`) |
| backend unhealthy | `./scripts/compose.sh logs backend` — migrations re-run on every start, so container restarts usually repair themselves |
| mic doesn't ask permission / no STT | use Chrome/Edge on `localhost` (browsers only grant mic to localhost or https) |
| `permission denied` on docker socket | `sudo usermod -aG docker $USER` then log out/in (script auto-falls back to sudo meanwhile) |

## Configuration (`.env` — see `.env.example`)

| Var | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection URL — set your own credentials in `.env` (never commit real ones) |
| `LLM_<PURPOSE>_PROVIDER` | per-purpose model routing: `conductor` (turns), `evaluator` (per-answer), `report`, `generator` (DSA problems), `extractor` (resume) — values `ollama|groq|gemini` |
| `GOOGLE_API_KEY` / `GROQ_API_KEY` | only for hosted providers (free tiers OK) |
| `OLLAMA_BASE_URL`, `OLLAMA_MODEL` | local Ollama endpoint/model |
| `SALARY_CAP_INR` | salary estimator cap (**default 200000/yr — deliberately configurable**, see SPEC §6) |
| `STT_MODEL` | faster-whisper size: `tiny|base|small` |

**Quotas & limits (documented, not guaranteed):** Groq free tier ≈ 30 req/min & 14.4k req/day;
Gemini 2.0 Flash free tier ≈ 15 RPM / 1500 req/day — both rotate/change; the app always works
with the local Ollama fallback. Every LLM call is recorded in the `llm_usage` table.

## What it does

- **Round A** – role-specific technical/experience oral: anti-regurgitation probing, ≤2 follow-ups
  per answer, topic-breadth enforcement, "I don't know" handled as skipped, wrap-up when time
  budget ends. Questions follow the selected role's focus and stages (SQL/dashboards for a
  Data Analyst, experimentation/modeling for a Data Scientist, ML systems for an AI/ML
  Engineer, projects/APIs/debugging for an SWE, and so on).
- **Round B** – DSA (Software Engineer track only; other roles get 422 by design): generated
  problem **validated at generation time by actually running the reference solution against
  the generated hidden tests** in a sandbox; falls back to a curated bank if generation fails
  thrice. Candidate runs samples + submits; hidden tests run in a restricted subprocess
  (no network, CPU/mem limits, timeouts). Judging is deterministic — the LLM only evaluates
  the explanation.
- **Round C** – systems + case design, staged (problem → concrete artifact → failure/risk →
  trade-offs): schema/API and scale for SWEs, metrics/SQL and dashboard work for analysts,
  experiment design for data scientists, pipeline/architecture for data engineers — the stages
  come from the selected role's profile.
- **Reports** – per-round + final: overall /10, per-competency scores from the selected role's
  competency set (only scored when actually tested), evidence quotes, misconceptions,
  prioritized study plan, and a salary range with explicit assumptions (score only modulates
  salary ±15%).
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
backend/app/role_profiles.py per-role interview designs (11 tracks: stages + competencies)
backend/migrations/         init.sql
frontend/src/app/           / (setup) · /session/[id] (chat+editor) · /reports (list/detail)
scripts/benchmark.py        reproducible model comparison
```
