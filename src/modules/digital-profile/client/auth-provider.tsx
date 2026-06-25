"use client";

/**
 * Client auth context for the Digital Profile admin UI (Stage M1).
 *
 * Fetches /auth/me once on mount and exposes the current user, role and a
 * permission helper `can(action)` (re-using the shared permission matrix). When
 * auth is disabled the server returns a synthetic SUPER_ADMIN, so the UI behaves
 * exactly as before.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { getMe, logout as apiLogout, type CurrentUser } from "./api";
import { can as canDo, type DpAction } from "../auth/roles";

interface AuthContextValue {
  loading: boolean;
  authEnabled: boolean;
  user: CurrentUser | null;
  can: (action: DpAction) => boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function DigitalProfileAuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [user, setUser] = useState<CurrentUser | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await getMe();
      setAuthEnabled(me.authEnabled);
      setUser(me.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    try {
      await apiLogout();
    } catch {
      // ignore — still drop local state / redirect below
    }
    setUser(null);
    if (typeof window !== "undefined") {
      window.location.assign("/admin/digital-profile/login");
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      loading,
      authEnabled,
      user,
      can: (action) => (user ? canDo(user.role, action) : false),
      refresh,
      signOut,
    }),
    [loading, authEnabled, user, refresh, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useDpAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useDpAuth must be used within a DigitalProfileAuthProvider");
  }
  return ctx;
}
