"use client";

/**
 * Панель профиля субъекта: псевдонимы, тёзки, чужие отчества.
 *
 * Признаки субъекта (работодатель, должность, ИНН, домены) правятся не здесь, а
 * в панели персон: их вводят до первой траты, и вопрос «чем субъект отличается
 * от тёзки» должен иметь один ответ в одном месте. Прежние поля «контекст-слова»
 * и «ИНН» отсюда убраны — они отвечали на тот же вопрос вторым голосом, а ИНН в
 * профилях до шага 0054 к тому же поднимался из той самой выдачи, которую им
 * подтверждали.
 *
 * Сохранение пишет только артефакт: чтобы правка попала в готовый отчёт,
 * оператор нажимает «Пересобрать отчёт» в блоке Unified.
 */

import { useCallback, useEffect, useState } from "react";
import {
  DigitalProfileApiError,
  getSubjectIdentityProfile,
  saveSubjectIdentityProfile,
  type SubjectIdentityProfileDTO,
} from "./api";
import { ErrorBox, Notice, SuccessBox } from "./components";
import { useDpAuth } from "./auth-provider";
import { useDigitalProfileI18n } from "./i18n-provider";

function linesToList(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function listToLines(values: string[] | undefined): string {
  return (values ?? []).join("\n");
}

/** One namesake per line: "Метка | шум1, шум2". */
function linesToNamesakes(text: string): Array<{ label: string; noiseTerms: string[] }> {
  return linesToList(text)
    .map((line) => {
      const [label, terms] = line.split("|");
      return {
        label: (label ?? "").trim(),
        noiseTerms: (terms ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };
    })
    .filter((n) => n.label && n.noiseTerms.length > 0);
}

function namesakesToLines(
  values: Array<{ label: string; noiseTerms: string[] }> | undefined
): string {
  return (values ?? []).map((n) => `${n.label} | ${n.noiseTerms.join(", ")}`).join("\n");
}

export function SubjectProfilePanel({ caseId }: { caseId: string }) {
  const { can } = useDpAuth();
  const { t } = useDigitalProfileI18n();
  const canEdit = can("case.update");
  const [profile, setProfile] = useState<SubjectIdentityProfileDTO | null>(null);
  const [exists, setExists] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error" | "notice"; text: string } | null>(
    null
  );

  const [aliasesText, setAliasesText] = useState("");
  const [unrelatedText, setUnrelatedText] = useState("");
  const [wrongPatText, setWrongPatText] = useState("");
  const [namesakesText, setNamesakesText] = useState("");

  const applyProfile = useCallback((p: SubjectIdentityProfileDTO) => {
    setProfile(p);
    setAliasesText(listToLines(p.aliases));
    setUnrelatedText(listToLines(p.negativeIdentitySignals?.unrelatedKnownPersons));
    setWrongPatText(listToLines(p.negativeIdentitySignals?.wrongPatronymics));
    setNamesakesText(namesakesToLines(p.namesakeProfiles));
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSubjectIdentityProfile(caseId)
      .then(({ profile: p, exists: e }) => {
        if (cancelled) return;
        applyProfile(p);
        setExists(e);
      })
      .catch(() => {
        /* panel is optional; API errors surface on save */
      });
    return () => {
      cancelled = true;
    };
  }, [caseId, applyProfile]);

  const handleSave = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      // Признаки в теле запроса не идут вовсе: их владелец — форма панели
      // персон, и переслать сюда их прежнее значение значило бы затирать
      // чужую правку своим устаревшим снимком.
      const result = await saveSubjectIdentityProfile(caseId, {
        aliases: linesToList(aliasesText),
        unrelatedKnownPersons: linesToList(unrelatedText),
        wrongPatronymics: linesToList(wrongPatText),
        namesakeProfiles: linesToNamesakes(namesakesText),
      });
      applyProfile(result.profile);
      setExists(true);
      setMessage({
        kind: "ok",
        text:
          t("subjectProfile.saved") +
          (result.droppedSelfConflicting.length > 0
            ? ` ${t("subjectProfile.savedDropped", {
                items: result.droppedSelfConflicting.join(", "),
              })}`
            : ""),
      });
    } catch (err) {
      const text =
        err instanceof DigitalProfileApiError
          ? `${err.code}${err.message ? `: ${err.message}` : ""}`
          : err instanceof Error
            ? err.message
            : t("subjectProfile.saveFailed");
      setMessage({ kind: "error", text });
    } finally {
      setBusy(false);
    }
  }, [busy, caseId, aliasesText, unrelatedText, wrongPatText, namesakesText, applyProfile]);

  if (!profile) return null;

  const anchors = profile.anchors ?? null;
  const anchorCount =
    (anchors?.birthDate ? 1 : 0) +
    (anchors?.phrases.length ?? 0) +
    (anchors?.inn.length ?? 0) +
    (anchors?.domains.length ?? 0);

  return (
    <div data-testid="subject-profile-panel">
      <div className="dp-row" style={{ alignItems: "center" }}>
        <div>
          <h3 style={{ margin: 0 }}>{t("subjectProfile.title")}</h3>
          <div className="dp-muted" style={{ marginTop: 4, fontSize: 13 }}>
            {profile.displayName} · {t("subjectProfile.anchorsCount")}: {anchorCount}
            {exists ? "" : ` · ${t("subjectProfile.notSavedYet")}`}
            {anchorCount === 0 ? ` — ${t("subjectProfile.noAnchorsWarning")}` : ""}
          </div>
        </div>
        <button
          type="button"
          className="dp-btn"
          onClick={() => setOpen((v) => !v)}
          data-testid="subject-profile-edit-cta"
        >
          {open ? t("subjectProfile.collapse") : t("subjectProfile.edit")}
        </button>
      </div>

      {open ? (
        <div className="dp-stack" style={{ marginTop: 12, gap: 10 }}>
          <div className="dp-muted" style={{ fontSize: 12 }}>
            {t("subjectProfile.anchorsElsewhere")}
          </div>

          <label style={{ display: "block" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("subjectProfile.aliases")}</div>
            <textarea
              className="dp-input"
              style={{ width: "100%", minHeight: 60, fontFamily: "inherit" }}
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              disabled={!canEdit || busy}
            />
          </label>

          <label style={{ display: "block" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {t("subjectProfile.namesakes")}
            </div>
            <div className="dp-muted" style={{ fontSize: 12, marginBottom: 4 }}>
              {t("subjectProfile.namesakesHint")}
            </div>
            <textarea
              className="dp-input"
              style={{ width: "100%", minHeight: 60, fontFamily: "inherit" }}
              value={namesakesText}
              onChange={(e) => setNamesakesText(e.target.value)}
              disabled={!canEdit || busy}
            />
          </label>

          <label style={{ display: "block" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {t("subjectProfile.otherKnownPeople")}
            </div>
            <textarea
              className="dp-input"
              style={{ width: "100%", minHeight: 40, fontFamily: "inherit" }}
              value={unrelatedText}
              onChange={(e) => setUnrelatedText(e.target.value)}
              disabled={!canEdit || busy}
            />
          </label>

          <label style={{ display: "block" }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {t("subjectProfile.foreignPatronymics")}
            </div>
            <textarea
              className="dp-input"
              style={{ width: "100%", minHeight: 40, fontFamily: "inherit" }}
              value={wrongPatText}
              onChange={(e) => setWrongPatText(e.target.value)}
              disabled={!canEdit || busy}
            />
          </label>

          <div className="dp-inline" style={{ gap: 8 }}>
            <button
              type="button"
              className="dp-btn dp-btn-primary"
              onClick={handleSave}
              disabled={!canEdit || busy}
              data-testid="subject-profile-save-cta"
            >
              {busy ? <span className="dp-spinner" /> : null}
              {busy ? t("subjectProfile.saving") : t("subjectProfile.save")}
            </button>
            {!canEdit ? (
              <span className="dp-muted" style={{ fontSize: 12 }}>
                {t("subjectProfile.noPermission")}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}

      {message ? (
        <div style={{ marginTop: 10 }}>
          {message.kind === "ok" ? (
            <SuccessBox>{message.text}</SuccessBox>
          ) : message.kind === "error" ? (
            <ErrorBox>{message.text}</ErrorBox>
          ) : (
            <Notice>{message.text}</Notice>
          )}
        </div>
      ) : null}
    </div>
  );
}
