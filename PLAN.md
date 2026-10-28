# PLAN — Phased implementation, decisions, progress

Working dir: `/mnt/win/Users/ankit/Documents/Studies/coding/projects/interview`
Read SPEC.md first; update this file after each phase.

## Architecture (final for v1)

```
frontend/  Next.js (App Router, Tailwind, shadcn)     → http://localhost:3000 (proxies /api)
backend/   FastAPI + uvicorn + psycopg                → http://localhost:8000
           app/llm/        provider abstraction: gemini | groq | ollama
           app/routers/    resume, sessions, interview, coding, stt, reports
           app/services/   extraction, conductor, evaluator, report, salary, sandbox
db         existing docker postgres @ localhost:5432 (POSTGRES_USER=postgres,PW from .env)
```

Key decisions (D#) — revisit freely, but log it here:
- **D1** Model layer: swappable `LLMProvider` protocol `complete(messages, json_schema?) → {text, usage}`.
  Roles (conductor / evaluator / extractor / gardener) each map to a provider via `.env`.
  Rationale: SPEC §7 requires replaceability; re-testing a different model == editing `.env`.
- **D2** Benchmark 3 candidates: Ollama Qwen2.5-7B (free/local), Groq llama-3.3-70b (free API),
  Gemini 2.x Flash (free API). Tasks in `scripts/benchmark.py`; real results recorded below (§Benchmarks).
- **D3** DSA correctness = deterministic sandbox tests (not LLM-judged). Tests are *generated together with
  the problem* and stored; the generator must produce a brute-force reference solution so hidden tests are
  cross-validated at generation time. If generation-time validation fails 3×, we fall back to a curated
  static problem bank (in-repo JSON).
- **D4** Persistent anonymity: `candidate_id` cookie (UUID) issued on first visit; all rows tie to it.
  One-click delete wipes everything for that cookie. No passwords/accounts in v1.
- **D5** Resume extraction: pdfplumber text → LLM structured JSON; falls back to regex/heuristic parser
  when LLM unavailable/low-confidence. No API key ⇒ whole app still works locally (Ollama).
- **D6** State: every question/answer persisted as rows; the interview resumes from DB on reload,
  so refreshes/failures never lose progress.
- **D7** Salary cap default ₹2,00,000/yr per SPEC §6 ("initial configurable constraint") — plainly
  unrealistic for Indian SWE roles; kept as `SALARY_CAP_INR` in `.env` so it can be raised without code.

## Phases

### Phase 0 — Scaffolding & planning ✅
- [x] SPEC.md, PLAN.md, .env.example, .gitignore, README skeleton
- [x] Repo inspection: Postgres up on :5432 (pw: 2004), Node 22, uv available. CORRECTED 27 Oct:
      the box DOES have an AMD Radeon RX 6600 (8GB VRAM, ROCm) — Ollama runs 100% on GPU
      (`ollama ps`: "100% GPU", model fully resident in VRAM); repairs earlier assumption of CPU-only.
      Ryzen 5 5500, ROCm dev stack present. faster-whisper STT stays CPU-only (CTranslate2's only
      GPU backend is CUDA; AMD acceleration there needs whisper.cpp/HIP or Groq's whisper API).
      ollama installed but empty (pull `qwen2.5:7b-instruct-q4_K_M` running for local provider testing).
- [x] Decisions D1–D7 logged (LLM = benchmark-first, both Groq+Gemini free tiers, local fallback).

### Phase 1 — DB schema + backend skeleton ✅
- [x] `migrations/init.sql` (tables per SPEC §8), applied via `scripts/apply_migrations.py` (also creates the `interview` DB).
- [x] FastAPI app boot on :8000, `/api/health`, pydantic-settings config, CORS for :3000.
- [x] Anonymous `cand` cookie identity (works on first request via request.state fallback — no reload dance).
- [x] `POST /api/resume`: pdfplumber extract → `sessions` row; rejects non-PDF (400), empty (400), >15MB (413),
      unparseable (422), scan-like/no-text (422 with guidance). `uv run pytest` → 5/5 passed.
- Fixture: `scripts/make_fixture_pdf.py` (fpdf2, dev dep) generates test PDFs.

### Phase 2 — LLM abstraction + benchmark ✅ (gemini row pending key)
- [x] `app/llm/provider.py` — GeminiProvider (native responseSchema), GroqProvider (json mode), OllamaProvider (json mode); per-purpose routing from `.env`; `llm_usage` logging; robust `parse_json`.
- [x] `scripts/benchmark.py` — 5 tasks (conductor, followup, extract, dsa, eval) × available providers; JSON saved to `benchmark_results/`.
- [x] Resume structured extraction (LLM-first; heuristic fallback D5) with tolerant validation for small-model quirks.
- [x] **Measured results so far** (`benchmark_results/bench_20261027_17*.json`, local Qwen2.5-7B Q4 on RX6600/ROCm):
      conductor/dsa/eval JSON validity 100%, verdict accuracy 100% (3 golds),
      but followup `pushes_for_evidence = 0/3` (vague answers not challenged — quality gap).
- [ ] Gemini/Groq rows — Groq done (see Benchmarks table; keys added 2026-10-27, defaults
      chosen); Gemini needs `GOOGLE_API_KEY` to run the same script.

### Phase 3 — Round A oral conductor ✅
- [x] Opening + next-question generation with: asked-question suppression, ≤2 follow-up streak,
      topic-count coverage nudge, time-budget wrap-up (≤2.5min), quick per-answer verifications
      (verdict/evidence/adjust) persisted. Verified live (ollama/ROCm); refresh-resume via DB (D6).
- [x] Interviewer-quality fixes (27 Oct, from the user's live session stress-test):
      (1) meta-communication — evaluator reserves verdict `clarification` for process questions
      ("do you see my answers?" style); when the last verdict is `clarification` the conductor is
      instructed to answer the process question directly (≤25 words) and move on instead of
      treating it as a failed technical answer (E2E: "Yes, I see all your previous answers." then
      a fresh topic, twice in a row);
      (2) code-level duplicate suppression — `_near_duplicate` (difflib ratio >0.72 OR token
      Jaccard >0.55) rejects near-verbatim rephrases with up to 3 regeneration attempts and a
      REJECTED OUTPUT note back to the model; degrades gracefully (logs, accepts) instead of
      500ing the turn; ASKED list widened to last 18 questions untruncated (was 12 @ 160 chars);
      verified: session's real rephrase caught, genuinely-different questions pass;
      (3) topic exhaustion — when a topic has been probed ≥2x with no substantive answer (last
      verdict incorrect or non-correct), a STOP-probing note forces a different topic;
      (4) evaluator prompt: clarification never usable for vague/off-topic technical answers.
- [x] Extractor latency fix (27 Oct): structured extraction moved to groq — measured ~31s (local
      qwen, real resume) → ~3.7s. Also fixed StructuredResume (and nested models) coercing JSON
      `null` string fields to "" instead of failing validation into the heuristic fallback.
      Reran live: method=llm, persisted.

### Phase 4 — Round B DSA ✅
- [x] Sandbox (`code_run.py`): temp dir, minimal env, `RLIMIT_AS`/`RLIMIT_CPU`, 10s wall,
      socket blocked, Python + JS (node). Verified: correct/wrong/missing-fn/timeout/network-block.
- [x] Generator with generation-time cross-validation (reference run vs ALL generated cases);
      static fallback bank (two-sum, valid-parentheses, merge-intervals) auto-selected after 3 fails.
- [x] Fixed double-question race (27 Oct): React StrictMode double-mount fires two concurrent
      `POST /rounds/{id}/open` → both read `meta.opened` unset → two opening questions created.
      Fix: atomic conditional-UPDATE claim (`WHERE NOT (meta ? 'opened')`) — the winner generates,
      the loser waits bounded for the winner's question and returns identical state. Verified
      with concurrent curl threads ([1,1], single question). Duplicate opener in the user's live
      round cleaned up manually.
- [x] Fixed multi-round flow (27 Oct): `start` created ONLY the first round even when several
      were checked (comment said "rest pending" but code never did) → "Start next round" had
      nothing to open; additionally `open` refused non-active rounds, so pending rounds could
      never activate. Fixed: `start` merges and creates all requested rounds (first active when
      fresh, additions pending; idempotent — verified), `open` claims + activates pending rounds
      atomically, `new_round` gained a status param. UI: nextRound refetches rounds and falls
      through to the final report instead of silently no-oping; input disabled on completed
      rounds; home page now defaults to all three rounds checked. User's live session repaired
      (pending B/C inserted, rounds list updated). E2E verified via HTTP.
- [x] Endpoints: create problem (hidden tests live in `rounds.meta`, never sent to client),
      run-samples, submit (hidden+summary stored). E2E verified: 5/5 pass on correct code,
      2/5 on wrong code, fail-fast on missing entry fn.

### Phase 5 — Round C system design ✅
- [x] Round-type-aware conductor (ROUND_C_RULES staged progression), design opening question.
      Verified live (URL shortener: schema/API → scale/keys → security → failure).

### Phase 6 — Reports & salary ✅
- [x] Round report + final report (test-proven code-correctness aggregation, tested-only
      competency weighting, confidence per competency), salary estimator honoring SALARY_CAP_INR
      with assumptions/confidence/limitations (verified: evidence-thin ⇒ "low").
- [x] Fixed final-report 500 (27 Oct): role "Full-Stack Engineer".lower()=="full-stack engineer"
      matched no ROLE_PREFIXES key ("full stack" has a space) → `max()` on empty generator.
      Fixed: dashes/slashes normalized to spaces, "sde|software" added to the table, and
      `max(..., default=0.9)` as a generic fallback for unknown roles. Verified in-process.
- [x] Reports UI list + detail.

### Phase 7 — Voice ✅ (basic)
- [x] `/api/stt` faster-whisper `base` (CPU/int8, lazy-loaded once); mic button + browser TTS in UI.
- [x] Interviewer voice → local Coqui TTS (27 Oct, user request): replaced browser
      speechSynthesis with server synthesis — `tts_models/en/ljspeech/tacotron2-DDC` in a
      SEPARATE uv venv `backend/.venv-tts` (python 3.14 + CPU torch from download.pytorch.org
      + `coqui-tts`; the main venv is python 3.13 and must stay torch-free). Zero-dep stdlib
      service `backend/tts_service/` (ThreadingHTTPServer on :8001, `X-TTS-Key` shared secret,
      per-text sha256 WAV cache in /tmp/opencode/tts_cache, concurrent synths serialized,
      lazy model load); managed by `scripts/tts.sh start|stop|restart`. FastAPI `/api/tts`
      proxies with a generous timeout (first call includes one-time ~110MB model download);
      503 when down so the frontend falls back to browser voice. Frontend `speak()` plays the
      returned WAV blob via HTMLAudio (stops any current playback first), on any error falls
      back to speechSynthesis. Measured: RTF 0.448 (2.2x realtime on the Ryzen 5500), fresh
      ~20-word question 3.5s via the :3000 route, cached reply 8ms. Toggle relabeled
      "you (STT)" / "🔊 interviewer voice" (was one vague "TTS" button).
- [x] TTS latency work (27 Oct, user request): (1) BOOT PRELOAD — service spawns a thread
      calling _get_tts() at startup (log "model preloaded"), so cold start is gone: first
      spoken question pays only synthesis; (2) SENTENCE STREAMING — service POST /tts-stream
      emits NDJSON, one base64-WAV line per sentence (pysbd split, same splitter the Synthesizer
      uses internally), flush per line (HTTP/1.0 close-delimited); FastAPI /api/tts-stream
      passes the stream through unbuffered (503/error likewise forwarded as NDJSON so the
      browser can fall back); frontend `speak()` streams via fetch reader and schedules Web
      Audio buffers back-to-back (gapless), first audio while later sentences still render.
      Cold measured: first ~8s-of-speech chunk ready +4.0s, second +6.3s (old whole-text path:
      nothing before +6.3s); first line ~1.5s for short leads. Playback fallback ladder:
      streamed WebAudio → whole-blob HTMLAudio → browser speechSynthesis. Gotcha fixed during
      E2E: do_POST must read the request body EXACTLY ONCE /tts-stream routes with the parsed
      text — the second rfile.read() deadlocks (server waits for consumed bytes, client waits
      for the response).
- [x] Ops scripts unified (27 Oct, user request): `scripts/frontend.sh start|stop|restart|status`
      (Next dev :3000, same verb set as backend.sh/tts.sh) and `scripts/status.sh` — one command
      printing every service's pid/state/port/health + per-log tail with error counts. ALL
      runtime artifacts live under /tmp/opencode/: `backend.log|pid`, `tts.log|pid` (plus
      `tts_cache/` WAV cache), `frontend.log|pid`; TTS engine venv stays in
      `backend/.venv-tts/` (recreate with: uv venv → CPU-torch index → coqui-tts).
- [x] Fixed PyAV/faster-whisper incompatibility (27 Oct): faster-whisper 1.2.1 (latest) passes
      `metadata_errors=` to `av.open`, removed in PyAV 15+ — every mic upload 500'd on decode.
      Upstream has no fixed release (`av>=11` constraint too loose); patched in-process by
      dropping the kwarg in `stt.py` (`_patch_av_open`, idempotent). Verified via HTTP 200
      decode+transcribe of a synthesized webm/opus clip.
- Latency on 12-core CPU: acceptable for short clips; tune via `STT_MODEL` if needed.

### Phase 8 — Polish, docs, final test 🚧
- [x] Fixed interviewer-TTS replay on reload (27 Oct, user report): the speak effect fired on
      every `tells.length` change INCLUDING the first build after page load → the current
      question was re-spoken on every refresh. Now each question is spoken exactly once,
      marked in localStorage (`spoken:<sid>:<round_id>:<ord>`) BEFORE speak() — a set marker is
      never re-spoken; StrictMode double-mount safe; marker set even if playback fails (text
      remains on screen).
- [x] Live round countdown on the session UI (27 Oct, user request): replaces the static
      "budget: X min" text — `useCountdown` derives remaining time from `round.started_at` +
      `time_budget_min` and ticks each second (mm:ss, red under 2.5 min = the backend's
      wrap-up threshold, "budget: X min" fallback only if the timestamp can't be parsed:
      Postgres ts text "…+00" needs T-separator + "+00"→"+00:00" normalization before Date()).
- [x] Frontend migrated to **Next.js + Tailwind + shadcn (black/gray grid-lined theme)** per user choice.
- [x] README (setup/env/quota docs).
- [x] **User accounts & auth (user request)**: `users` table (002_users.sql), PBKDF2-HMAC-SHA256
      passwords (600k iters), HMAC-signed `auth` cookie token (AUTH_SECRET, 30-day TTL);
      `POST /api/auth/register|login|logout`, `GET /api/auth/me`. Anonymous sessions are
      **claimed** into the account at register/login (server-verified E2E: claimed=1, user-scoped
      history). Ownership: user-scoped sessions return 403 "sign in…" to other browsers;
      wrong password 401, duplicate email 409. History `GET /api/sessions` is user-scoped when
      signed in, browser-scoped otherwise. `DELETE /api/me/data` marks all account sessions
      deleted (scope:"account"). pytest auth tests added (9/9 pass). Frontend: `/login`
      (register/login tabs), header `UserMenu` (identity/sign-out/delete-all-data),
      reports page scope banner. Verified through the :3000 proxy (Set-Cookie survives rewrite).
- [x] Fixed stale-process failure mode documented: `backend.sh restart` killed the pidfile PID
      while an older uvicorn (stale code) still owned :8000 → "missing routes 404" red herring;
      now verified pidfile vs `ss -ltnp` after restart.
- [x] Hosted-provider comparison: Groq benchmarked (see Benchmarks), per-role defaults chosen
      and live-verified in an interview turn. Gemini row still open (`GOOGLE_API_KEY`).
- [ ] Final full-stack E2E with all three rounds in the signed-in state.

## Benchmarks (real results only — fill from scripts/benchmark.py runs)

Measured 2026-10-27 (`benchmark_results/bench_20261027_17*.json`):

| Provider / model | conductor turn | follow-up pushes for evidence | resume→JSON | eval verdict accuracy | DSA w/o bank | p50 latency |
|---|---|---|---|---|---|---|
| ollama qwen2.5:7b q4 (ROCm GPU, RX 6600) | 3/3 valid, 1 question, ≤80w | 1/3 | 3/3 correct | 3/3 | 1/3 (78s) | ~2.0s turn |
| groq openai/gpt-oss-120b (free) | 3/3 valid, 1 question, ≤80w | 2/3 | 3/3 correct | 3/3 | 0/3 (47s) | ~1.2s turn |

Notes:
- gpt-oss-120b is a reasoning model — burn ~750 output tokens even for tiny JSON; fine on free tier, recorded in `llm_usage`.
- All rows 100% JSON-valid via the app's `parse_json` hardening, so interchange risk is provider-independent.
- The live E2E turn confirmed the difference beyond the benchmark: after a vague answer, the
  hosted conductor asked a pointed WAL follow-up ("log flushing, crash recovery, data
  consistency", probe_reason "previous answer was vague"); the local model never did this
  (followup task originally scored 0/3).
- Groq's free catalog rotated (llama-3.3-*-versatile removed); pinned `GROQ_MODEL=openai/gpt-oss-120b` after querying the live `models.list()`.
- DSA generation hit-rate is low for both on entry-level requests → generation-time validation +
  curated bank fallback carry the load either way; generator stays local/free.

**Per-role defaults chosen (2026-10-27, set in `.env`):**
conductor=**groq**, evaluator=**groq**, report=**groq**, extractor=**ollama**, generator=**ollama**.

Gemini row pending a `GOOGLE_API_KEY` (same script).

## Remaining work
Echo of unchecked boxes above; keep in sync.
