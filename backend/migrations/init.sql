-- v1 schema. All interview data is per-UUID session, tied to an opaque candidate_id (browser cookie).

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY,
  candidate_id  UUID NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  status        TEXT NOT NULL DEFAULT 'created',      -- created|in_progress|completed|error
  role          TEXT,
  level         TEXT NOT NULL DEFAULT 'entry',        -- entry|mid
  resume_original_name TEXT,
  resume_text   TEXT,
  resume_structured JSONB,                            -- skills/projects/education/...
  jd_text       TEXT,
  rounds        JSONB NOT NULL DEFAULT '[]',          -- ["A","B","C"] selection
  durations     JSONB NOT NULL DEFAULT '{}',          -- {"A":15,"B":20,"C":15}
  deleted       BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_sessions_candidate ON sessions(candidate_id) WHERE deleted = FALSE;

CREATE TABLE IF NOT EXISTS rounds (
  id          UUID PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  round_type  TEXT NOT NULL,                          -- A|B|C
  seq         INT NOT NULL,                           -- order within session
  status      TEXT NOT NULL DEFAULT 'pending',        -- pending|active|closing|completed|aborted
  time_budget_min INT NOT NULL DEFAULT 15,
  started_at  TIMESTAMPTZ,
  ended_at    TIMESTAMPTZ,
  meta        JSONB NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rounds_session_seq ON rounds(session_id, seq);

CREATE TABLE IF NOT EXISTS questions (
  id          UUID PRIMARY KEY,
  round_id    UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ord         INT NOT NULL,                           -- 1-based sequence within round
  topic       TEXT,
  difficulty  TEXT,
  kind        TEXT NOT NULL DEFAULT 'oral',           -- oral|dsa|design
  payload     JSONB NOT NULL DEFAULT '{}'             -- full question text, visible tests, etc.
);

CREATE TABLE IF NOT EXISTS answers (
  id            UUID PRIMARY KEY,
  question_id   UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  round_id      UUID NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  answer_text   TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT 'text',          -- text|stt
  evaluation    JSONB                                   -- verdict 0-10, evidence, probe note
);

CREATE TABLE IF NOT EXISTS code_submissions (
  id            UUID PRIMARY KEY,
  question_id   UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  language      TEXT NOT NULL,
  code          TEXT NOT NULL,
  test_results  JSONB,                                  -- per-test pass/fail summary
  passed        BOOLEAN,
  runtime_ms    INT
);

CREATE TABLE IF NOT EXISTS reports (
  id          UUID PRIMARY KEY,
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  round_id    UUID REFERENCES rounds(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,                            -- round|final
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload     JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS llm_usage (
  id          BIGSERIAL PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_id  UUID,
  purpose     TEXT NOT NULL,                            -- conductor|evaluator|extractor|generator|report|salary
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  tokens_in   INT,
  tokens_out  INT,
  latency_ms  INT,
  ok          BOOLEAN NOT NULL
);
