"use client";

// Single source of truth for who is signed in.
//
// Why a context: UserMenu lives in the root layout, which never remounts during
// client-side navigation, and router.refresh() does not re-run client-component
// effects. Pages that fetched /auth/me themselves therefore saw stale auth state
// after login/logout until a full reload. Every auth-aware component now reads
// this context and calls refresh() at the moments auth actually changes.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/api";

export type AuthUser = { id: string; email: string; name: string | null };

type AuthContextValue = {
  user: AuthUser | null;
  /** true until the first /auth/me round-trip resolves */
  loading: boolean;
  /** re-read /auth/me (after login, register, logout, data deletion…) */
  refresh: () => Promise<AuthUser | null>;
  /** clears the session cookie and updates the shared state */
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const r = await api.get<{ user: AuthUser | null }>("/auth/me");
      setUser(r.user);
      return r.user;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* cookie already gone / network hiccup — clear state regardless */
    }
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
