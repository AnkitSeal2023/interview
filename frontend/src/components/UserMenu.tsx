"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { useAuth } from "@/components/AuthProvider";
import { Button } from "@/components/ui/button";

export default function UserMenu() {
  const router = useRouter();
  const { user, loading, refresh, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  async function logout() {
    await signOut(); // clears the cookie AND the shared auth state for every screen
    setOpen(false);
    router.push("/");
  }

  async function deleteData() {
    if (!confirm("Delete ALL your stored interviews, reports and resume data? This cannot be undone.")) return;
    await api.del("/me/data");
    await api.post("/auth/logout").catch(() => undefined);
    await refresh();
    setOpen(false);
    router.push("/");
  }

  if (loading) {
    return <span className="inline-block size-9" aria-hidden="true" />;
  }

  if (!user) {
    return (
      <Button asChild variant="outline" size="sm" className="border-neutral-600">
        <a href="/login">Sign in</a>
      </Button>
    );
  }

  const displayName = user.name || user.email.split("@")[0];
  const initials = displayName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        className="flex size-9 items-center justify-center rounded-full border border-neutral-600 bg-neutral-800 text-xs font-semibold text-neutral-100 hover:border-neutral-300"
        onClick={() => setOpen((v) => !v)}
        aria-label="Open profile menu"
        aria-expanded={open}
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-60 rounded-md border border-border bg-popover p-2 text-sm shadow-xl">
          <div className="border-b border-border/70 px-2 pb-2">
            <p className="truncate font-medium text-neutral-100">{displayName}</p>
            <p className="truncate pt-0.5 text-xs text-neutral-500">{user.email}</p>
          </div>
          <div className="py-1">
            <Link className="block rounded px-2 py-1.5 hover:bg-neutral-800" href="/">
              New interview
            </Link>
            <Link className="block rounded px-2 py-1.5 hover:bg-neutral-800" href="/reports">
              My sessions
            </Link>
          </div>
          <button
            className="w-full rounded px-2 py-1.5 text-left hover:bg-neutral-800"
            onClick={logout}
          >
            Sign out
          </button>
          <button
            className="w-full rounded px-2 py-1.5 text-left text-red-300 hover:bg-red-950/40"
            onClick={deleteData}
          >
            Delete all my data
          </button>
        </div>
      )}
    </div>
  );
}
