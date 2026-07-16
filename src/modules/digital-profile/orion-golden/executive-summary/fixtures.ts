/**
 * EXECUTIVE_SUMMARY stage — offline fixtures (Глинка case), NETWORK_CALLS=0.
 */

import type { Finding } from "../contracts/finding";
import {
  EXECUTIVE_SUMMARY_STAGE_INPUT_SCHEMA_VERSION,
  type ExecutiveSummaryStageInput,
} from "./stage-contracts";

const CASE_ID = "case-glinka-72";
const DATASET_ID = "composite-glinka-72";

function baseEnvelope() {
  return {
    caseId: CASE_ID,
    datasetId: DATASET_ID,
    sourceHashes: ["sha256:78adc2e3708feb551521b2ac6b75958947d46e241f6f5162a7e6c65e343d7091"],
    evidenceRefs: [] as string[],
  };
}

function finding(partial: Partial<Finding> & Pick<Finding, "findingId" | "theme" | "claim">): Finding {
  return {
    ...baseEnvelope(),
    schemaVersion: "finding-v1",
    subjectMatch: "SUBJECT_MATCH",
    riskLevel: "medium",
    confidence: 0.8,
    regions: ["RU"],
    sourceDomains: ["example.com"],
    providers: ["yandex"],
    recommendedAction: "Мониторить развитие темы в выдаче.",
    contradictions: [],
    limitations: [],
    promotionPriority: "P2",
    evidenceRefs: [`evidence:${partial.findingId}`],
    surfaceKinds: ["organic"],
    ...partial,
  };
}

export const GLINKA_SUBJECT = {
  displayName: "Сергей Глинка",
  aliases: ["Sergey Glinka"],
  identifiers: ["бизнесмен", "Молдова", "девелопмент"],
};

/** SUBJECT_MATCH findings shared by rich/conflicting fixtures. */
export function glinkaVerifiedFindings(): Finding[] {
  return [
    finding({
      findingId: "f-politics-md",
      theme: "Политические связи в Молдове",
      claim:
        "Публикации связывают субъекта с финансированием политических инициатив в Молдове; тема устойчиво присутствует в региональной выдаче.",
      riskLevel: "high",
      confidence: 0.85,
      regions: ["MD"],
      sourceDomains: ["newsmaker.md", "zdg.md"],
      providers: ["yandex", "serper"],
      recommendedAction: "Подготовить позицию по политическим публикациям Молдовы.",
      surfaceKinds: ["organic", "ai_answers"],
    }),
    finding({
      findingId: "f-offshore",
      theme: "Офшорные структуры",
      claim:
        "В открытых реестрах и журналистских материалах упоминаются офшорные компании, связываемые с субъектом; состав владения полностью не раскрыт.",
      riskLevel: "high",
      confidence: 0.65,
      regions: ["RU", "MD"],
      sourceDomains: ["opencorporates.com", "occrp.org"],
      providers: ["serper"],
      recommendedAction: "Заказать корпоративную проверку офшорных структур.",
    }),
    finding({
      findingId: "f-ai-security",
      theme: "Внимание органов безопасности в AI-ответах (security scrutiny)",
      claim:
        "AI-ответы поисковых систем воспроизводят тезис о внимании органов национальной безопасности к деятельности субъекта; формулировка попадает в первый экран выдачи.",
      riskLevel: "critical",
      confidence: 0.8,
      regions: ["RU"],
      sourceDomains: ["ya.ru"],
      providers: ["yandex"],
      recommendedAction: "Срочно проработать опровержение и работу с AI-выдачей.",
      surfaceKinds: ["ai_answers"],
    }),
    finding({
      findingId: "f-spouse",
      theme: "Активы супруги",
      claim:
        "Материалы о недвижимости, оформленной на супругу, обсуждаются в региональных СМИ; прямых нарушений не зафиксировано.",
      riskLevel: "medium",
      confidence: 0.7,
      regions: ["MD"],
      sourceDomains: ["zdg.md"],
      providers: ["yandex"],
      recommendedAction: "Собрать документальные подтверждения происхождения активов.",
    }),
    finding({
      findingId: "f-business-neutral",
      theme: "Деловой профиль",
      claim:
        "Основной объём выдачи составляют нейтральные деловые материалы: интервью, отраслевые обзоры и упоминания девелоперских проектов субъекта.",
      riskLevel: "none",
      confidence: 0.9,
      regions: ["RU"],
      sourceDomains: ["rbc.ru", "vedomosti.ru"],
      providers: ["yandex", "serper"],
      recommendedAction: "Поддерживать позитивный деловой контент в выдаче.",
    }),
    finding({
      findingId: "f-judicial",
      theme: "Судебные упоминания",
      claim:
        "Найдены упоминания арбитражных споров с участием компаний субъекта; исходы дел в открытых материалах не описаны.",
      riskLevel: "medium",
      confidence: 0.55,
      regions: ["RU"],
      sourceDomains: ["kad.arbitr.ru"],
      providers: ["serper"],
      recommendedAction: "Проверить статусы арбитражных дел по картотеке.",
    }),
  ];
}

/** OTHER_SUBJECT noise: композитор Михаил Глинка. */
export function composerNoiseFindings(): Finding[] {
  return [
    finding({
      findingId: "f-composer-opera",
      theme: "Оперное наследие",
      claim: "Опера «Жизнь за царя» Михаила Глинки включена в репертуар Большого театра.",
      subjectMatch: "OTHER_SUBJECT",
      riskLevel: "none",
      confidence: 0.95,
      sourceDomains: ["bolshoi.ru"],
      recommendedAction: "Исключить из KPI субъекта.",
    }),
    finding({
      findingId: "f-composer-museum",
      theme: "Музей-усадьба композитора",
      claim: "Музей Михаила Глинки в Новоспасском проводит юбилейные концерты.",
      subjectMatch: "OTHER_SUBJECT",
      riskLevel: "none",
      confidence: 0.95,
      sourceDomains: ["culture.ru"],
      recommendedAction: "Исключить из KPI субъекта.",
    }),
  ];
}

