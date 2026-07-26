/**
 * OpenSanctions — единственный работающий источник комплаенса (шаг 04.3).
 *
 * Продуктовое решение: подписки на LexisNexis / Dow Jones / World-Check нет и в
 * этой ветке не будет, а раздел, наполняемый демо-данными, — ложь в документе о
 * реальном человеке. OpenSanctions закрывает главный вопрос комплаенса
 * (санкции, PEP, розыск) законно, открытым API и без закупки.
 *
 * Границы источника названы честно и в отчёте, и здесь: он не даёт глубины
 * LexisNexis по судебным и медийным записям. Отсутствие совпадения означает
 * «в санкционных перечнях и списках PEP не найден», а не «проверен всюду».
 *
 * Работает и с облачным сервисом, и с самостоятельно поднятым `yente`: адрес и
 * набор данных задаются конфигурацией, форма API одна и та же.
 */

import { getComplianceProviderStatus, complianceProviderConfig } from "./config";
import { buildOpenSanctionsMatchBody, mapOpenSanctionsResponse } from "./open-sanctions-mapping";
import { ProviderHttpError, postJson } from "../providers/http";
import type { ComplianceProvider } from "./provider-interface";
import type { ComplianceScreeningRequest, ComplianceScreeningResult } from "./types";

const NAME = "OPEN_SANCTIONS" as const;

export const openSanctionsProvider: ComplianceProvider = {
  name: NAME,
  kind: "REAL",
  getStatus() {
    return getComplianceProviderStatus(NAME);
  },
  async screenPerson(request: ComplianceScreeningRequest): Promise<ComplianceScreeningResult> {
    const status = getComplianceProviderStatus(NAME);
    if (status.status === "DISABLED") {
      return {
        status: "DISABLED",
        provider: NAME,
        hits: [],
        error: {
          code: "PROVIDER_DISABLED",
          message: `${status.label} выключен. Включите OPEN_SANCTIONS_ENABLED или используйте ручной импорт.`,
          retryable: false,
        },
      };
    }
    if (status.status === "NOT_CONFIGURED") {
      return {
        status: "NOT_CONFIGURED",
        provider: NAME,
        hits: [],
        error: {
          code: "PROVIDER_NOT_CONFIGURED",
          message: `${status.label} не настроен: ${status.missingConfigKeys.join(", ")}.`,
          retryable: false,
        },
      };
    }

    const cfg = complianceProviderConfig.openSanctions;
    const subjectName = String(request.subjectFullName ?? "").trim();
    if (!subjectName) {
      // Пустой запрос провайдер выполнит и вернёт мусор: имя — единственный
      // обязательный признак, и подставлять вместо него нечего.
      return {
        status: "FAILED",
        provider: NAME,
        hits: [],
        error: {
          code: "SUBJECT_NAME_MISSING",
          message: "Имя субъекта не заполнено — проверка по санкционным базам не выполнялась.",
          retryable: false,
        },
      };
    }

    const url = `${cfg.apiBaseUrl!.replace(/\/+$/u, "")}/match/${encodeURIComponent(cfg.dataset)}`;
    const body = buildOpenSanctionsMatchBody({
      fullName: subjectName,
      aliases: request.aliases,
      dateOfBirth: request.dateOfBirth,
      country: request.country,
      nationality: request.nationality,
    });

    try {
      const payload = await postJson(url, body, {
        timeoutMs: cfg.timeoutMs,
        // Ключ уходит заголовком и никогда не попадает ни в URL, ни в журнал.
        headers: cfg.apiKey ? { authorization: `ApiKey ${cfg.apiKey}` } : {},
      });
      const hits = mapOpenSanctionsResponse({
        subjectName,
        payload,
        minScore: cfg.minScore,
        webBaseUrl: cfg.webBaseUrl,
      });
      return { status: "SUCCESS", provider: NAME, hits };
    } catch (err) {
      if (err instanceof ProviderHttpError) {
        return {
          status: "PROVIDER_ERROR",
          provider: NAME,
          hits: [],
          error: { code: err.code, message: err.message, retryable: err.retryable },
        };
      }
      return {
        status: "PROVIDER_ERROR",
        provider: NAME,
        hits: [],
        error: {
          code: "PROVIDER_REQUEST_FAILED",
          message: "Запрос к OpenSanctions не выполнен.",
          retryable: true,
        },
      };
    }
  },
};
