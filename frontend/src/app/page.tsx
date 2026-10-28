"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import type { SessionView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";

const ROUND_INFO: Record<string, { name: string; blurb: string; def: number }> = {
  A: { name: "Stage A · Role depth", blurb: "Experience, concepts and scenario probing in your role", def: 15 },
  B: { name: "Stage B · Problem solving", blurb: "Role-specific practical problem (coding with hidden tests for software roles)", def: 20 },
  C: { name: "Stage C · Systems & case", blurb: "Role-relevant system, workflow or product challenge", def: 15 },
};

const ROLE_OPTIONS = [
  ["auto", "Auto-detect from resume / JD"],
  ["Software Engineer", "Software Engineer / SDE"],
  ["Data Analyst", "Data Analyst"],
  ["Data Scientist", "Data Scientist"],
  ["AI/ML Engineer", "AI / ML Engineer"],
  ["Data Engineer", "Data Engineer"],
  ["DevOps / Cloud Engineer", "DevOps / Cloud Engineer"],
  ["Cybersecurity Analyst", "Cybersecurity Analyst"],
  ["QA / Test Engineer", "QA / Test Engineer"],
  ["Product Manager", "Product Manager"],
  ["Business Analyst", "Business Analyst"],
  ["UX / Product Designer", "UX / Product Designer"],
] as const;