function inputSkeleton(): Omit<
  ExecutiveSummaryStageInput,
  "verifiedFindings" | "ambiguousFindings" | "identityPollution"
> {
  return {
    ...baseEnvelope(),
    schemaVersion: EXECUTIVE_SUMMARY_STAGE_INPUT_SCHEMA_VERSION,
    subject: GLINKA_SUBJECT,
    coverage: [
      { region: "RU", surface: "organic", sampleStatus: "MEASURED" },
      { region: "MD", surface: "organic", sampleStatus: "MEASURED" },
      { region: "RU", surface: "ai_answers", sampleStatus: "MEASURED" },
      { region: "MD", surface: "images", sampleStatus: "NOT_COLLECTED" },
    ],
    regionalMetrics: [
      { region: "RU", adverseCount: 4, totalCount: 25, adverseSharePercent: 16 },
      { region: "MD", adverseCount: 5, totalCount: 14, adverseSharePercent: 36 },
    ],
    dataGaps: [
      { area: "Изображения (Молдова)", detail: "выборка по изображениям в регионе Молдова не собрана" },
      { area: "Корпоративное владение", detail: "полная структура владения офшорными компаниями недоступна в открытых источниках" },
    ],
    sourceQuality: [
      { domain: "rbc.ru", reliability: "REPUTABLE" },
      { domain: "occrp.org", reliability: "REPUTABLE" },
      { domain: "zdg.md", reliability: "REPUTABLE" },
    ],
    recommendedActions: ["Обновить мониторинг выдачи через 30 дней."],
  };
}

function bundle(findings: Finding[], excludedFindingIds: string[] = []) {
  return {
    ...baseEnvelope(),
    schemaVersion: "verified-finding-bundle-v1" as const,
    kpiEligibleSubjectMatches: ["SUBJECT_MATCH" as const],
    findings,
    excludedFindingIds,
    exclusionReasons: Object.fromEntries(excludedFindingIds.map((id) => [id, "OTHER_SUBJECT"])),
  };
}

/** 1. Rich evidence: полный набор SUBJECT_MATCH findings + шум композитора в bundle (исключён). */
export function richEvidenceFixture(): ExecutiveSummaryStageInput {
  const noise = composerNoiseFindings();
  return {
    ...inputSkeleton(),
    verifiedFindings: bundle(
      [...glinkaVerifiedFindings(), ...noise],
      noise.map((f) => f.findingId)
    ),
    ambiguousFindings: [],
    identityPollution: {
      otherSubjectCount: 2,
      ambiguousCount: 1,
      dominantOtherSubject: "Михаил Глинка (композитор)",
      notes: [],
    },
  };
}

/** 2. Insufficient data: меньше 4 пригодных findings. */
export function insufficientDataFixture(): ExecutiveSummaryStageInput {
  const skeleton = inputSkeleton();
  return {
    ...skeleton,
    regionalMetrics: [{ region: "RU", adverseCount: 0, totalCount: 0, adverseSharePercent: null }],
    verifiedFindings: bundle([
      finding({
        findingId: "f-single-weak",
        theme: "Единичное упоминание",
        claim: "Единственное деловое упоминание без подтверждения контекста.",
        riskLevel: "low",
        confidence: 0.4,
      }),
    ]),
    ambiguousFindings: [],
    identityPollution: { otherSubjectCount: 0, ambiguousCount: 2, dominantOtherSubject: null, notes: [] },
  };
}

/** 3. Wrong-subject noise: выдача почти целиком о композиторе. */
export function wrongSubjectNoiseFixture(): ExecutiveSummaryStageInput {
  const noise = composerNoiseFindings();
  return {
    ...inputSkeleton(),
    verifiedFindings: bundle(
      [
        ...noise,
        finding({
          findingId: "f-weak-subject",
          theme: "Слабое деловое упоминание",
          claim: "Короткое упоминание тёзки-предпринимателя без идентификаторов.",
          riskLevel: "low",
          confidence: 0.35,
        }),
      ],
      noise.map((f) => f.findingId)
    ),
    ambiguousFindings: [
      finding({
        findingId: "f-ambiguous-surname",
        theme: "Однофамильцы",
        claim: "Запрос по фамилии возвращает материалы без различающих идентификаторов.",
        subjectMatch: "AMBIGUOUS",
        confidence: 0.3,
      }),
    ],
    identityPollution: {
      otherSubjectCount: 14,
      ambiguousCount: 6,
      dominantOtherSubject: "Михаил Глинка (композитор)",
      notes: ["Более половины выдачи по фамилии занято материалами о композиторе."],
    },
  };
}

/** 4. Conflicting sources: офшорный тезис противоречит официальному реестру. */
export function conflictingSourceFixture(): ExecutiveSummaryStageInput {
  const skeleton = inputSkeleton();
  return {
    ...skeleton,
    sourceQuality: [
      ...skeleton.sourceQuality,
      {
        domain: "opencorporates.com",
        reliability: "AGGREGATOR",
        conflictsWithDomains: ["egrul.nalog.ru"],
      },
    ],
    verifiedFindings: bundle(glinkaVerifiedFindings()),
    ambiguousFindings: [],
    identityPollution: {
      otherSubjectCount: 2,
      ambiguousCount: 0,
      dominantOtherSubject: "Михаил Глинка (композитор)",
      notes: [],
    },
  };
}
