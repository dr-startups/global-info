/**
 * Проверка с сайта: создание, панель персоны, решение, заявка.
 *
 * Посетитель — не пользователь приложения. Всё, что он делает, подписано
 * проверкой (`self-check:<id>`) и идёт через существующие сервисы: кейс заводит
 * `createCaseInTx`, панель собирает и решение пишет сервис ворот персоны.
 * Своих ответов на вопросы «как завести кейс» и «можно ли собирать» здесь нет —
 * только то, что относится к посетителю: согласие, лимиты, возврат к своей
 * проверке, заявка.
 */

import { randomBytes, randomUUID } from "node:crypto";
import type { Prisma, PrismaClient, SelfCheck } from "@prisma/client";
import type { z } from "zod";
import { prisma } from "@/server/prisma/client";
import { AppError, ConflictError, normalizeError } from "@/modules/digital-profile/http/errors";
import { numberSetting } from "@/modules/digital-profile/config/defaults";
import {
  loadCaseSubject,
  type CaseSubjectInfo,
} from "@/modules/digital-profile/agents/mock/mock-utils";
import { recordAudit } from "@/modules/digital-profile/services/audit-log-service";
import {
  createCaseInTx,
  retryOnCaseNumberRace,
} from "@/modules/digital-profile/services/case-service";
import {
  saveSubjectProfileEdits,
  type SubjectProfileEdits,
} from "@/modules/digital-profile/services/subject-profile-admin";
import {
  buildPersonaPanel,
  loadLatestPersonaCheck,
  recordPersonaCheck,
  recordPersonaDecision,
  subjectInputHash,
  type PersonaCheckPrisma,
  type PersonaCheckRow,
  type PersonaStoreDeps,
} from "@/modules/digital-profile/services/subject-persona-check";
import { CreateDigitalProfileCaseSchema } from "@/modules/digital-profile/validation/case-schemas";
import { CONSENT_VERSION } from "@/modules/site/content/legal";
import { selfCheckActor } from "./actor";
import { verifyCaptcha, type CaptchaOutcome } from "./captcha";
import {
  publicPersonaPanel,
  publicSelfCheckStatus,
  type PublicPersonaPanel,
  type PublicSelfCheckStatus,
} from "./public-dto";
import {
  countRecentChecksByIp,
  ipHashOf,
  ipLimitReached,
  isReusableCheck,
  subjectHashOf,
} from "./quotas";
import {
  SelfCheckFormSchema,
  SelfCheckLeadSchema,
  SelfCheckPersonaDecisionSchema,
  type SelfCheckForm,
} from "./schemas";
import {
  reconcileSelfCheckRun,
  startSelfCheckRun as startLightRun,
  type LightRunDeps,
} from "./light-run";
import { LEAD_ACCEPTING_STATUSES } from "./status";
import {
  createSelfCheckToken,
  selfCheckSecret,
  selfCheckTokenTtlSeconds,
  verifySelfCheckToken,
} from "./token";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Сколько захват сборки панели считается живым. Бюджет сборки — 20 секунд;
 * захват старше минуты без панели оставил процесс, который умер посреди
 * сборки, и ждать его дальше значит оставить посетителя без панели навсегда.
 */
const PERSONA_CLAIM_STALE_MS = 60_000;

export type SelfCheckDb = Pick<
  PrismaClient,
  "selfCheck" | "subjectPersonaCheck" | "auditLog" | "$transaction"
>;

export interface SelfCheckDeps extends Pick<LightRunDeps, "startRun" | "loadJob" | "listSteps"> {
  db?: SelfCheckDb;
  now?: () => Date;
  env?: NodeJS.ProcessEnv;
  secret?: string;
  newId?: () => string;
  newPublicId?: () => string;
  verifyCaptcha?: (input: {
    token?: string | null;
    ip: string;
    env?: NodeJS.ProcessEnv;
  }) => Promise<CaptchaOutcome>;
  saveSubjectProfile?: (input: {
    caseId: string;
    subjectName: string;
    subjectAliases?: string[];
    edits: SubjectProfileEdits;
  }) => unknown;
  loadSubject?: (caseId: string) => Promise<CaseSubjectInfo>;
  buildPanel?: typeof buildPersonaPanel;
}

