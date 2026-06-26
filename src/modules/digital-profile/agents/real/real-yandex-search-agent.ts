/**
 * Real Yandex search agent. Delegates to the official Yandex Search API (XML)
 * via YandexSearchProvider and stores evidence-first search_results.
 */

import { yandexSearchProvider } from "../../providers/yandex-search-provider";
import { providerConfig } from "../../providers/config";
import type { SearchProvider } from "../../providers/search-provider";
import type { AuditAction } from "../../services/audit-log-service";
import type { AgentNameValue } from "../../types";
import { RealSearchAgentBase } from "./real-search-agent-base";

export class RealYandexSearchAgent extends RealSearchAgentBase {
  readonly name = "REAL_YANDEX_SEARCH";
  readonly displayName = "Yandex Search (real)";
  readonly description =
    "Searches Yandex via the official Yandex Cloud Search API v2 and stores evidence.";
  readonly agentName: AgentNameValue = "YANDEX_SEARCH";

  protected readonly provider: SearchProvider = yandexSearchProvider;
  protected readonly engine = "YANDEX" as const;

  protected maxQueriesPerAudit(): number {
    return providerConfig.yandex.maxQueriesPerAudit;
  }

  protected auditAction(): AuditAction {
    return "REAL_YANDEX_SEARCH_RUN";
  }
}
