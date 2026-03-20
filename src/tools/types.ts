import type { z } from "zod";
import type { PolicyMode } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { PagePayload } from "../tools/browser/browserPool.js";
import type { LlmProvider } from "../provider/types.js";

export interface ResearchSourceCard {
  url: string;
  title: string | null;
  date: string | null;
  claim: string;
  quote: string | null;
  sourceTool: string;
}

export interface ToolDefaults {
  searchMaxResults: number;
  browseConcurrency: number;
}

export interface ToolState {
  artifacts: string[];
  fetchedPages: PagePayload[];
  researchSourceCards?: ResearchSourceCard[];
}

export interface ToolContext {
  runId: string;
  sessionId: string;
  message: string;
  deadlineAtMs: number;
  policyMode: PolicyMode;
  projectRoot: string;
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  openAiApiKey?: string;
  llmProviders?: LlmProvider[];
  defaults: ToolDefaults;
  state: ToolState;
  isCancellationRequested: () => Promise<boolean>;
  addArtifact: (artifactPath: string) => void;
  setFetchedPages: (pages: PagePayload[]) => void;
  getFetchedPages: () => PagePayload[];
  setResearchSourceCards?: (cards: ResearchSourceCard[]) => void;
  getResearchSourceCards?: () => ResearchSourceCard[];
}

export interface ToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TSchema;
  inputHint: string;
  requiresApproval?: boolean;
  execute: (
    input: z.infer<TSchema>,
    context: ToolContext
  ) => Promise<Record<string, unknown>>;
}
