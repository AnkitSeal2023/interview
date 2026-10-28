"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

type Mode = "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const { refresh } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      // after sign-in, any anonymous sessions from this browser are claimed automatically
      await api.post<{ claimed_sessions: number }>(
        mode === "login" ? "/auth/login" : "/auth/register",
        mode === "register" ? { email, password, name: name || undefined } : { email, password },
      );
      // push the new identity into the shared auth state BEFORE navigating —
      // the layout never remounts on client navigation, so the header (and any
      // already-mounted screen) would otherwise keep the previous account
      await refresh();
      router.push("/");
    } catch (e2) {
      setErr(String(e2));
    }
    setBusy(false);
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-sm flex-col justify-center py-10">
      <div className="rounded-[20px] bg-card p-6">
        <h1 className="text-2xl font-semibold tracking-tight">
          {mode === "login" ? "Sign in" : "Create an account"}
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {mode === "register"
            ? "Your interview history from this browser will be linked to the new account."
            : "Interviews made on this browser while signed out are linked to your account."}
        </p>

        <form className="mt-6 space-y-4" onSubmit={submit}>
          <div
            role="radiogroup"
            aria-label="Account mode"
            className="flex rounded-full bg-secondary p-1"
          >
            {(["login", "register"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={
                  "h-8 grow rounded-full px-3 text-sm transition-colors " +
                  (mode === m
                    ? "bg-white font-medium text-black"
                    : "text-muted-foreground hover:text-foreground")
                }
                onClick={() => { setMode(m); setErr(null); }}
              >
                {m === "login" ? "Sign in" : "Register"}
              </button>
            ))}
          </div>

          {mode === "register" && (
            <div className="space-y-1.5">
              <Label htmlFor="name">Name (optional)</Label>
              <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ankit" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)} placeholder="you@work.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input id="password" type={showPw ? "text" : "password"} required minLength={8}
                className="pr-10" value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === "register" ? "at least 8 characters" : "password"} />
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPw((v) => !v)}
                title={showPw ? "Hide password" : "Show password"}
                aria-label={showPw ? "Hide password" : "Show password"}
              >
                {showPw ? <Eye size={16} /> : <EyeOff size={16} />}
              </button>
            </div>
          </div>

          {err && (
            <p className="rounded-[10px] bg-negative-bg px-3 py-2 text-sm text-negative">{err}</p>
          )}
          <Button type="submit" className="w-full" size="lg" disabled={busy || !email || password.length < 8}>
            {busy && <Spinner />}
            {busy ? "Signing in…" : mode === "login" ? "Sign in" : "Create account & sign in"}
          </Button>
        </form>
      </div>
    </div>
  );
}
