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
      <Button asChild variant="outline" size="sm">
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
        className="flex size-8 items-center justify-center rounded-full bg-[#1d1d1d] text-xs font-semibold text-foreground hover:bg-[#2a2a2a]"
        onClick={() => setOpen((v) => !v)}
        aria-label="Open profile menu"
        aria-expanded={open}
      >
        {initials}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-60 rounded-[14px] bg-[#161616] p-2 text-sm shadow-[0_12px_40px_rgba(0,0,0,0.5)]">
          <div className="border-b border-[#222222] px-2 pb-2">
            <p className="truncate font-medium">{displayName}</p>
            <p className="truncate pt-0.5 text-xs text-[#949494]">{user.email}</p>
          </div>
          <div className="py-1">
            <Link className="block rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-[#222222] hover:text-foreground" href="/">
              New interview
            </Link>
            <Link className="block rounded-lg px-2 py-1.5 text-muted-foreground hover:bg-[#222222] hover:text-foreground" href="/reports">
              My sessions
            </Link>
          </div>
          <button
            className="w-full rounded-lg px-2 py-1.5 text-left text-muted-foreground hover:bg-[#222222] hover:text-foreground"
            onClick={logout}
          >
            Sign out
          </button>
          <button
            className="w-full rounded-lg px-2 py-1.5 text-left text-negative hover:bg-[#222222]"
            onClick={deleteData}
          >
            Delete all my data
          </button>
        </div>
      )}
    </div>
  );
}
