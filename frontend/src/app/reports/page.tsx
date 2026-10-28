"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

type SessionRow = {
  session_id: string;
  status: string;
  role: string | null;
  level: string;
  rounds: string[];
  resume: string | null;
};

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">My sessions</h1>
        <Button variant="outline" size="sm" onClick={() => router.push("/")}>+ New</Button>
      </div>
      {err && <p className="text-sm text-red-300">{err}</p>}
      {!loading && !user && (
        <p className="rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-400">
          Showing interviews from this browser only.{" "}
          <a href="/login" className="text-neutral-200 underline">Sign in</a>{" "}
          to keep your history on your account (this browser&apos;s sessions are claimed automatically).
        </p>
      )}
      {fetching && (
        <p className="flex items-center gap-2 text-sm text-neutral-500" role="status">
          <Spinner /> Loading sessions…
        </p>
      )}
      {!fetching && rows.length === 0 && !err && (
        <p className="text-neutral-500">No sessions yet. Start one from the home page.</p>
      )}
      <div className="grid gap-3 md:grid-cols-2">
        {rows.map((r) => (
          <Card key={r.session_id} className="hairline-panel">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">
                {r.resume ?? "session"} · {r.role ?? "unspecified role"}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center justify-between text-sm">
              <span className="text-neutral-500">
                {r.rounds.join(" · ") || "no rounds"} — {r.level}
              </span>
              <div className="flex gap-2">
                <Badge variant="secondary">{r.status}</Badge>
                <Button size="sm" variant="outline"
                  onClick={() => router.push(`/reports/${r.session_id}`)}>
                  Report
                </Button>
                <Button size="sm" variant="ghost"
                  onClick={() => router.push(`/session/${r.session_id}`)}>
                  Open
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
