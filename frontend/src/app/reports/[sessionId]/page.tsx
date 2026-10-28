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
    <div className="space-y-5">
      {err && <p className="text-sm text-red-300">{err}</p>}
      {loading && (
        <p className="flex items-center gap-2 text-sm text-neutral-500" role="status">
          <Spinner /> Loading report…
        </p>
      )}
      {final && (
        <FinalView rep={final} onRegenerate={regenerateFinal} regenBusy={regenBusy} />
      )}
      {Object.entries(roundReps).map(([rid, rep]) => (
        <div key={rid} className="hairline-panel rounded-lg border border-border bg-card p-4">
          <h2 className="font-semibold">Round report</h2>
          <p className="score font-mono">{rep.overall ?? "–"}/10</p>
          <CompTable comps={rep.competencies} />
          <TwoCol a={rep.strengths} aTitle="Strengths" b={rep.weaknesses} bTitle="Weaknesses" />
          {rep.misconceptions?.length ? (
            <p className="text-sm text-amber-300">Misconceptions: {rep.misconceptions.map(displayText).join(" · ")}</p>
          ) : null}
          <StudyList topics={rep.study_topics} />
          {rep.confidence_note && <p className="text-xs text-neutral-500">{rep.confidence_note}</p>}
        </div>
      ))}
    </div>
  );
}

function FinalView({ rep, onRegenerate, regenBusy }: { rep: FinalRep; onRegenerate?: () => void | Promise<void>; regenBusy?: boolean }) {
  return (
    <div className="hairline-panel rounded-lg border border-border bg-card p-5">
      <div className="flex items-baseline justify-between">
        <h1 className="text-lg font-semibold">Final report</h1>
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-xs text-neutral-400 underline underline-offset-4 hover:text-neutral-100"
            onClick={() => void onRegenerate?.()}
            disabled={regenBusy}
          >
            {regenBusy ? <span className="inline-flex items-center gap-1"><Spinner /> Regenerating…</span> : "Regenerate"}
          </button>
          <span className={"score font-mono " + ((rep.overall ?? 0) >= 6 ? "text-emerald-400" : (rep.overall ?? 0) >= 4 ? "text-amber-300" : "text-red-400")}>
            {rep.overall ?? "–"}/10
          </span>
        </div>
      </div>
      <p className="text-xs text-neutral-500">rounds: {rep.rounds.join(" · ") || "none"}</p>
      <CompTable comps={rep.competencies} />
      {rep.code_evidence && rep.code_evidence.tests_total > 0 && (
        <p className="text-sm text-neutral-300">
          Coding: {rep.code_evidence.tests_passed}/{rep.code_evidence.tests_total} hidden tests passed (deterministic)
        </p>
      )}
      {rep.salary && <Salary est={rep.salary} />}
    </div>
  );
}

function CompTable({ comps }: { comps?: Comp[] }) {
  if (!comps?.length) return null;
  return (
    <table className="my-3 w-full text-sm">
      <thead>
        <tr className="text-left text-neutral-500">
          <th className="py-1">Competency</th><th>Score</th><th>Confidence</th><th>Evidence</th>
        </tr>
      </thead>
      <tbody>
        {comps.map((c) => (
          <tr key={c.name} className="border-t border-neutral-800">
            <td className="py-1.5">{c.name}</td>
            <td className="font-mono">{c.score ?? "n/t"}</td>
            <td className="text-neutral-400">{c.confidence ?? ""}</td>
            <td className="text-neutral-500">{displayText(c.evidence).slice(0, 90)}</td>
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
  return (
    <div className="my-2 grid gap-4 text-sm md:grid-cols-2">
      <div>
        <p className="font-medium text-emerald-300">{aTitle}</p>
        <ul className="list-disc pl-5 text-neutral-300">
          {(a ?? []).map((x, i) => <li key={i}>{displayText(x)}</li>)}
        </ul>
      </div>
      <div>
        <p className="font-medium text-red-300">{bTitle}</p>
        <ul className="list-disc pl-5 text-neutral-300">
          {(b ?? []).map((x, i) => <li key={i}>{displayText(x)}</li>)}
        </ul>
      </div>
    </div>
  );
}

function StudyList({ topics }: { topics?: { topic: string; priority: string; exercise?: string }[] }) {
  if (!topics?.length) return null;
  const color = (p: string) => p === "high" ? "text-red-300" : p === "low" ? "text-neutral-500" : "text-amber-300";
  return (
    <div className="my-2 text-sm">
      <p className="font-medium">Prioritized study plan</p>
      <ol className="list-decimal pl-5 text-neutral-300">
        {topics.map((t, i) => (
          <li key={i}>
            <span className={color(t.priority)}>{t.topic}</span>
            {t.exercise ? <span className="text-neutral-500"> — {t.exercise}</span> : null}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Salary({ est }: { est: FinalRep["salary"] & object }) {
  // withheld estimate (no assessed interview evidence / thin resume): no invented number
  if (est.available === false || !est.range_inr || est.point_estimate_inr == null) {
    return (
      <div className="mt-4 rounded-lg border border-amber-900/60 bg-amber-950/20 p-4 text-sm">
        <p className="font-medium text-amber-200">
          Salary estimate: insufficient evidence
        </p>
        {est.reason && (
          <p className="mt-1 text-xs text-neutral-400">{est.reason}</p>
        )}
        <details className="mt-2 text-neutral-400">
          <summary className="cursor-pointer text-xs">Assumptions &amp; limitations</summary>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {(est.assumptions ?? []).map((a, i) => <li key={i}>{a}</li>)}
            {est.limitations && <li>{est.limitations}</li>}
          </ul>
        </details>
      </div>
    );
  }
  return (
    <div className="mt-4 rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-sm">
      <p className="font-medium">
        Salary estimate: ₹{est.range_inr[0].toLocaleString("en-IN")} – ₹{est.range_inr[1].toLocaleString("en-IN")}
        <span className="text-neutral-500"> /yr (point ₹{est.point_estimate_inr.toLocaleString("en-IN")}, cap ₹{est.cap_inr.toLocaleString("en-IN")}, {est.confidence} confidence)</span>
      </p>
      <details className="mt-2 text-neutral-400">
        <summary className="cursor-pointer text-xs">Assumptions & limitations</summary>
        <ul className="mt-1 list-disc pl-5 text-xs">
          {est.assumptions.map((a, i) => <li key={i}>{a}</li>)}
          <li>{est.limitations}</li>
        </ul>
      </details>
    </div>
  );
}
