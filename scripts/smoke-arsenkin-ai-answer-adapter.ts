import { buildAiAnswerObservations } from "../src/modules/digital-profile/orion-golden/classic/ai-answer-evaluation";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

const rows = [
  {
    id: "1",
    auditRunId: "run",
    providerTaskId: "t1",
    queryText: "Глинка Сергей",
    engine: "YANDEX",
    region: "RU",
    providerStatus: "OK",
    title: "ИИ-ответ",
    snippet: "Субъект фигурирует в нейтральном деловом контексте.",
    url: "https://ai.local",
    domain: "ai-serp",
    capturedAt: new Date().toISOString(),
  },
  {
    id: "2",
    auditRunId: "run",
    providerTaskId: "t1",
    queryText: "Глинка Сергей",
    engine: "YANDEX",
    region: "RU",
    providerStatus: "OK",
    title: "Forbes profile",
    snippet: null,
    url: "https://forbes.ru/x",
    domain: "forbes.ru",
    capturedAt: new Date().toISOString(),
  },
  {
    id: "3",
    auditRunId: "run",
    providerTaskId: "t2",
    queryText: "Sergey Glinka",
    engine: "GOOGLE",
    region: "UAE",
    providerStatus: "NO_RESULTS",
    title: null,
    snippet: null,
    url: "https://ai.local/uae",
    domain: "ai-serp",
    capturedAt: new Date().toISOString(),
  },
];

const out = buildAiAnswerObservations(rows);
check("adapter builds two grouped observations", out.length === 2, `n=${out.length}`);
check("measured answer has status MEASURED", out.some((x) => x.region === "RU" && x.status === "MEASURED"));
check("empty answer maps to NO_RESULTS", out.some((x) => x.region === "UAE" && x.status === "NO_RESULTS"));
check("citations extracted", (out.find((x) => x.region === "RU")?.citations.length ?? 0) >= 1);

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
