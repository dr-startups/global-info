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
  errorMessage,
} from "./components";
import { CreateCaseForm } from "./CreateCaseForm";
import { DigitalProfileCasesTable } from "./DigitalProfileCasesTable";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; cases: CaseListItem[] }
  | { kind: "disabled" }
  | { kind: "error"; message: string };

export function CasesView() {
  const router = useRouter();
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const result = await listCases({ pageSize: 100 });
      setState({ kind: "ready", cases: result.items });
    } catch (err) {
      if (err instanceof DigitalProfileApiError && err.code === "MODULE_DISABLED") {
        setState({ kind: "disabled" });
        return;
      }
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to load cases";
      setState({ kind: "error", message: errorMessage(code, msg) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <div className="dp-row" style={{ marginBottom: 20 }}>
        <div>
          <h1 className="dp-h1">Digital Profile Audit</h1>
          <div className="dp-muted">Evidence-based case management & report generation</div>
        </div>
        {state.kind === "ready" && !creating ? (
          <button className="dp-btn dp-btn-primary" onClick={() => setCreating(true)}>
            Create case
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
        <Card>
          {state.kind === "loading" ? <Loading label="Loading cases…" /> : null}

          {state.kind === "disabled" ? (
            <Notice>
              The Digital Profile module is disabled. Set{" "}
              <code className="dp-mono">DIGITAL_PROFILE_ENABLED=true</code> in your environment and
              restart the server.
            </Notice>
          ) : null}

          {state.kind === "error" ? (
            <div className="dp-stack">
              <ErrorBox>{state.message}</ErrorBox>
              <div>
                <button className="dp-btn" onClick={() => void load()}>
                  Retry
                </button>
              </div>
            </div>
          ) : null}

          {state.kind === "ready" && state.cases.length === 0 ? (
            <EmptyState
              title="No cases yet"
              hint="Create your first Digital Profile Audit case to get started."
            />
          ) : null}

          {state.kind === "ready" && state.cases.length > 0 ? (
            <DigitalProfileCasesTable cases={state.cases} />
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}
