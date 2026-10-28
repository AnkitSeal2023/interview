"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { Spinner } from "@/components/ui/spinner";

type SessionRow = {
  session_id: string;
  status: string;
  role: string | null;
  level: string;
  rounds: string[];
  resume: string | null;
};

// status word → one pale pill of the same hue; unknown states stay neutral
function StatusPill({ status }: { status: string }) {
  const s = status.toLowerCase();
  if (s === "completed")
    return <span className="pill pill-neutral">completed</span>;
  if (s === "in_progress")
    return <span className="pill pill-warning">in progress</span>;
  if (s === "aborted")
    return <span className="pill pill-neutral">exited</span>;
  if (s === "paused")
    return <span className="pill pill-warning">paused</span>;
  return <span className="pill pill-neutral">{s.replace("_", " ")}</span>;
}

function ShortId({ id }: { id: string }) {
  return (
    <span className="font-mono text-[12px] text-[#949494]" title={id}>
      {id.slice(0, 8)}
    </span>
  );
}

export default function Reports() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);

  // The history scope ("signed-in account" vs "this browser") is decided
  // server-side, so refetch whenever the auth identity resolves or changes.
  useEffect(() => {
    if (loading) return;
    api.get<SessionRow[]>("/sessions")
      .then(setRows)
      .catch((e) => setErr(String(e)))
      .finally(() => setFetching(false));
  }, [loading, user?.id]);

  const plural = rows.length === 1 ? "interview" : "interviews";

  return (
    <div className="pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">My sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {rows.length === 0
              ? "Every interview you run lands here with its report."
              : `${rows.length} ${plural} on record.`}
          </p>
        </div>
        <button
          onClick={() => router.push("/")}
          className="inline-flex h-9 items-center rounded-full bg-white px-4 text-sm font-medium text-black hover:bg-white/85"
        >
          New interview
        </button>
      </div>

      {err && (
        <p className="mt-4 rounded-[10px] bg-negative-bg px-3 py-2 text-sm text-negative">{err}</p>
      )}
      {!loading && !user && !fetching && (
        <p className="mt-5 rounded-[14px] bg-[#181818] px-4 py-3 text-sm text-muted-foreground">
          Showing interviews from this browser only.{" "}
          <a href="/login" className="text-foreground underline underline-offset-4">
            Sign in
          </a>{" "}
          to keep your history on your account (this browser&apos;s sessions are claimed automatically).
        </p>
      )}

      {fetching && (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Spinner /> Loading sessions…
        </p>
      )}

      {!fetching && rows.length === 0 && !err && (
        <p className="mt-6 rounded-[14px] border border-dashed border-[#2a2a2a] px-4 py-8 text-center text-sm text-muted-foreground">
          No sessions yet — start one from New interview.
        </p>
      )}

      {!fetching && rows.length > 0 && (
        <div className="mt-6">
          {rows.map((r) => (
            <div
              key={r.session_id}
              className="flex items-center gap-4 border-b border-[#1b1b1b] py-4 last:border-b-0"
            >
              <div className="min-w-0 grow">
                <p className="truncate text-sm font-medium">
                  {r.resume ?? "Untitled resume"}
                  <span className="text-muted-foreground"> · {r.role ?? "role auto-detected"}</span>
                </p>
                <p className="mt-0.5 flex items-center gap-2 text-[13px] text-muted-foreground">
                  <ShortId id={r.session_id} />
                  <span>{r.rounds.join(" · ") || "no stages"}</span>
                  <span className="capitalize">{r.level}</span>
                </p>
              </div>
              <StatusPill status={r.status} />
              <button
                className="h-8 flex-none rounded-full px-3 text-sm text-muted-foreground hover:bg-[#222222] hover:text-foreground"
                onClick={() => router.push(`/reports/${r.session_id}`)}
              >
                Report
              </button>
              <button
                className="h-8 flex-none rounded-full px-3 text-sm text-muted-foreground hover:bg-[#222222] hover:text-foreground"
                onClick={() => router.push(`/session/${r.session_id}`)}
              >
                Open
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
