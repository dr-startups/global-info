"use client";

import { useState, type FormEvent } from "react";
import {
  DigitalProfileApiError,
  login as apiLogin,
} from "@/modules/digital-profile/client/api";
import { Card, ErrorBox } from "@/modules/digital-profile/client/components";
import { useDigitalProfileI18n } from "@/modules/digital-profile/client/i18n-provider";
import { authLabels } from "@/modules/digital-profile/client/auth-labels";

export const dynamic = "force-dynamic";

export default function DigitalProfileLoginPage() {
  const { locale } = useDigitalProfileI18n();
  const L = authLabels(locale);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await apiLogin(email.trim(), password);
      const params = new URLSearchParams(window.location.search);
      const next = params.get("next") || "/admin/digital-profile";
      window.location.assign(next.startsWith("/admin/digital-profile") ? next : "/admin/digital-profile");
    } catch (err) {
      if (err instanceof DigitalProfileApiError && err.code === "UNAUTHORIZED") {
        setError(L.invalidCredentials);
      } else {
        setError(err instanceof Error ? err.message : L.invalidCredentials);
      }
      setBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "48px auto" }}>
      <Card>
        <h1 className="dp-h1" style={{ marginTop: 0 }}>
          {L.signInTitle}
        </h1>
        <div className="dp-muted" style={{ marginBottom: 16 }}>
          {L.signInSubtitle}
        </div>
        <form onSubmit={onSubmit} className="dp-stack">
          <div className="dp-field">
            <label>{L.email}</label>
            <input
              className="dp-input"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <div className="dp-field">
            <label>{L.password}</label>
            <input
              className="dp-input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          {error ? <ErrorBox>{error}</ErrorBox> : null}
          <button
            className="dp-btn dp-btn-primary"
            disabled={busy || !email || !password}
          >
            {busy ? L.signingIn : L.signIn}
          </button>
        </form>
      </Card>
    </div>
  );
}
