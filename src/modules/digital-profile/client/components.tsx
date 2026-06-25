"use client";

/**
 * Small presentational primitives for the Digital Profile admin UI.
 * No external UI kit is used (the project has none); plain elements + the
 * classes defined in globals.css.
 */

import type { ReactNode } from "react";

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info";

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return <span className={`dp-badge dp-badge-${tone}`}>{children}</span>;
}

const STATUS_TONE: Record<string, BadgeTone> = {
  DRAFT: "neutral",
  COLLECTING: "info",
  REVIEW: "warn",
  REPORT_READY: "ok",
  READY: "ok",
  CLOSED: "neutral",
  ARCHIVED: "neutral",
  FINAL: "ok",
  GENERATING: "info",
  FAILED: "danger",
  // consent
  OBTAINED: "ok",
  NOT_REQUIRED: "neutral",
  PENDING: "warn",
  REFUSED: "danger",
  // review
  REVIEWED: "ok",
  DISMISSED: "neutral",
};

export function StatusBadge({ status }: { status: string | null | undefined }) {
  if (!status) return <span className="dp-muted">—</span>;
  return <Badge tone={STATUS_TONE[status] ?? "neutral"}>{status.replace(/_/g, " ")}</Badge>;
}

const RISK_TONE: Record<string, BadgeTone> = {
  INFO: "neutral",
  LOW: "info",
  MEDIUM: "warn",
  HIGH: "danger",
  CRITICAL: "danger",
};

export function RiskBadge({ severity }: { severity: string | null | undefined }) {
  if (!severity) return <span className="dp-muted">—</span>;
  return <Badge tone={RISK_TONE[severity] ?? "neutral"}>{severity}</Badge>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="dp-empty">
      <div className="dp-empty-title">{title}</div>
      {hint ? <div>{hint}</div> : null}
    </div>
  );
}

export function ErrorBox({ children }: { children: ReactNode }) {
  return <div className="dp-error">{children}</div>;
}

export function Notice({ children }: { children: ReactNode }) {
  return <div className="dp-notice">{children}</div>;
}

export function SuccessBox({ children }: { children: ReactNode }) {
  return <div className="dp-success">{children}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="dp-loading">
      <span className="dp-spinner" /> {label}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="dp-card">{children}</div>;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Human-readable message for an API error code. */
export function errorMessage(code: string, fallback: string): string {
  switch (code) {
    case "MODULE_DISABLED":
      return "The Digital Profile module is disabled. Set DIGITAL_PROFILE_ENABLED=true and restart.";
    case "RENDERER_UNAVAILABLE":
      return "Renderer is unavailable. Start the Docker renderer and try again.";
    case "NETWORK_ERROR":
      return "Could not reach the server. Check that the dev server is running.";
    default:
      return fallback;
  }
}
