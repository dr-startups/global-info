/**
 * Offline subject identity profile editing (contextIdentifiers via UI/API).
 * NETWORK_CALLS=0 npx tsx --test scripts/smoke-subject-profile-admin.ts
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it, before } from "node:test";
import { fileURLToPath } from "node:url";
import {
  getSubjectProfileForEdit,
  loadCaseSubjectIdentityProfile,
  saveSubjectProfileEdits,
  subjectProfilePath,
} from "../src/modules/digital-profile/services/subject-profile-admin";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const SUBJECT = "Дерипаска Олег Владимирович";

function freshCase(caseId: string): void {
  const path = subjectProfilePath(caseId);
  rmSync(dirname(path), { recursive: true, force: true });
}

describe("subject profile admin (case-owned artifact)", () => {
  it("GET builds a generic default when no profile is persisted", () => {
    const caseId = "subject-profile-default";
    freshCase(caseId);
    const { profile, exists } = getSubjectProfileForEdit({ caseId, subjectName: SUBJECT });
    assert.equal(exists, false);
    assert.equal(profile.displayName, SUBJECT);
    assert.equal(profile.fullNameRu?.lastName, "Дерипаска");
    assert.ok(profile.transliterations.some((t) => /deripaska/.test(t)));
    // Default must not be persisted by a read.
    assert.equal(existsSync(subjectProfilePath(caseId)), false);
  });

  it("save persists contextIdentifiers/aliases/INN and survives reload", () => {
    const caseId = "subject-profile-save";
    freshCase(caseId);
    const { profile } = saveSubjectProfileEdits({
      caseId,
      subjectName: SUBJECT,
      edits: {
        contextIdentifiers: ["Русал", " En+ Group ", "олигарх", "санкции", "русал"],
        aliases: ["Дерипаска О. В."],
        inn: ["190200291847"],
      },
    });
    // Trimmed + case-insensitively deduped.
    assert.deepEqual(profile.contextIdentifiers, ["Русал", "En+ Group", "олигарх", "санкции"]);
    assert.deepEqual(profile.knownIdentifiers.inn, ["190200291847"]);
    assert.ok(existsSync(subjectProfilePath(caseId)));

    const reloaded = loadCaseSubjectIdentityProfile(caseId);
    assert.ok(reloaded);
    assert.deepEqual(reloaded!.contextIdentifiers, ["Русал", "En+ Group", "олигарх", "санкции"]);
    const again = getSubjectProfileForEdit({ caseId, subjectName: SUBJECT });
    assert.equal(again.exists, true);
  });

  it("self-conflicting negatives are dropped fail-closed and reported", () => {
    const caseId = "subject-profile-selfconflict";
    freshCase(caseId);
    const { profile, droppedSelfConflicting } = saveSubjectProfileEdits({
      caseId,
      subjectName: SUBJECT,
      edits: {
        unrelatedKnownPersons: ["deripaska", "олег владимирович", "Петров Игорь Саулович"],
        wrongPatronymics: ["владимирович", "игоревич"],
        namesakeProfiles: [
          { label: "Дерипаска Олег Игоревич (тёзка)", noiseTerms: ["игоревич", "дерипаска"] },
        ],
      },
    });
    assert.deepEqual(profile.negativeIdentitySignals.unrelatedKnownPersons, [
      "Петров Игорь Саулович",
    ]);
    assert.deepEqual(profile.negativeIdentitySignals.wrongNames, ["Петров Игорь Саулович"]);
    assert.deepEqual(profile.negativeIdentitySignals.wrongPatronymics, ["игоревич"]);
    assert.deepEqual(profile.namesakeProfiles, [
      { label: "Дерипаска Олег Игоревич (тёзка)", noiseTerms: ["игоревич"] },
    ]);
    assert.ok(droppedSelfConflicting.includes("deripaska"));
    assert.ok(droppedSelfConflicting.includes("владимирович"));
    assert.ok(droppedSelfConflicting.includes("дерипаска"));
  });

  it("merges edits over an existing profile without losing untouched fields", () => {
    const caseId = "subject-profile-merge";
    freshCase(caseId);
    const path = subjectProfilePath(caseId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        version: "r10-7b-subject-identity-profile-v1",
        caseId,
        displayName: SUBJECT,
        fullNameRu: { lastName: "Дерипаска", firstName: "Олег", patronymic: "Владимирович" },
        aliases: ["Дерипаска"],
        transliterations: ["deripaska oleg vladimirovich"],
        queryVariants: ["Дерипаска Олег"],
        knownIdentifiers: { inn: ["190200291847"], ogrn: ["1092356000648"], locations: ["UAE"] },
        negativeIdentitySignals: {
          wrongPatronymics: [],
          wrongNames: [],
          wrongBirthDates: ["1900-01-01"],
          unrelatedKnownPersons: [],
        },
        regionHints: ["RU", "UAE"],
        languageHints: ["ru", "en"],
      }),
      "utf8"
    );

    const { profile } = saveSubjectProfileEdits({
      caseId,
      subjectName: SUBJECT,
      edits: { contextIdentifiers: ["Русал"] },
    });
    assert.deepEqual(profile.contextIdentifiers, ["Русал"]);
    // Untouched fields preserved.
    assert.deepEqual(profile.knownIdentifiers.ogrn, ["1092356000648"]);
    assert.deepEqual(profile.knownIdentifiers.locations, ["UAE"]);
    assert.deepEqual(profile.knownIdentifiers.inn, ["190200291847"]);
    assert.deepEqual(profile.negativeIdentitySignals.wrongBirthDates, ["1900-01-01"]);
    assert.deepEqual(profile.regionHints, ["RU", "UAE"]);
    assert.deepEqual(profile.aliases, ["Дерипаска"]);
  });

  it("validation: bad INN and oversized entries are rejected", () => {
    const caseId = "subject-profile-validation";
    freshCase(caseId);
    assert.throws(
      () =>
        saveSubjectProfileEdits({
          caseId,
          subjectName: SUBJECT,
          edits: { inn: ["12345"] },
        }),
      /not a valid/
    );
    assert.throws(
      () =>
        saveSubjectProfileEdits({
          caseId,
          subjectName: SUBJECT,
          edits: { contextIdentifiers: ["x".repeat(500)] },
        }),
      /too long/
    );
  });

  it("UI + API wiring: panel, endpoint and route guards exist", () => {
    const panel = readFileSync(
      join(SRC, "modules/digital-profile/client/SubjectProfilePanel.tsx"),
      "utf8"
    );
    const view = readFileSync(join(SRC, "modules/digital-profile/client/CaseDetailView.tsx"), "utf8");
    const api = readFileSync(join(SRC, "modules/digital-profile/client/api.ts"), "utf8");
    const route = readFileSync(
      join(SRC, "app/api/digital-profile/cases/[id]/subject-profile/route.ts"),
      "utf8"
    );
    assert.match(panel, /Редактировать профиль субъекта/);
    assert.match(panel, /subject-profile-save-cta/);
    assert.match(panel, /Пересобрать отчёт/);
    assert.match(view, /SubjectProfilePanel/);
    assert.match(api, /cases\/\$\{caseId\}\/subject-profile/);
    assert.match(route, /requireRole\(user, "case\.update"\)/);
    assert.match(route, /requireCaseAccess\(user, id, "EDITOR"\)/);
  });
});
