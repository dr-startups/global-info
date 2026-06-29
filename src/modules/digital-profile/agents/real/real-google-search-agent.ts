/**
 * Real Google search agent. Delegates to the official Custom Search JSON API via
 * GoogleSearchProvider and stores evidence-first search_results.
 */

import { googleSearchProvider } from "../../providers/google-search-provider";
import { providerConfig } from "../../providers/config";
import type { SearchProvider } from "../../providers/search-provider";
import type { AuditAction } from "../../services/audit-log-service";
import type { AgentNameValue } from "../../types";
import { RealSearchAgentBase } from "./real-search-agent-base";

export class RealGoogleSearchAgent extends RealSearchAgentBase {
  readonly name = "REAL_GOOGLE_SEARCH";
  readonly displayName = "Google Search (real)";
  readonly description =
    "Searches Google via the selected real provider (Custom Search JSON API or an external SERP API) and stores evidence.";
  readonly agentName: AgentNameValue = "GOOGLE_SEARCH";

  protected readonly provider: SearchProvider = googleSearchProvider;
  protected readonly engine = "GOOGLE" as const;

  protected maxQueriesPerAudit(): number {
    return providerConfig.google.maxQueriesPerAudit;
  }

  protected auditAction(): AuditAction {
    return "REAL_GOOGLE_SEARCH_RUN";
  }
}
