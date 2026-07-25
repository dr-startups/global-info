"use client";

/**
 * Small presentational primitives for the Digital Profile admin UI.
 * No external UI kit is used (the project has none); plain elements + the
 * classes defined in globals.css.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { useDigitalProfileI18n } from "./i18n-provider";

type BadgeTone = "neutral" | "ok" | "warn" | "danger" | "info";

export function Badge({
  tone = "neutral",
  children,
  title,
}: {
  tone?: BadgeTone;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className={`dp-badge dp-badge-${tone}`} title={title}>
      {children}
    </span>
  );
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
  FAILED_RETRYABLE: "warn",
  FAILED_TERMINAL: "danger",
  COMPLETED_PARTIAL: "warn",
  WAITING: "info",
  BASE_COLLECTION: "info",
  ARSENKIN_ENRICHMENT: "info",
  COMPOSITE_MERGE: "info",
  ORION_PREPARE: "info",
  CLIENT_CONTENT: "info",
  // agent runs
  RUNNING: "info",
  SUCCEEDED: "ok",
  SUCCESS: "ok",
  PARTIAL_SUCCESS: "warn",
  CANCELLED: "neutral",
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
  const { tStatus } = useDigitalProfileI18n();
  if (!status) return <span className="dp-muted">—</span>;
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"} title={status}>
      {tStatus(status)}
    </Badge>
  );
}

const RISK_TONE: Record<string, BadgeTone> = {
  INFO: "neutral",
  LOW: "info",
  MEDIUM: "warn",
  HIGH: "danger",
  CRITICAL: "danger",
};

export function RiskBadge({ severity }: { severity: string | null | undefined }) {
  const { tRisk } = useDigitalProfileI18n();
  if (!severity) return <span className="dp-muted">—</span>;
  return (
    <Badge tone={RISK_TONE[severity] ?? "neutral"} title={severity}>
      {tRisk(severity)}
    </Badge>
  );
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

export function WarningBox({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        background: "#fffbeb",
        border: "1px solid #fcd34d",
        color: "#92400e",
        borderRadius: 6,
        padding: "10px 12px",
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

export function Loading({ label }: { label?: string }) {
  const { dictionary } = useDigitalProfileI18n();
  return (
    <div className="dp-loading">
      <span className="dp-spinner" /> {label ?? dictionary.common.loading}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="dp-card">{children}</div>;
}

/**
 * Класс-компонент не может пользоваться хуком локали, поэтому запасное
 * сообщение выносится в обычную функцию (шаг 11.4).
 */
function RenderBoundaryNotice() {
  const { t } = useDigitalProfileI18n();
  return <Notice>{t("common.renderBoundary")}</Notice>;
}

/**
 * Isolates a child-tree crash so one panel cannot blank the whole case page.
 */
export class SoftRenderBoundary extends Component<
  { children: ReactNode; fallback?: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("SoftRenderBoundary caught", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return (
        this.props.fallback ?? <RenderBoundaryNotice />
      );
    }
    return this.props.children;
  }
}

// Date formatting and API-error messages are now locale-aware via the i18n
// provider (see i18n-provider.tsx: fmtDate / tError). Legacy helpers removed.
