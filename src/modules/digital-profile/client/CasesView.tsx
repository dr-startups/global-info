"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DigitalProfileApiError,
  listCases,
  type CaseListItem,
} from "./api";
import {
  Card,
  EmptyState,
  ErrorBox,
  Loading,
  Notice,
} from "./components";
import { CreateCaseForm } from "./CreateCaseForm";
import { DigitalProfileCasesTable } from "./DigitalProfileCasesTable";
import { useDigitalProfileI18n } from "./i18n-provider";
import { useDpAuth } from "./auth-provider";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; cases: CaseListItem[] }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

/*
 * Уведомлений о заявках с сайта нет, поэтому новые заявки менеджер находит
 * здесь — фильтром «С сайта».
 */
type Origin = "all" | "site";

const ORIGINS: Array<{ value: Origin; label: string }> = [
  { value: "all", label: "cases.originAll" },
  { value: "site", label: "cases.originSite" },
];

export function CasesView() {
  const router = useRouter();
  const { t, tError } = useDigitalProfileI18n();
  const { can } = useDpAuth();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [creating, setCreating] = useState(false);
  const [origin, setOrigin] = useState<Origin>("all");

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await listCases({
        pageSize: 100,
        origin: origin === "site" ? "site" : undefined,
      });
      setState({ kind: "ready", cases: result.items });
    } catch (err) {
      if (err instanceof DigitalProfileApiError && err.code === "MODULE_DISABLED") {
        setState({ kind: "disabled" });
        return;
      }
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setState({ kind: "error", message: tError(code, msg) });
    }
  }, [tError, origin]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="dp-row" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="dp-h1">{t("page.title")}</h1>
          <div className="dp-muted">{t("page.subtitle")}</div>
        </div>
        {state.kind === "ready" && !creating && can("case.create") ? (
          <button className="dp-btn dp-btn-primary" onClick={() => setCreating(true)}>
            {t("cases.createCase")}
          </button>
        ) : null}
      </div>

      {creating ? (
        <Card>
          <CreateCaseForm
            onCreated={(c) => router.push(`/admin/digital-profile/${c.id}`)}
            onCancel={() => setCreating(false)}
          />
        </Card>
      ) : null}

      {!creating ? (
        <div
          role="group"
          aria-label={t("cases.origin")}
          style={{ display: "flex", gap: 8, marginBottom: 12 }}
        >
          {ORIGINS.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`dp-btn dp-btn-sm${origin === o.value ? " dp-btn-primary" : ""}`}
              aria-pressed={origin === o.value}
              onClick={() => setOrigin(o.value)}
            >
              {t(o.label)}
            </button>
          ))}
        </div>
      ) : null}

      {!creating ? (
        <Card>
          {state.kind === "loading" ? <Loading label={t("cases.loadingCases")} /> : null}

          {state.kind === "disabled" ? <Notice>{t("cases.moduleDisabled")}</Notice> : null}

          {state.kind === "error" ? (
            <div className="dp-stack">
              <ErrorBox>{state.message}</ErrorBox>
              <div>
                <button className="dp-btn" onClick={() => void load()}>
                  {t("common.retry")}
                </button>
              </div>
            </div>
          ) : null}

          {state.kind === "ready" && state.cases.length === 0 ? (
            origin === "site" ? (
              <EmptyState title={t("cases.emptySite")} />
            ) : (
              <EmptyState
                title={t("cases.emptyTitle")}
                hint={t("cases.emptyDescription")}
              />
            )
          ) : null}

          {state.kind === "ready" && state.cases.length > 0 ? (
            <DigitalProfileCasesTable cases={state.cases} />
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
