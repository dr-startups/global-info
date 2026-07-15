import { evaluateAiAnswerObservation } from "../src/modules/digital-profile/orion-golden/classic/ai-answer-evaluation";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

const measured = evaluateAiAnswerObservation({
  subjectFullName: "Глинка Сергей Михайлович",
  aliases: ["Sergey Glinka"],
  observation: {
    id: "obs-1",
    auditRunId: "run",
    providerTaskId: "task",
    provider: "arsenkin",
    surface: "ai_answer",
    engine: "google_ai_overview",
    region: "RU",
    query: "Sergey Glinka",
    status: "MEASURED",
    answerText:
      "Sergey Glinka appears in business profiles. There are fraud allegations that require verification.",
    answerBlocks: [],
    citations: [{ url: "https://example.org/a", domain: "example.org" }],
    capturedAt: new Date().toISOString(),
    rawArtifactRef: "serp_observation:1",
    evidenceRefs: ["serp_observation:1"],
  },
});
check("evaluation created for measured answer", Boolean(measured));
check("adverse claims extracted", (measured?.adverseClaims.length ?? 0) >= 1);

const wrongSubject = evaluateAiAnswerObservation({
  subjectFullName: "Иван Иванов",
  aliases: [],
  observation: {
    id: "obs-2",
    auditRunId: "run",
    providerTaskId: "task",
    provider: "arsenkin",
    surface: "ai_answer",
    engine: "google_ai_overview",
    region: "RU",
    query: "Sergey Glinka",
    status: "MEASURED",
    answerText: "Criminal allegations around Sergey Glinka are discussed in media.",
    answerBlocks: [],
    citations: [],
    capturedAt: new Date().toISOString(),
    rawArtifactRef: "serp_observation:2",
    evidenceRefs: ["serp_observation:2"],
  },
});
check("wrong subject detected", wrongSubject?.subjectMatch === "WRONG_SUBJECT", String(wrongSubject?.subjectMatch));
check(
  "wrong subject is not red adverse verdict",
  wrongSubject?.tone === "NOT_ASSESSABLE",
  String(wrongSubject?.tone)
);

const absent = evaluateAiAnswerObservation({
  subjectFullName: "Глинка Сергей Михайлович",
  aliases: [],
  observation: {
    id: "obs-3",
    auditRunId: "run",
    providerTaskId: "task",
    provider: "arsenkin",
    surface: "ai_answer",
    engine: "google_ai_overview",
    region: "UAE",
    query: "Sergey Glinka",
    status: "NO_RESULTS",
    answerText: null,
    answerBlocks: [],
    citations: [],
    capturedAt: new Date().toISOString(),
    rawArtifactRef: "serp_observation:3",
    evidenceRefs: [],
  },
});
check("no evaluation for NO_RESULTS", absent === null);

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
