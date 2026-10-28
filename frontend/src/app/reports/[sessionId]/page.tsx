"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { Spinner } from "@/components/ui/spinner";

type LooseText = string | { evidence?: unknown; [key: string]: unknown };
type Comp = { name: string; score: number | null; confidence?: string; evidence?: LooseText[] | LooseText };
type RoundRep = { overall: number | null; competencies: Comp[]; strengths?: LooseText[]; weaknesses?: LooseText[]; misconceptions?: LooseText[]; study_topics?: { topic: string; priority: string; exercise?: string }[]; confidence_note?: string };
type FinalRep = { overall: number | null; rounds: string[]; competencies: Comp[]; code_evidence?: { tests_passed: number; tests_total: number }; salary?: { available?: boolean; reason?: string; point_estimate_inr?: number; range_inr?: number[]; cap_inr: number; confidence: string; assumptions: string[]; limitations: string }; reports_used?: string[] };

export default function ReportPage() {
  const params = useParams<{ sessionId: string }>();
  const sid = params.sessionId;
  const [roundReps, setRoundReps] = useState<Record<string, RoundRep>>({});
  const [final, setFinal] = useState<FinalRep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [regenBusy, setRegenBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  async function regenerateFinal() {
    setRegenBusy(true);
    setErr(null);
    try {
      const fr = await api.post<{ payload: FinalRep }>(`/sessions/${sid}/final-report`);
      setFinal(fr.payload);
    } catch (e) {
      setErr(String(e));
    } finally {
      setRegenBusy(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const list: { report_id: string; kind: string; round_id: string | null }[] =
          await api.get(`/sessions/${sid}/reports`);
        const byRound: Record<string, RoundRep> = {};
        let foundFinal = false;
        for (const r of list) {
          const rep = await api.get<{ kind: string; payload: unknown }>(`/reports/${r.report_id}`);
          if (r.kind === "round" && rep.payload) {
            byRound[r.round_id ?? "?"] = rep.payload as RoundRep;
          }
          if (r.kind === "final") {
            foundFinal = true;
            setFinal(rep.payload as FinalRep);
          }
        }
        setRoundReps(byRound);
        if (!Object.keys(byRound).length && !foundFinal) setErr("no reports yet");
      } catch (e) {
        setErr(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [sid]);

  return (
    <div className="pt-6">
      {err && (
        <p className="rounded-[10px] bg-negative-bg px-3 py-2 text-sm text-negative">{err}</p>
      )}
      {loading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner /> Loading report…
        </p>
      )}
      {final && <FinalView rep={final} onRegenerate={regenerateFinal} regenBusy={regenBusy} />}
      {Object.entries(roundReps).map(([rid, rep]) => (
        <RoundReport key={rid} rid={rid} rep={rep} />
      ))}
    </div>
  );
}

function Score({ value, size = "lg" }: { value: number | null; size?: "lg" | "md" }) {
  const v = value ?? 0;
  const tone =
    value == null
      ? "text-[#949494]"
      : v >= 6
        ? "text-positive"
        : v >= 4
          ? "text-warning"
          : "text-negative";
  return (
    <span
      className={
        "num font-medium " +
        tone +
        " " +
        (size === "lg" ? "text-[32px] leading-none" : "text-xl")
      }
    >
      {value == null ? "—" : v}
      <span className="text-sm font-normal text-[#949494]"> /10</span>
    </span>
  );
}

function FinalView({ rep, onRegenerate, regenBusy }: { rep: FinalRep; onRegenerate?: () => void | Promise<void>; regenBusy?: boolean }) {
  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Final report</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Stages: {rep.rounds.join(" · ") || "none recorded"}
          </p>
        </div>
        <button
          type="button"
          className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          onClick={() => void onRegenerate?.()}
          disabled={regenBusy}
        >
          {regenBusy ? (
            <span className="inline-flex items-center gap-1.5"><Spinner /> Regenerating…</span>
          ) : (
            "Regenerate"
          )}
        </button>
      </div>

      <div className="mt-4 flex items-center gap-6 rounded-[20px] bg-card p-6">
        <div>
          <p className="text-sm text-muted-foreground">Overall</p>
          <div className="mt-1"><Score value={rep.overall} /></div>
        </div>
        <div className="hidden h-16 w-px bg-[#1d1d1d] sm:block" aria-hidden="true" />
        {rep.code_evidence && rep.code_evidence.tests_total > 0 && (
          <div>
            <p className="text-sm text-muted-foreground">Hidden tests passed</p>
            <p className="num mt-1 text-xl">
              {rep.code_evidence.tests_passed}
              <span className="text-sm text-[#949494]"> /{rep.code_evidence.tests_total}</span>
              <span className="ml-2 text-[13px] font-normal text-muted-foreground">deterministic</span>
            </p>
          </div>
        )}
      </div>

      {rep.competencies?.length ? (
        <Section title="Competencies">
          <CompTable comps={rep.competencies} />
        </Section>
      ) : null}

      {rep.salary && <Salary est={rep.salary} />}
    </section>
  );
}

function RoundReport({ rid, rep }: { rid: string; rep: RoundRep }) {
  return (
    <section className="mt-6 rounded-[20px] bg-card p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold">Stage report</h2>
        <Score value={rep.overall} size="md" />
      </div>
      <p className="mt-0.5 text-[13px] text-muted-foreground">
        <span className="font-mono">{rid.slice(0, 8)}</span>
      </p>
      <CompTable comps={rep.competencies} />
      <TwoCol a={rep.strengths} aTitle="Strengths" b={rep.weaknesses} bTitle="Weaknesses" />
      {rep.misconceptions?.length ? (
        <p className="mt-2 rounded-[10px] bg-warning-bg px-3 py-2 text-sm text-warning">
          Misconceptions — {rep.misconceptions.map(displayText).join(" · ")}
        </p>
      ) : null}
      <StudyList topics={rep.study_topics} />
      {rep.confidence_note && (
        <p className="mt-2 text-[13px] text-muted-foreground">{rep.confidence_note}</p>
      )}
    </section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-6">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-2">{children}</div>
    </div>
  );
}

function CompTable({ comps }: { comps?: Comp[] }) {
  if (!comps?.length) return null;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs font-normal text-muted-foreground">
          <th className="py-1.5 text-left font-normal">Competency</th>
          <th className="py-1.5 text-right font-normal">Score</th>
          <th className="py-1.5 pl-4 text-left font-normal">Confidence</th>
          <th className="hidden py-1.5 pl-4 text-left font-normal md:table-cell">Evidence</th>
        </tr>
      </thead>
      <tbody className="align-top">
        {comps.map((c) => (
          <tr key={c.name} className="border-t border-[#1d1d1d]">
            <td className="py-2.5">{c.name}</td>
            <td className="py-2.5 text-right num">
              {c.score == null ? (
                <span className="text-[#949494]">—</span>
              ) : (
                <>
                  {c.score}
                  <span className="text-xs text-[#949494]"> /10</span>
                </>
              )}
            </td>
            <td className="py-2.5 pl-4 text-muted-foreground">{c.confidence ?? "—"}</td>
            <td className="hidden max-w-[28rem] py-2.5 pl-4 text-[13px] text-muted-foreground md:table-cell">
              {displayText(c.evidence)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join(" · ");
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if ("evidence" in obj) return displayText(obj.evidence);
    return Object.values(obj).map(displayText).filter(Boolean).join(" · ");
  }
  return value == null ? "" : String(value);
}

function TwoCol({ a, aTitle, b, bTitle }: { a?: LooseText[]; aTitle: string; b?: LooseText[]; bTitle: string }) {
  const hasA = (a ?? []).length > 0;
  const hasB = (b ?? []).length > 0;
  if (!hasA && !hasB) return null;
  return (
    <div className="mt-6 grid gap-[14px] md:grid-cols-2">
      <div className="rounded-[14px] bg-[#181818] p-4">
        <p className="text-sm font-medium">{aTitle}</p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          {(a ?? []).map((x, i) => (
            <li key={i}>{displayText(x) || <span className="text-[#949494]">—</span>}</li>
          ))}
          {!hasA && <li><span className="text-[#949494]">—</span></li>}
        </ul>
      </div>
      <div className="rounded-[14px] bg-[#181818] p-4">
        <p className="text-sm font-medium">{bTitle}</p>
        <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
          {(b ?? []).map((x, i) => (
            <li key={i}>{displayText(x) || <span className="text-[#949494]">—</span>}</li>
          ))}
          {!hasB && <li><span className="text-[#949494]">—</span></li>}
        </ul>
      </div>
    </div>
  );
}

function StudyList({ topics }: { topics?: { topic: string; priority: string; exercise?: string }[] }) {
  if (!topics?.length) return null;
  const pill = (p: string) =>
    p === "high" ? "pill pill-negative" : p === "low" ? "pill pill-neutral" : "pill pill-warning";
  return (
    <div className="mt-6">
      <h3 className="text-base font-semibold">Prioritised study plan</h3>
      <ul className="mt-2 space-y-2">
        {topics.map((t, i) => (
          <li key={i} className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
            <span className={pill(t.priority)}>{t.priority}</span>
            <span className="font-medium">{t.topic}</span>
            {t.exercise && <span className="text-[13px] text-muted-foreground">— {t.exercise}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Salary({ est }: { est: FinalRep["salary"] & object }) {
  // withheld estimate (no assessed interview evidence / thin resume): no invented number
  if (est.available === false || !est.range_inr || est.point_estimate_inr == null) {
    return (
      <div className="mt-6 rounded-[20px] bg-card p-6 text-sm">
        <p className="text-base font-semibold">Salary estimate — insufficient evidence</p>
        {est.reason && (
          <p className="mt-1 text-muted-foreground">{est.reason}</p>
        )}
        <Assumptions est={est} />
      </div>
    );
  }
  return (
    <div className="mt-6 rounded-[20px] bg-card p-6 text-sm">
      <p className="text-base font-semibold">Salary estimate</p>
      <p className="num mt-1 text-[22px]">
        ₹{est.range_inr[0].toLocaleString("en-IN")}
        <span className="text-[#949494]"> – </span>
        ₹{est.range_inr[1].toLocaleString("en-IN")}
        <span className="text-sm text-muted-foreground"> /yr</span>
      </p>
      <p className="mt-1 text-[13px] text-muted-foreground">
        point ₹{est.point_estimate_inr.toLocaleString("en-IN")} · cap ₹{est.cap_inr.toLocaleString("en-IN")} · {est.confidence} confidence
      </p>
      <Assumptions est={est} />
    </div>
  );
}

function Assumptions({ est }: { est: FinalRep["salary"] & object }) {
  return (
    <details className="mt-3 text-muted-foreground">
      <summary className="cursor-pointer text-[13px] underline-offset-4">Assumptions &amp; limitations</summary>
      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px]">
        {(est.assumptions ?? []).map((a, i) => <li key={i}>{a}</li>)}
        {est.limitations && <li>{est.limitations}</li>}
      </ul>
    </details>
  );
}
