/**
 * Real Google search agent. Delegates to the official Custom Search JSON API via
 * GoogleSearchProvider and stores evidence-first search_results.
 */

import { googleSearchProvider } from "../../providers/google-search-provider";
import type { SearchProvider } from "../../providers/search-provider";
import type { AgentNameValue } from "../../types";
import { RealSearchAgentBase } from "./real-search-agent-base";

export class RealGoogleSearchAgent extends RealSearchAgentBase {
  readonly name = "REAL_GOOGLE_SEARCH";
  readonly displayName = "Real Google Search";
  readonly description =
    "Searches Google via the official Custom Search JSON API and stores evidence.";
  readonly agentName: AgentNameValue = "GOOGLE_SEARCH";

  protected readonly provider: SearchProvider = googleSearchProvider;
  protected readonly engine = "GOOGLE" as const;
}
