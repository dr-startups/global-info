/**
 * Real Google search agent. Delegates to the official Custom Search JSON API via
 * GoogleSearchProvider and stores evidence-first search_results.
 *
 * Google собирает позиции органической выдачи (`POSITIONAL_SERP_SOURCE`), и
 * поэтому ходит не по личному набору запросов, а по **плану аудита** — тому
 * самому, по которому раньше ходил Topvisor (шаг 0137).
 */

import { googleSearchProvider } from "../../providers/google-search-provider";
import { providerConfig } from "../../providers/config";
import { POSITIONAL_SERP_SOURCE } from "../../config/defaults";
import { regionProfile } from "../../search-surfaces/region-profiles";
import {
  offlineOrionQueryPlan,
  SERP_AUDIT_DEPTH,
  type OfflinePlanSubject,
} from "../../search-surfaces/offline-orion-query-plan";
import type { SearchProvider } from "../../providers/search-provider";
import type { AuditAction } from "../../services/audit-log-service";
import type { AgentNameValue } from "../../types";
import { RealSearchAgentBase, type AuditSearchSpec } from "./real-search-agent-base";

/**
 * План аудита в форме запроса к провайдеру (шаг 0137).
 *
 * Шаг 0136 переключил позиции Google на Serper и оставил сборщику личный набор:
 * не больше трёх запросов, один регион, своя глубина. На прогоне Галицкого это
 * дало 19 строк по одному запросу в позициях 1–9 и пустой контур ОАЭ, тогда
 * как Topvisor приносил 403 строки по 25 запросам в двух контурах.
 *
 * План один на продукт (`offlineOrionQueryPlan`), и второго набора запросов для
 * той же выдачи не заводится. Код региона и язык берутся у профиля региона:
 * «UAE» для поисковика не код, ему нужен `ae`.
 *
 * `null` — движок позиции не собирает, и набор остаётся личным.
 */
export function googleAuditSearchSpecs(subject: OfflinePlanSubject): AuditSearchSpec[] | null {
  if (POSITIONAL_SERP_SOURCE.GOOGLE !== "serper") return null;
  return offlineOrionQueryPlan(subject).map((spec) => {
    const profile = regionProfile(spec.region);
    return {
      query: spec.query,
      region: profile.googleGl,
      language: profile.googleHl,
      limit: SERP_AUDIT_DEPTH,
      // Контур отчёта, а не код региона поисковика: склейка различает строки
      // по нему, и «ae» ей ни о чём не говорит (шаг 0138).
      contour: spec.region,
    };
  });
}

export class RealGoogleSearchAgent extends RealSearchAgentBase {
  readonly name = "REAL_GOOGLE_SEARCH";
  readonly displayName = "Google Search (real)";
  readonly description =
    "Searches Google via the selected real provider (Custom Search JSON API or an external SERP API) and stores evidence.";
  readonly agentName: AgentNameValue = "GOOGLE_SEARCH";

  protected readonly provider: SearchProvider = googleSearchProvider;
  protected readonly engine = "GOOGLE" as const;

  protected auditSearchSpecs(subject: OfflinePlanSubject): AuditSearchSpec[] | null {
    return googleAuditSearchSpecs(subject);
  }

  protected maxQueriesPerAudit(): number {
    return providerConfig.google.maxQueriesPerAudit;
  }

  protected auditAction(): AuditAction {
    return "REAL_GOOGLE_SEARCH_RUN";
  }
}
