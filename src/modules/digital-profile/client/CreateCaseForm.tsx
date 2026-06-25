"use client";

import { useState } from "react";
import { createCase, DigitalProfileApiError, type CaseDetail } from "./api";
import { ErrorBox } from "./components";
import { useDigitalProfileI18n } from "./i18n-provider";

const LAWFUL_BASIS = [
  "CONSENT",
  "CONTRACT",
  "LEGAL_OBLIGATION",
  "LEGITIMATE_INTEREST",
  "PUBLIC_INTEREST",
  "VITAL_INTEREST",
];
const CONSENT_STATUS = ["NOT_REQUIRED", "PENDING", "OBTAINED", "REFUSED"];

function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function CreateCaseForm({
  onCreated,
  onCancel,
}: {
  onCreated: (c: CaseDetail) => void;
  onCancel: () => void;
}) {
  const { t, tStatus, tError } = useDigitalProfileI18n();
  const [fullName, setFullName] = useState("");
  const [aliases, setAliases] = useState("");
  const [birthDate, setBirthDate] = useState("");
  const [targetRegions, setTargetRegions] = useState("");
  const [lawfulBasis, setLawfulBasis] = useState("LEGITIMATE_INTEREST");
  const [consentStatus, setConsentStatus] = useState("NOT_REQUIRED");
  const [notes, setNotes] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return; // guard against double-submit
    if (!fullName.trim()) {
      setError(t("createCase.fullNameRequired"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const created = await createCase({
        fullName: fullName.trim(),
        aliases: splitList(aliases),
        birthDate: birthDate || undefined,
        targetRegions: splitList(targetRegions),
        lawfulBasis,
        consentStatus,
        notes: notes.trim() || undefined,
      });
      onCreated(created);
    } catch (err) {
      const code = err instanceof DigitalProfileApiError ? err.code : "UNKNOWN";
      const msg = err instanceof Error ? err.message : undefined;
      setError(tError(code, msg));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2 className="dp-h2">{t("createCase.title")}</h2>
      {error ? (
        <div style={{ marginBottom: 14 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      <div className="dp-form-grid">
        <div className="dp-field dp-field-full">
          <label>
            {t("createCase.fullName")} <span className="dp-req">*</span>
          </label>
          <input
            className="dp-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder={t("createCase.fullNamePlaceholder")}
            required
          />
        </div>

        <div className="dp-field dp-field-full">
          <label>{t("createCase.aliases")}</label>
          <textarea
            className="dp-textarea"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder={t("createCase.aliasesPlaceholder")}
          />
        </div>

        <div className="dp-field">
          <label>{t("createCase.birthDate")}</label>
          <input
            className="dp-input"
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
          />
        </div>

        <div className="dp-field">
          <label>{t("createCase.targetRegions")}</label>
          <input
            className="dp-input"
            value={targetRegions}
            onChange={(e) => setTargetRegions(e.target.value)}
            placeholder={t("createCase.targetRegionsPlaceholder")}
          />
        </div>

        <div className="dp-field">
          <label>
            {t("createCase.lawfulBasis")} <span className="dp-req">*</span>
          </label>
          <select
            className="dp-select"
            value={lawfulBasis}
            onChange={(e) => setLawfulBasis(e.target.value)}
          >
            {LAWFUL_BASIS.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>

        <div className="dp-field">
          <label>
            {t("createCase.consentStatus")} <span className="dp-req">*</span>
          </label>
          <select
            className="dp-select"
            value={consentStatus}
            onChange={(e) => setConsentStatus(e.target.value)}
          >
            {CONSENT_STATUS.map((v) => (
              <option key={v} value={v}>
                {tStatus(v)}
              </option>
            ))}
          </select>
        </div>

        <div className="dp-field dp-field-full">
          <label>{t("createCase.notes")}</label>
          <textarea
            className="dp-textarea"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      <div className="dp-inline" style={{ marginTop: 16 }}>
        <button type="submit" className="dp-btn dp-btn-primary" disabled={submitting}>
          {submitting ? <span className="dp-spinner" /> : null}
          {submitting ? t("cases.creating") : t("cases.createCase")}
        </button>
        <button type="button" className="dp-btn" onClick={onCancel} disabled={submitting}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}
