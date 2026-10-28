"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import type { SessionView } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
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
  A: { name: "A · Role + Experience", blurb: "Role-specific experience, concepts, and scenario probing", def: 15 },
   B: { name: "B · DSA Problem Solving", blurb: "Conversational algorithms, intuition, and trade-offs", def: 20 },
  C: { name: "C · Systems + Case Design", blurb: "Role-relevant systems, workflows, and trade-offs", def: 15 },
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
    return <div className="mx-auto max-w-3xl py-24 text-center text-sm text-neutral-500">Loading…</div>;
  }

  if (!user) return <LandingPage />;

  return (
    <div className="grid gap-5 md:grid-cols-2">
      <Card className="hairline-panel">
        <CardHeader>
          <CardTitle>Resume & target role</CardTitle>
          <CardDescription>
            Upload a PDF resume. JD is optional — add one to aim the interview at a role.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div
            className="cursor-pointer rounded-lg border border-dashed border-neutral-700 p-6 text-center hover:border-neutral-500"
            onClick={() => fileRef.current?.click()}
          >
            {!session ? (
              <>
                <p className="font-medium">Drop or click to upload resume (PDF)</p>
                <p className="text-sm text-neutral-500">max 15 MB · text-based PDF</p>
                {uploading && (
                  <p className="mt-2 flex items-center justify-center gap-2 text-sm text-blue-400">
                    <Spinner /> Extracting…
                  </p>
                )}
              </>
            ) : (
              <div className="space-y-2">
                <p className="font-medium">{session.resume_original_name}</p>
                <p className="text-sm text-neutral-400">
                  {session.resume_structured?.name}
                  {" · "}
                  {session.resume_structured?.skills?.slice(0, 8).join(", ")}
                </p>
                <Badge variant="secondary">
                  {session.resume_structured?.extraction_method === "llm"
                    ? "structured"
                    : "deterministic extraction"}
                </Badge>
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
              className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={role}
              onChange={(e) => chooseRole(e.target.value)}
            >
              {ROLE_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <p className="text-xs text-neutral-500">
              Choose a role or let the resume and job description guide the interview.
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

      <Card className="hairline-panel">
        <CardHeader>
          <CardTitle>Interview stages & duration</CardTitle>
          <CardDescription>
            Each shown duration = spoken/oral budget. Coding and design rounds may differ.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {Object.entries(ROUND_INFO)
            .filter(([k]) => k !== "B" || dsaAvailable)
            .map(([k, info]) => (
            <div key={k} className="flex items-center gap-3 rounded-lg border border-border p-3">
              <Checkbox
                id={`r${k}`}
                checked={selected.includes(k)}
                onCheckedChange={(v) => toggle(k, v === true)}
              />
              <div className="grow">
                <Label htmlFor={`r${k}`} className="font-medium">{info.name}</Label>
                <p className="text-xs text-neutral-500">{info.blurb}</p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={5}
                  max={60}
                  className="w-16"
                  value={durations[k]}
                  onChange={(e) =>
                    setDurations({ ...durations, [k]: Number(e.target.value) })}
                />
                <span className="text-xs text-neutral-500">min</span>
              </div>
            </div>
            ))}
          <div className="flex items-center gap-3">
            <Label className="text-sm text-neutral-400">Level</Label>
            {["entry", "mid"].map((lv) => (
              <Button
                key={lv}
                variant={level === lv ? "default" : "outline"}
                size="sm"
                onClick={() => setLevel(lv)}
              >
                {lv}
              </Button>
            ))}
          </div>
          {error && <p className="rounded-md  px-3 py-2 text-sm text-red-300">{error}</p>}
          <Button className="w-full" disabled={!session || !selected.length || busy} onClick={start}>
            {busy && <Spinner />}
            {busy ? "Starting…" : "Start interview →"}
          </Button>
          {!session && (
            <p className="text-center text-xs text-neutral-600">Upload a resume to begin</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LandingPage() {
  return (
    <div className="mx-auto max-w-6xl py-8 sm:py-16">
      <section className="relative overflow-hidden rounded-3xl border border-border bg-card/80 px-6 py-12 shadow-2xl sm:px-12 sm:py-20">
        <div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-sky-500/10 blur-3xl" />
        <div className="relative max-w-3xl">
          <p className="mb-4 text-sm font-medium uppercase tracking-[0.18em] text-sky-300">
            Role·Mock
          </p>
          <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-neutral-50 sm:text-6xl">
            Practice the interview you actually want.
          </h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-neutral-400 sm:text-lg">
            A realistic, voice-first mock interview platform that adapts to your
            role, experience, resume, and job description — not a one-size-fits-all
            software interview.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row">
            <Button asChild size="lg">
              <Link href="/login">Sign in to start</Link>
            </Button>
            <Button asChild size="lg" variant="outline">
              <Link href="/login">Create a free account</Link>
            </Button>
          </div>
          <p className="mt-4 text-xs text-neutral-500">
            Your browser-based interview history is linked to your account when you sign in.
          </p>
        </div>
      </section>

      <section className="mt-6 grid gap-4 md:grid-cols-3">
        {[
          ["Built for your role", "Data, AI/ML, software, product, business, security, QA, and UX interviews with role-specific question paths."],
          ["Talk naturally", "Answer with your voice, review the captured response, and send when you are ready. Text mode is always available."],
          ["Leave with evidence", "Get round-by-round feedback, competency scores, strengths, gaps, and a focused study plan."],
        ].map(([title, description]) => (
          <Card key={title} className="hairline-panel">
            <CardHeader>
              <CardTitle className="text-base">{title}</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-6 text-neutral-400">{description}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mt-6 grid gap-4 rounded-2xl border border-border bg-neutral-900/60 p-5 sm:grid-cols-3 sm:p-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-neutral-500">01</p>
          <p className="mt-2 text-sm font-medium text-neutral-200">Upload your resume</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-neutral-500">02</p>
          <p className="mt-2 text-sm font-medium text-neutral-200">Choose your role and rounds</p>
        </div>
        <div>
          <p className="text-xs uppercase tracking-wider text-neutral-500">03</p>
          <p className="mt-2 text-sm font-medium text-neutral-200">Interview, reflect, improve</p>
        </div>
      </section>
    </div>
  );
}
