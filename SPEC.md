# SPEC — AI-Powered Role Mock Interview Platform

## 1. Goal

An interactive mock-interview platform for entry/mid technical, analytical, and product roles. The candidate uploads a
resume (PDF), optionally a job description, selects rounds, and is interviewed one question at
a time by an AI that probes understanding, challenges vague claims, and adapts difficulty.
After each round and at the end, the platform produces an evidence-backed report with scores,
strengths/weaknesses, prioritized study advice, and a salary estimate in INR.

Priorities (in order): interview quality & evaluation accuracy → realistic experience/useful
feedback → minimal cost (preferably free) → maintainable architecture and usable UI.

## 2. Candidate input

| Input | Required | Notes |
|---|---|---|
| Resume PDF | yes | Extracted server-side to plain text; structured (skills/projects/education) via LLM with a **rule-based fallback** if no model is available or extraction is empty. |
| JD | optional | Free text/paste up to ~20k chars. Shapes question selection and target‑role inference. |
| Rounds selection | yes | Any subset of A (Technical/Project), B (DSA), C (System Design), any order. |
| Target role | optional | Choose a role such as Software Engineer, Data Analyst, Data Scientist, AI/ML Engineer, Data Engineer, DevOps/Cloud Engineer, Cybersecurity Analyst, QA/Test Engineer, Product Manager, Business Analyst, or UX/Product Designer; or infer it from the resume and JD. |
| Target experience level | optional | `entry` (default) / `mid`. If unknown, inferred from resume years-of-experience + title. |

Unreadable/oversized (>15 MB) or non-PDF/empty files are rejected with a clear error; the
platform never crashes on a malformed resume — it degrades to resume-less generic SWE mode if
extraction yields too little text (<200 chars) with a visible warning.

**Anti-regurgitation rule** (enforced by prompts and question planner): the interviewer is
instructed to *not* ask what is already printed on the resume; it must ask how/why/what-if and
follow up on claims. Resume facts are used as *attack surface*, not quiz material.

## 3. Rounds

### Round A — Technical + Project interview (oral, 10–20 min, default 15)
Covers: resume projects (deep probing), OOP, DBMS, OS, CN, general SWE judgment.
Behavior: one question at a time; LLM generates each next question from the running transcript
+ structured resume + remaining topic coverage; it must mark what was **already asked** to
avoid repeats. Difficulty adapts: strong crisp answers → deeper/harder follow-ups; vague →
short probe, then move on. Candidate may ask clarifying questions; "I don't know" is accepted
and logged as `skipped`, not silently ignored.

### Round B — DSA (timed, configurable, default 20 min)
1. LLM picks 1–2 problems matched to resume level (topic, difficulty tier: easy/medium).
2. Problem statement, constraints, small example I/O, and a **hidden test suite** (runnable
   harness) are generated *together* — tests are real and deterministic, not LLM-judged-only.
3. Candidate writes code in an embedded editor (Python or JavaScript), can run visible
   samples, then submits → all hidden tests executed in a restricted sandbox
   (`subprocess` + rlimits/timeout/no-network). Result: pass/fail per test + runtime/timeouts.
4. The candidate then explains approach/complexity; LLM evaluates *reasoning*, not correctness
   (correctness comes from the sandbox).

### Round C — System Design (oral, 10–25 min, default 15)
Entry level ⇒ "build the API and data model" style low-level design (e.g. rate limiter,
url-shortener, class roster service); mid level ⇒ scalable architecture. Follow-ups on data
modeling, API shape, consistency, failure handling, security; scored on trade-off reasoning.

### Duration
Oral rounds default 15 min, configurable per round (5–60); visible before starting each round.
A soft time budget is tracked; when reached, the conductor wraps up gracefully and closes the
round. Task rounds show a visible countdown in the UI.

## 4. Realistic interviewer behavior

- Full per-round conversational context (every question/answer kept).
- No repeated questions (conductor passes the asked-questions list to the LLM each turn).
- Follow-ups generated from the *last* answer; max 2 follow-ups on one answer before moving on.
- Professional tone: neutral, evaluative, no tutoring during the round. (Tone checked in model benchmark.)
- Completion: when the topic plan is covered **or** time budget is spent → the conductor asks
  its final wrap-up question and closes the round with a definitive state ("Round complete").
- Uncached LLM failures mid-interview return a friendly retryable error; the interview state is
  persisted after every turn, so a refresh never loses progress.

## 5. Scoring & evaluation

Overall score **/10** plus competency scores:

| Competency | Applies to |
|---|---|
| Technical correctness & conceptual understanding | A, C (concepts) |
| Problem-solving & algorithmic reasoning | A (if probed), B (explanation) |
| Code correctness & quality | B (test pass-rate + code review) |
| Communication & explanation | A, B, C |
| Project ownership & depth | A (project part) |
| Design reasoning & trade-offs | C |