function resolveDeps(deps: SelfCheckDeps = {}) {
  const env = deps.env ?? process.env;
  return {
    db: deps.db ?? (prisma as unknown as SelfCheckDb),
    now: deps.now ?? (() => new Date()),
    env,
    secret: () => deps.secret ?? selfCheckSecret(env),
    newId: deps.newId ?? (() => randomUUID()),
    // 18 байт — 24 знака base64url: адрес проверки не угадать перебором.
    newPublicId: deps.newPublicId ?? (() => randomBytes(18).toString("base64url")),
    verifyCaptcha: deps.verifyCaptcha ?? verifyCaptcha,
    saveSubjectProfile: deps.saveSubjectProfile ?? saveSubjectProfileEdits,
    loadSubject: deps.loadSubject ?? loadCaseSubject,
    buildPanel: deps.buildPanel ?? buildPersonaPanel,
  };
}

type Resolved = ReturnType<typeof resolveDeps>;

const auditClient = (db: SelfCheckDb) => db as unknown as Prisma.TransactionClient;

const personaStore = (d: Resolved): PersonaStoreDeps => ({
  prisma: d.db as unknown as PersonaCheckPrisma,
  now: d.now,
});

/** Отказ схемы — тем же конвертом, что у всех ручек: 400 с полями. */
function parseOrThrow<S extends z.ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw normalizeError(parsed.error);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Создание
// ---------------------------------------------------------------------------

export type CreateSelfCheckResult =
  | { kind: "created"; checkId: string; publicId: string; status: "CREATED"; token: string }
  | { kind: "existing"; existingPublicId: string };

/**
 * Кейс проверки с сайта: основание — законный интерес, согласие — получено
 * (сам факт согласия посетителя хранит запись проверки). Регион — Россия:
 * кириллическое ФИО с регионом `RU` планирует только российский контур поиска.
 */