export default function Home() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [jd, setJd] = useState("");
  const [uploading, setUploading] = useState(false);
  const [session, setSession] = useState<SessionView | null>(null);
  const [selected, setSelected] = useState<string[]>(["A", "C"]);
  const [durations, setDurations] = useState<Record<string, number>>({ A: 15, B: 20, C: 15 });
  const [level, setLevel] = useState("entry");
  const [role, setRole] = useState("auto");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dsaAvailable =
    role === "Software Engineer" ||
    (role === "auto" &&
      /software engineer|sde|developer/i.test(
        session?.resume_structured?.inferred_target_role ?? "",
      ));

  function chooseRole(value: string) {
    setRole(value);
    setSelected((current) => {
      if (value === "Software Engineer") return [...new Set([...current, "B"])];
      if (value !== "auto") return current.filter((round) => round !== "B");
      return current;
    });
  }

  async function onUpload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (jd.trim()) fd.append("jd", jd.trim());
      const res = await api.upload<{ session_id: string }>("/resume", fd);
      await api.post(`/resume/${res.session_id}/structure`);
      const nextSession = await api.get<SessionView>(`/sessions/${res.session_id}`);
      setSession(nextSession);
      setJd(nextSession.jd_text ?? "");
    } catch (e) {
      setError(String(e));
    }
    setUploading(false);
  }

  async function saveJd() {
    if (!session) return;
    const updated = await api.post<SessionView>(`/sessions/${session.session_id}/jd`, {
      text: jd,
    });
    setSession(updated);
    setJd(updated.jd_text ?? "");
  }

  function toggle(r: string, on: boolean) {
    setSelected((s) => (on ? [...new Set([...s, r])] : s.filter((x) => x !== r)));
  }

  async function start() {
    if (!session || selected.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await saveJd();
      await api.post<{ round_id: string }>(
        `/sessions/${session.session_id}/start`,
        { rounds: selected, durations, level, ...(role !== "auto" ? { role } : {}) },
      );
      router.push(`/session/${session.session_id}`);
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  if (loading) {
    return <div className="py-24 text-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (!user) return <LandingPage />;

  return (
    <div className="pt-6">
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">New interview</h1>
        <p className="text-sm text-muted-foreground">
          Built from your resume: aimed at a role, three timed stages, one report.
        </p>
      </div>
      <div className="grid items-start gap-[14px] md:grid-cols-2">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Resume &amp; target role</CardTitle>
            <CardDescription>
              Upload a text-based PDF. A job description is optional: add one to aim the interview at a role.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div
              className="cursor-pointer rounded-[14px] border border-dashed border-[#444] p-6 text-center hover:border-[#6a6a6a]"
              onClick={() => fileRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") fileRef.current?.click();
              }}
              aria-label={session ? "Replace resume" : "Upload resume"}
            >
              {!session ? (
                <>
                  <p className="font-medium">Drop or click to upload your resume (PDF)</p>
                  <p className="mt-1 text-[13px] text-muted-foreground">max 15 MB · text-based PDF</p>
                  {uploading && (
                    <p className="mt-2 flex items-center justify-center gap-2 text-sm text-data">
                      <Spinner /> Extracting…
                    </p>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  <p className="font-medium">{session.resume_original_name}</p>
                  <p className="text-[13px] text-muted-foreground">
                    {session.resume_structured?.name}
                    {" · "}
                    {session.resume_structured?.skills?.slice(0, 8).join(", ")}
                  </p>
                  <span className="pill pill-neutral">
                    {session.resume_structured?.extraction_method === "llm"
                      ? "structured"
                      : "deterministic extraction"}
                  </span>
                </div>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf"
              hidden
              onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
            />
            <div className="space-y-2">
              <Label htmlFor="target-role">Target role</Label>
              <select
                id="target-role"
                className="h-9 w-full rounded-full border border-input bg-transparent px-4 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                value={role}
                onChange={(e) => chooseRole(e.target.value)}
              >
                {ROLE_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value} className="bg-card text-foreground">{label}</option>
                ))}
              </select>
              <p className="text-[13px] text-muted-foreground">
                Choose a role, or let the resume and job description decide the interview.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="jd">Job description (optional)</Label>
              <Textarea
                id="jd"
                placeholder="e.g. Data Analyst: SQL, experimentation, dashboards, stakeholder reporting…"
                value={jd}
                onChange={(e) => setJd(e.target.value)}
                onBlur={() => {
                  saveJd().catch((e) => setError(String(e)));
                }}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-base">Stages &amp; duration</CardTitle>
            <CardDescription>
              Each duration is the spoken budget. Coding and design work may run differently within it.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <Label htmlFor={`level-${level}`}>Level</Label>
              <div
                role="radiogroup"
                aria-label="Experience level"
                className="inline-flex overflow-hidden rounded-full bg-secondary p-1"
              >
                {["entry", "mid"].map((lv) => (
                  <button
                    key={lv}
                    id={lv === level ? `level-${level}` : undefined}
                    role="radio"
                    aria-checked={level === lv}
                    type="button"
                    className={
                      "h-7 rounded-full px-4 text-sm font-medium capitalize transition-colors " +
                      (level === lv
                        ? "bg-white font-medium text-black"
                        : "text-muted-foreground hover:text-foreground")
                    }
                    onClick={() => setLevel(lv)}
                  >
                    {lv}
                  </button>
                ))}
              </div>
            </div>
            {Object.entries(ROUND_INFO)
              .filter(([k]) => k !== "B" || dsaAvailable)
              .map(([k, info]) => (
              <div key={k} className="flex items-center gap-3 rounded-[14px] bg-[#181818] p-3.5">
                <Checkbox
                  id={`r${k}`}
                  checked={selected.includes(k)}
                  onCheckedChange={(v) => toggle(k, v === true)}
                />
                <div className="grow">
                  <Label htmlFor={`r${k}`} className="font-medium">{info.name}</Label>
                  <p className="text-[13px] text-muted-foreground">{info.blurb}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    min={5}
                    max={60}
                    className="w-16 px-3 text-center num"
                    aria-label={`${info.name} duration in minutes`}
                    value={durations[k]}
                    onChange={(e) =>
                      setDurations({ ...durations, [k]: Number(e.target.value) })}
                  />
                  <span className="text-[13px] text-muted-foreground">min</span>
                </div>
              </div>
              ))}
            {error && (
              <p className="rounded-[10px] bg-negative-bg px-3 py-2 text-sm text-negative">{error}</p>
            )}
            <Button className="w-full" size="lg" disabled={!session || !selected.length || busy} onClick={start}>
              {busy && <Spinner />}
              {busy ? "Starting…" : "Start interview"}
            </Button>
            {!session && (
              <p className="text-center text-[13px] text-muted-foreground">Upload a resume to begin</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Signed-out landing (product page rules, same style)                 */
/* ------------------------------------------------------------------ */

const LANDING_ROLES = [
  "Software Engineer",
  "Data Analyst",
  "Data Scientist",
  "AI/ML Engineer",
  "Data Engineer",
  "DevOps / Cloud Engineer",
  "Cybersecurity Analyst",
  "QA / Test Engineer",
  "Product Manager",
  "Business Analyst",
  "UX / Product Designer",
];

function LandingPage() {
  return (
    <div className="pb-8">
      <section className="grid items-center gap-10 py-14 lg:grid-cols-[11fr_9fr] lg:gap-12 lg:py-20">
        <div>
          <h1 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.02em] lg:text-5xl xl:text-[60px]">
            Mock interviews that match the job.
          </h1>
          <p className="mt-6 max-w-md text-lg leading-7 text-muted-foreground">
            An adaptive mock interview built from your resume and an
            optional job description, then a round-by-round report with a
            study plan. Eleven roles, one quality bar.
          </p>
          <div className="mt-8 flex flex-wrap items-center gap-3">
            <Button size="lg" asChild>
              <Link href="/login">Create a free account</Link>
            </Button>
            <Button size="lg" variant="ghost" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
          <p className="mt-4 text-[13px] text-muted-foreground">
            Interviews you take signed out are linked to your account when you sign in.
          </p>
        </div>

        {/* The product, showing itself: a working fragment of the interview runner */}
        <div data-ui className="justify-self-center self-stretch w-full max-w-xl rounded-[20px] bg-[#111111] p-6">
          <div className="flex items-center justify-between text-[13px] text-muted-foreground">
            <span>Stage B · problem solving</span>
            <span className="rounded-full bg-[#0c1c2a] px-2.5 py-1 font-mono num text-data">
              14:20
            </span>
          </div>
          <div className="mt-6 flex flex-col gap-3">
            <div className="max-w-[85%] rounded-[14px] bg-[#1c1c1c] px-4 py-3 text-sm leading-6">
              Ops stakeholders watch a dashboard live, but writes to the
              table behind it are already heavy. What goes into your call
              between a live view and an hourly rollup for them, and what do
              you measure before deciding?
              <span className="mt-1 block text-xs text-[#949494]">data · follow-up</span>
            </div>
            <div className="ml-auto max-w-[85%] rounded-[14px] bg-[#2a2a2a] px-4 py-3 text-sm leading-6">
              I&apos;d check three things first: the freshness the decision actually
              needs, the extra load live queries add, and how often anyone repeats
              the same question…
            </div>
            <div className="flex h-12 items-center justify-center gap-2.5 rounded-full bg-[#1a1a1a] text-sm text-muted-foreground">
              <span className="inline-block size-2 rounded-full bg-data" aria-hidden="true" />
              Listening. Answer by voice or type
            </div>
          </div>
        </div>
      </section>

      <section className="grid gap-x-[14px] gap-y-6 py-8 md:grid-cols-3">
        <div>
          <p className="text-[15px] font-medium text-foreground">Role first</p>
          <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
            Every interview is built from a role profile: its stages, question
            families and practical exercise. Data, AI/ML, software, security, QA,
            product, business analysis and design each get a real interview, not
            one template for all.
          </p>
        </div>
        <div>
          <p className="text-[15px] font-medium text-foreground">Practice, not multiple choice</p>
          <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
            Answer by voice or text, with reasonable follow-ups on the way.
            Software interviews use executable coding problems with hidden tests;
            other roles get oral practical cases, never a forced system design.
          </p>
        </div>
        <div>
          <p className="text-[15px] font-medium text-foreground">Leave with evidence</p>
          <p className="mt-2 text-[15px] leading-6 text-muted-foreground">
            A consolidated report: competency scores with the quotes that earned
            them, strengths and gaps held honestly, and a prioritised study plan.
            Untested competencies are marked untested, not assumed.
          </p>
        </div>
      </section>

      <section className="py-8">
        <h2 className="text-2xl font-semibold tracking-tight">Eleven role profiles</h2>
        <p className="mt-2 max-w-xl text-[15px] text-muted-foreground">
          Choose one, or let the resume and job description decide it.
        </p>
        <ul className="mt-6 flex max-w-4xl flex-wrap gap-2">
          {LANDING_ROLES.map((role) => (
            <li
              key={role}
              className="rounded-full bg-[#181818] px-4 py-2 text-sm text-foreground"
            >
              {role}
            </li>
          ))}
        </ul>
      </section>

      <section className="py-8">
        <h2 className="text-2xl font-semibold tracking-tight">What you practice, and what you get back</h2>
        <div className="mt-6 grid gap-[14px] md:grid-cols-[1fr_1fr]">
          {/* A working fragment of the report screen */}
          <div data-ui className="rounded-[20px] bg-[#111111] p-6">
            <div className="flex items-baseline justify-between">
              <p className="text-[15px] font-semibold">Data analyst interview</p>
                <p className="text-xl num">
                7<span className="text-sm text-[#949494]">/10</span>
              </p>
            </div>
            <table className="mt-4 w-full text-sm">
              <thead>
                <tr className="text-xs font-normal text-muted-foreground">
                  <th className="py-1 text-left font-normal">Competency</th>
                  <th className="py-1 text-right font-normal">Score</th>
                  <th className="py-1 text-left font-normal pl-4">Evidence</th>
                </tr>
              </thead>
              <tbody className="align-top">
                {[
                  ["SQL correctness", "8", "explained the index and rewrote the join"],
                  ["Experiment design", "6", "partial, missed the sizing step"],
                  ["Dashboard thinking", "7", "guided the chart set and its refresh logic"],
                ].map(([name, score, note]) => (
                  <tr key={name} className="border-t border-[#1d1d1d]">
                    <td className="py-2">{name}</td>
                    <td className="py-2 text-right num">
                      {score}
                      <span className="text-xs text-[#949494]"> /10</span>
                    </td>
                    <td className="py-2 pl-4 text-[13px] text-muted-foreground">{note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-2 flex flex-wrap gap-2">
              <span className="pill pill-negative">high · window functions</span>
              <span className="pill pill-warning">medium · cohort retention</span>
              <span className="pill pill-neutral">low · chart defaults</span>
            </div>
          </div>
          <div className="flex flex-col justify-center py-4">
            <p className="text-[15px] leading-7 text-muted-foreground">
              Every stage scores competencies with evidence rather than
              impressions, so the strengths and gaps point at work you can
              actually study. Score, quotes and priorities come from one rubric
              for all roles.
            </p>
            <div className="mt-5">
              <Button asChild>
                <Link href="/login">Try an interview</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>

      <footer className="mt-8 border-t border-[#1a1a1a] py-10">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-lg font-semibold tracking-tight">Role Mock</p>
          <nav className="flex gap-6 text-sm text-muted-foreground">
            <Link href="/login" className="hover:text-foreground">Sign in</Link>
            <Link href="/login" className="hover:text-foreground">Create account</Link>
          </nav>
        </div>
        <p className="mt-4 text-[13px] text-muted-foreground">
          Role-appropriate mock interviews from your resume: timed stages, spoken
          questions, honest scoring and a study plan, all in the browser.
        </p>
      </footer>
    </div>
  );
}