Rubric per competency (0–10 with anchors at 2/5/8) is sent to the evaluator LLM. Every score
must cite **evidence** (quoted answer snippets, test results, design decisions). Per-question
evaluations distinguish `correct | partially_correct | incorrect | skipped | not_assessed`; a
round totals are computed on *assessed* items only, so candidates are never punished for
untested competencies. Each competency score carries a `confidence` (low/med/high) plus a
short limitation note (e.g. "3 OS questions asked, sample size is small").

## 6. Final report

Per-round report on round close; consolidated report after all selected rounds. Contents:
overall /10, per-round and per-competency tables, strongest areas with quoted evidence,
weak/misconceptions with examples and correct reasoning, **prioritized study topics** with concrete
exercises, incorrectly/incompletely answered questions with expected reasoning, interview
readiness for the role, and salary range in INR with assumptions/confidence/limits.

### Salary estimation
Constraint: ₹0–₹2,00,000 per annum (plainly well below Indian entry-level reality) is the
**initial configurable cap** — `SALARY_CAP_INR` in `.env`, default `200000`, changeable. The
estimator centers on: skills × market demand, project/internship depth, education tier,
target role/level, location if present; interview score acts as a **modulator**, never the sole
input. Output: range `[min, max]` + point estimate + bullets of explicit assumptions +
confidence band; if evidence is thin, it says "insufficient evidence" instead of inventing
a precise number.

## 7. Model selection (cost-aware)

Model call types:
- **conductor** (per-turn interviewer): needs fast latency + decent reasoning.
- **evaluator** (per-answer scoring): quality > latency, runs off-turn.
- **extractor** (resume → structured JSON), **generator** (DSA problem + tests): same pool.

Runtime-local free first: we benchmark and compare **local Ollama (Qwen2.5-7B-Instruct Q4_K_M,
CPU)** vs **Groq free tier (`llama-3.3-70b-versatile` / `qwen-2.5-32b`)** vs **Google Gemini
free tier (`gemini-2.0-flash` / `gemini-2.5-flash`)** using `scripts/benchmark.py` on
representative tasks: (1) conductor turn generation, (2) adversarial follow-up after a vague
answer, (3) resume → structured JSON, (4) DSA problem + executable tests, (5) evaluator
scoring against a gold answer. Metrics: rubric-adherence (spot-checked), JSON validity rate,
p50/p95 latency, tok/s, and $ / 1000 interviews. **Results are recorded in PLAN.md — no invented
numbers.** Provider is selected per role in `.env` (`LLM_CONDUCTOR=...`), swappable without code
changes. Note API free tiers are rate-limited and not guaranteed unlimited; a `usage` table
tracks every LLM call (tokens in/out) for transparency.

Local STT: `openai-whisper` or `faster-whisper` (`base`/`small` model, CPU) via `/api/stt`
endpoint. Browser TTS: `speechSynthesis` — no cost. No hosted STT/TTS in v1; if the free LLM
tier alone exceeds quota, we fall back to local Ollama and document the trade-off.

## 8. Tech & data

- **Backend** Python 3.14 + FastAPI + `psycopg` (Postgres), PDF text-extract via `pdfplumber`.
- **Frontend** React 18 + Vite + TypeScript, `@uiw/react-codemirror` for coding editor; plain CSS.
- **DB** Postgres on port 5432 (connection URL in `.env`, not committed).
- **Schema** (single `migrations/init.sql`): `sessions`, `rounds`, `questions`, `answers`,
  `code_submissions`, `reports`, `llm_usage`. All keyed by `session_id UUID`, tied to a browser
  `candidate_id` cookie — no passwords, resumes only readable by the browser that uploaded them.
- **Code sandbox** separate `routers/coding.py` runner mode: temp dir, no network, memory &
  CPU rlimits, 10s wall clock, kills on timeout; output sanitized.
- **Data deletion** one-click "Delete my data" removes all sessions + resumes for the browser
  identity. Only technical resume data is stored — no sensitive extracts retained.

## 9. UI

- Home: identity-free landing → upload resume (drag/drop or file picker) + JD textarea +
  round checkboxes + durations + experience level → Start interview.
- Session view: left pane = chat (one LLM question at a time, mic button for speech, TTS play),
  right pane = round status, time budget, configurables.
- DSA round: chat + editor side-by-side (run sample / submit buttons, live test summary).
- Reports view: session list, per-round reports, final consolidated report, delete button.
- Empty/error states for every LLM/db/STT failure; graceful "model error, resume" toast.

## 10. Out of scope for v1
Multi-candidate accounts (a cookie suffice), proctoring/anti-cheat, video/pseudocode judging,
extra interview rounds (HR/behavioral) — revisit after v1.

## 11. Risks / decisions log
Kept in PLAN.md §Decisions.