function caseInputOf(form: SelfCheckForm) {
  return CreateDigitalProfileCaseSchema.parse({
    fullName: form.fullName,
    aliases: form.aliases,
    birthDate: form.birthDate,
    targetRegions: ["RU"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "OBTAINED",
    notes: "Самопроверка с сайта",
  });
}

function formSnapshot(form: SelfCheckForm): Prisma.InputJsonObject {
  return {
    fullName: form.fullName,
    birthDate: form.birthDate,
    aliases: form.aliases,
    city: form.city ?? null,
    inn: form.inn ?? null,
    employer: form.employer ?? null,
    position: form.position ?? null,
    website: form.website ?? null,
  };
}

/**
 * Признаки формы для профиля субъекта; `null` — писать нечего. Отсутствующий
 * список не передаётся вовсе: пустой затёр бы то, что профиль строит сам.
 */
function profileEditsOf(form: SelfCheckForm): SubjectProfileEdits | null {
  const context = [form.employer, form.position, form.city, form.website].filter(
    (v): v is string => Boolean(v)
  );
  const edits: SubjectProfileEdits = {};
  if (form.inn) edits.inn = [form.inn];
  if (context.length > 0) edits.contextIdentifiers = context;
  return Object.keys(edits).length > 0 ? edits : null;
}

/**
 * Проверка, к которой браузер может вернуться: та, чья cookie у него есть, с
 * теми же данными и в окне дедупликации. Без cookie ответа нет — по одним ФИО
 * и дате чужую проверку не открыть, и человек с другого устройства получает
 * новую проверку.
 */
async function ownReusableCheck(
  d: Resolved,
  cookieToken: string | null,
  subjectHash: string,
  now: Date,
  secret: string
): Promise<SelfCheck | null> {
  const token = await verifySelfCheckToken(cookieToken, secret, now);
  if (!token) return null;
  const row = await d.db.selfCheck.findUnique({ where: { id: token.checkId } });
  return row && isReusableCheck(row, subjectHash, now, d.env) ? row : null;
}

export async function createSelfCheck(
  input: { body: unknown; ip: string; userAgent: string; cookieToken: string | null },
  deps: SelfCheckDeps = {}
): Promise<CreateSelfCheckResult> {
  const d = resolveDeps(deps);
  const form = parseOrThrow(SelfCheckFormSchema, input.body);
  const captcha = await d.verifyCaptcha({ token: form.captchaToken, ip: input.ip, env: d.env });
  const now = d.now();
  const secret = d.secret();
  const subjectHash = await subjectHashOf(form, secret);

  // Возврат к своей проверке — раньше лимитов: он ничего не создаёт и не тратит.
  const own = await ownReusableCheck(d, input.cookieToken, subjectHash, now, secret);
  if (own) return { kind: "existing", existingPublicId: own.publicId };

  const ipHash = await ipHashOf(input.ip, secret);
  if (ipLimitReached(await countRecentChecksByIp(d.db, ipHash, now), d.env)) {
    await recordAudit(
      {
        action: "SELF_CHECK_BLOCKED",
        actorId: selfCheckActor("anonymous"),
        ipAddress: input.ip,
        metadata: { reason: "RATE_LIMITED", ipHash },
      },
      auditClient(d.db)
    );
    throw new AppError("FORBIDDEN", 429, "Too many checks from this address", {
      reason: "RATE_LIMITED",
    });
  }

  const id = d.newId();
  const publicId = d.newPublicId();
  const actorId = selfCheckActor(id);
  const token = await createSelfCheckToken(id, secret, {
    now,
    ttlSeconds: selfCheckTokenTtlSeconds(d.env),
  });
  const record = {
    id,
    publicId,
    inputJson: formSnapshot(form),
    consentVersion: CONSENT_VERSION,
    consentAt: now,
    ip: input.ip,
    userAgent: input.userAgent,
    ipHash,
    subjectHash,
    captchaVerifiedAt: captcha.verified ? now : null,
    expiresAt: new Date(now.getTime() + numberSetting("SELF_CHECK_RETENTION_DAYS", d.env) * DAY_MS),
    createdAt: now,
  };
  const created = { kind: "created" as const, checkId: id, publicId, status: "CREATED" as const, token };

  if (form.company) {
    // Ловушка: запись остаётся следом и считается в лимит адреса, а кейс не
    // заводится — список дел принадлежит оператору. Ответ неотличим от успеха,
    // чтобы бот не подбирал обход.
    await d.db.$transaction(async (tx) => {
      await tx.selfCheck.create({
        data: { ...record, status: "BLOCKED", honeypotTripped: true, blockedReason: "CAPTCHA_FAILED" },
      });
      await recordAudit(
        {
          action: "SELF_CHECK_BLOCKED",
          actorId,
          ipAddress: input.ip,
          metadata: { reason: "HONEYPOT", publicId, ipHash },
        },
        tx
      );
    });
    return created;
  }

  await retryOnCaseNumberRace(() =>
    d.db.$transaction(async (tx) => {
      const subjectCase = await createCaseInTx(tx, caseInputOf(form), { actorId });
      await tx.selfCheck.create({ data: { ...record, caseId: subjectCase.id, status: "CREATED" } });
      await recordAudit(
        {
          caseId: subjectCase.id,
          action: "SELF_CHECK_CREATED",
          actorId,
          ipAddress: input.ip,
          metadata: { publicId, ipHash },
        },
        tx
      );
      // Профиль — файл в хранилище, а не строка базы, поэтому последним: не
      // записался — транзакция откатывает кейс и запись проверки.
      const edits = profileEditsOf(form);
      if (edits) {
        d.saveSubjectProfile({
          caseId: subjectCase.id,
          subjectName: form.fullName,
          subjectAliases: form.aliases,
          edits,
        });
      }
    })
  );
  return created;
}

// ---------------------------------------------------------------------------
// Чтение
// ---------------------------------------------------------------------------

export async function loadSelfCheckByPublicId(
  publicId: string,
  deps: SelfCheckDeps = {}
): Promise<SelfCheck | null> {
  // Длиннее любого выданного — не наш идентификатор, и в базу с ним не ходим.
  if (!publicId || publicId.length > 64) return null;
  return resolveDeps(deps).db.selfCheck.findUnique({ where: { publicId } });
}

/**
 * Есть ли проверка с таким адресом — для кода 404 у страницы мастера.
 *
 * Сбой базы — не «проверки нет»: человек с живой ссылкой получил бы 404 на свою
 * проверку. При сбое страница рисует мастер, и тот по отказу ручки скажет «нет
 * связи». Обезличенная запись существует: «срок истёк» говорит мастер.
 */
export async function selfCheckExists(publicId: string, deps: SelfCheckDeps = {}): Promise<boolean> {
  try {
    return (await loadSelfCheckByPublicId(publicId, deps)) !== null;
  } catch (error) {
    console.warn("[self-check] проверка адреса мастера не удалась, страница рисуется без 404", error);
    return true;
  }
}

export async function getSelfCheckStatus(
  check: SelfCheck,
  deps: SelfCheckDeps = {}
): Promise<PublicSelfCheckStatus> {
  const d = resolveDeps(deps);
  // Ход прогона читается из джобы; упавший прогон становится записью при чтении.
  const { check: current, run } = await reconcileSelfCheckRun(check, {
    ...deps,
    db: d.db,
    now: d.now,
    env: d.env,
  });
  const persona = current.caseId
    ? await loadLatestPersonaCheck(current.caseId, personaStore(d))
    : null;
  return publicSelfCheckStatus(current, persona, run, d.env);
}

/** Запуск лёгкого прогона — правила в `light-run.ts`. */
export function startSelfCheckRun(
  check: SelfCheck,
  ctx: { ip: string },
  deps: SelfCheckDeps = {}
): Promise<{ status: "RUNNING"; nextPollMs: number }> {
  const d = resolveDeps(deps);
  return startLightRun(check, ctx, { ...deps, db: d.db, now: d.now, env: d.env });
}

export type SelfCheckAdminRecord = Omit<SelfCheck, "ipHash" | "subjectHash">;

/** Запись для карточки кейса: целиком, кроме хешей — они служат лимитам, а не человеку. */
export async function loadSelfCheckForCase(
  caseId: string,
  deps: SelfCheckDeps = {}
): Promise<SelfCheckAdminRecord | null> {
  const row = await resolveDeps(deps).db.selfCheck.findUnique({ where: { caseId } });
  if (!row) return null;
  const { ipHash: _ipHash, subjectHash: _subjectHash, ...record } = row;
  return record;
}

// ---------------------------------------------------------------------------
// Панель персоны и решение
// ---------------------------------------------------------------------------

/** Кейс проверки, по которому можно действовать; пойманная ловушкой — нельзя. */
function openCaseId(check: SelfCheck): string {
  if (check.honeypotTripped || check.status === "BLOCKED" || !check.caseId) {
    throw new ConflictError("self-check is blocked", { reason: "SELF_CHECK_BLOCKED" });
  }
  return check.caseId;
}

/**
 * Захватить сборку панели. Условное обновление статуса, а не проверка «панели
 * ещё нет»: между проверкой и сборкой успевает прийти второй запрос, и панель
 * оплачивалась бы дважды.
 */
async function claimPersonaBuild(d: Resolved, checkId: string): Promise<boolean> {
  const now = d.now();
  const claimed = await d.db.selfCheck.updateMany({
    where: { id: checkId, status: "CREATED" },
    data: { status: "PERSONA_PENDING", updatedAt: now },
  });
  if (claimed.count === 1) return true;
  const current = await d.db.selfCheck.findUnique({ where: { id: checkId } });
  if (current?.status !== "PERSONA_PENDING") return false;
  if (now.getTime() - current.updatedAt.getTime() < PERSONA_CLAIM_STALE_MS) return false;
  const reclaimed = await d.db.selfCheck.updateMany({
    where: { id: checkId, status: "PERSONA_PENDING", updatedAt: current.updatedAt },
    data: { updatedAt: now },
  });
  return reclaimed.count === 1;
}

export async function buildSelfCheckPersona(
  check: SelfCheck,
  ctx: { ip: string },
  deps: SelfCheckDeps = {}
): Promise<PublicPersonaPanel> {
  const d = resolveDeps(deps);
  const caseId = openCaseId(check);
  if (check.status !== "CREATED" && check.status !== "PERSONA_PENDING") {
    throw new ConflictError("persona is already decided", { reason: "PERSONA_ALREADY_DECIDED" });
  }
  const store = personaStore(d);

  // Панель стоит денег: собранная однажды отдаётся, а не собирается заново.
  const latest = await loadLatestPersonaCheck(caseId, store);
  if (latest) return publicPersonaPanel(latest);

  if (!(await claimPersonaBuild(d, check.id))) {
    throw new ConflictError("persona panel is being built", { reason: "PERSONA_BUILD_IN_PROGRESS" });
  }

  let row: PersonaCheckRow;
  try {
    const subject = await d.loadSubject(caseId);
    const { request, snapshot } = await d.buildPanel({
      subject: {
        caseId,
        fullName: subject.fullName,
        aliases: subject.aliases,
        dateOfBirth: subject.dateOfBirth,
        nationality: subject.nationality,
        country: subject.location,
      },
    });
    row = await recordPersonaCheck({
      caseId,
      subjectInputHash: subjectInputHash(subject),
      request,
      snapshot,
      searchedBy: selfCheckActor(check.id),
      deps: store,
    });
  } catch (err) {
    // Захват снимается: иначе минуту проверка висела бы «в сборке» без панели.
    await d.db.selfCheck.updateMany({
      where: { id: check.id, status: "PERSONA_PENDING" },
      data: { status: "CREATED" },
    });
    throw err;
  }

  const panel = publicPersonaPanel(row);
  await recordAudit(
    {
      caseId,
      action: "SELF_CHECK_PERSONA_BUILT",
      actorId: selfCheckActor(check.id),
      ipAddress: ctx.ip,
      metadata: {
        personaCheckId: row.id,
        fetchStatus: row.fetchStatus,
        cardCount: panel.cards.length,
        sources: panel.sources,
      },
    },
    auditClient(d.db)
  );
  return panel;
}

/**
 * Решение посетителя пишет сервис ворот персоны — тот же, что решение
 * оператора, — и открывает те же ворота оркестратора. «Переголосовать» нельзя
 * так же, как оператору: другой ответ по той же панели — 409.
 */
export async function decideSelfCheckPersona(
  check: SelfCheck,
  body: unknown,
  ctx: { ip: string },
  deps: SelfCheckDeps = {}
): Promise<{ decision: string; decidedAt: Date | string | null }> {
  const d = resolveDeps(deps);
  const caseId = openCaseId(check);
  const input = parseOrThrow(SelfCheckPersonaDecisionSchema, body);
  const store = personaStore(d);
  const latest = await loadLatestPersonaCheck(caseId, store);
  if (!latest) {
    throw new ConflictError("persona panel is not built yet", { reason: "PERSONA_PANEL_NOT_BUILT" });
  }
  const selectedCardId = input.selectedCardId ?? null;
  const row = await recordPersonaDecision({
    caseId,
    checkId: latest.id,
    decision: input.decision,
    selectedCardId,
    decidedBy: selfCheckActor(check.id),
    deps: store,
  });
  await d.db.selfCheck.updateMany({
    where: { id: check.id, status: { in: ["CREATED", "PERSONA_PENDING"] } },
    data: { status: "PERSONA_DECIDED" },
  });
  await recordAudit(
    {
      caseId,
      action: "SELF_CHECK_PERSONA_DECIDED",
      actorId: selfCheckActor(check.id),
      ipAddress: ctx.ip,
      metadata: { personaCheckId: row.id, decision: row.decision, selectedCardId },
    },
    auditClient(d.db)
  );
  return { decision: String(row.decision), decidedAt: row.decidedAt };
}

// ---------------------------------------------------------------------------
// Заявка
// ---------------------------------------------------------------------------

const LEAD_CHANNELS = ["phone", "telegram", "email"] as const;

export async function submitSelfCheckLead(
  check: SelfCheck,
  body: unknown,
  ctx: { ip: string },
  deps: SelfCheckDeps = {}
): Promise<{ leadAt: Date }> {
  const d = resolveDeps(deps);
  if (check.honeypotTripped || !LEAD_ACCEPTING_STATUSES.includes(check.status)) {
    throw new ConflictError("lead is not applicable in this state", { reason: "LEAD_NOT_APPLICABLE" });
  }
  const lead = parseOrThrow(SelfCheckLeadSchema, body);
  const leadAt = d.now();
  await d.db.$transaction(async (tx) => {
    // Повторная отправка — исправление: контакты заменяются целиком.
    await tx.selfCheck.update({
      where: { id: check.id },
      data: {
        leadName: lead.name,
        leadPhone: lead.phone ?? null,
        leadEmail: lead.email ?? null,
        leadTelegram: lead.telegram ?? null,
        leadPreferredTime: lead.preferredTime ?? null,
        leadMessage: lead.message ?? null,
        leadAt,
      },
    });
    // Статус лида, выставленный менеджером, повторная отправка не сбрасывает.
    await tx.selfCheck.updateMany({
      where: { id: check.id, leadStatus: "NONE" },
      data: { leadStatus: "NEW" },
    });
    await recordAudit(
      {
        caseId: check.caseId,
        action: "SELF_CHECK_LEAD",
        actorId: selfCheckActor(check.id),
        ipAddress: ctx.ip,
        // Контакты в журнал не пишутся: журнал обезличиванием не чистится.
        metadata: {
          channels: LEAD_CHANNELS.filter((channel) => Boolean(lead[channel])),
          preferredTime: lead.preferredTime ?? null,
        },
      },
      tx
    );
  });
  return { leadAt };
}
