"use client";

import { useState } from "react";
import { createCase, DigitalProfileApiError, type CaseDetail } from "./api";
import { ErrorBox, errorMessage } from "./components";

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
      setError("Full name is required.");
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
      const code = err instanceof DigitalProfileApiError ? err.code : "INTERNAL_ERROR";
      const msg = err instanceof Error ? err.message : "Failed to create case";
      setError(errorMessage(code, msg));
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <h2 className="dp-h2">Create case</h2>
      {error ? (
        <div style={{ marginBottom: 14 }}>
          <ErrorBox>{error}</ErrorBox>
        </div>
      ) : null}
      <div className="dp-form-grid">
        <div className="dp-field dp-field-full">
          <label>
            Full name <span className="dp-req">*</span>
          </label>
          <input
            className="dp-input"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="e.g. John A. Sample"
            required
          />
        </div>

        <div className="dp-field dp-field-full">
          <label>Aliases (comma or newline separated)</label>
          <textarea
            className="dp-textarea"
            value={aliases}
            onChange={(e) => setAliases(e.target.value)}
            placeholder="J. Sample, Johnny Sample"
          />
        </div>

        <div className="dp-field">
          <label>Birth date</label>
          <input
            className="dp-input"
            type="date"
            value={birthDate}
            onChange={(e) => setBirthDate(e.target.value)}
          />
        </div>

        <div className="dp-field">
          <label>Target regions (comma separated)</label>
          <input
            className="dp-input"
            value={targetRegions}
            onChange={(e) => setTargetRegions(e.target.value)}
            placeholder="RU, UAE"
          />
        </div>

        <div className="dp-field">
          <label>
            Lawful basis <span className="dp-req">*</span>
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
            Consent status <span className="dp-req">*</span>
          </label>
          <select
            className="dp-select"
            value={consentStatus}
            onChange={(e) => setConsentStatus(e.target.value)}
          >
            {CONSENT_STATUS.map((v) => (
              <option key={v} value={v}>
                {v.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>

        <div className="dp-field dp-field-full">
          <label>Notes</label>
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
          {submitting ? "Creating…" : "Create case"}
        </button>
        <button type="button" className="dp-btn" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}
