export type QuestionItem = {
  question_id: string;
  ord: number;
  topic: string | null;
  difficulty: string | null;
  kind: string; // oral | dsa
  payload: {
    text?: string;
    intro?: string;
    is_followup?: boolean;
    is_wrapup?: boolean;
    probe_reason?: string;
    title?: string; // dsa
    statement?: string;
    fn_name?: string;
    signature?: string;
    samples?: { input: unknown[]; output: unknown }[];
    expected_complexity?: string;
    provenance?: string;
    response_window?: {
      response_window_seconds: number;
      nudge_after_seconds: number;
    };
  };
  created_at?: string;
  answers: { id: string; text: string; source: string; evaluation: Eval | null }[];
};

export type Eval = {
  verdict?: "correct" | "partially_correct" | "incorrect" | "skipped" | "clarification";
  evidence?: string;
  adjust?: "easier" | "same" | "harder";
};

export type RoundState = {
  round_id: string;
  session_id: string;
  round_type: "A" | "B" | "C";
  status: string;
  current?: boolean;
  idle_nudge?: { question_id: string; text: string } | null;
  time_budget_min: number;
  started_at: string;
  questions: QuestionItem[];
};

export type StructuredResume = {
  name?: string;
  skills?: string[];
  projects?: { name: string; description?: string; tech?: string[] }[];
  inferred_level?: string;
  inferred_target_role?: string;
  extraction_method?: string;
};

export type SessionView = {
  session_id: string;
  status: string;
  role: string | null;
  level: string;
  rounds: string[];
  durations: Record<string, number>;
  jd_text: string | null;
  resume_structured: StructuredResume | null;
  resume_original_name: string | null;
  stages?: [string, string, string];
};

export type TestSummary = {
  passed: number;
  total: number;
  all_passed: boolean;
  error?: string;
  first_failure?: { input?: unknown; expected?: unknown; got?: unknown; error?: string } | null;
};
