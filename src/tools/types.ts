import type { z } from "zod";
import type { LeadCandidate, PolicyMode } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import type { PagePayload } from "../tools/lead/browserPool.js";
import type { LeadExecutionBrief } from "../tools/lead/schemas.js";
import type { LlmProvider } from "../provider/types.js";

export interface ResearchSourceCard {
  url: string;
  title: string | null;
  date: string | null;
  claim: string;
  quote: string | null;
  sourceTool: string;
}

export interface LeadAgentDefaults {
  searchMaxResults: number;
  subReactMaxPages: number;
  subReactBrowseConcurrency: number;
  subReactBatchSize: number;
  subReactLlmMaxCalls: number;
  subReactMinConfidence: number;
  pinchtabBaseUrl?: string;
}

export interface LeadAgentState {
  leads: LeadCandidate[];
  artifacts: string[];
  requestedLeadCount: number;
  fetchedPages: PagePayload[];
  shortlistedUrls?: string[];
  executionBrief?: LeadExecutionBrief;
  researchSourceCards?: ResearchSourceCard[];
}

export interface LeadAgentToolContext {
  runId: string;
  sessionId: string;
  message: string;
  leadExecutionBrief?: LeadExecutionBrief;
  deadlineAtMs: number;
  policyMode: PolicyMode;
  projectRoot: string;
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  openAiApiKey?: string;
  llmProviders?: LlmProvider[];
  defaults: LeadAgentDefaults;
  leadPipelineExecutor: typeof executeLeadSubReactPipeline;
  state: LeadAgentState;
  isCancellationRequested: () => Promise<boolean>;
  addLeads: (leads: LeadCandidate[]) => { addedCount: number; totalCount: number };
  addArtifact: (artifactPath: string) => void;
  setFetchedPages: (pages: PagePayload[]) => void;
  getFetchedPages: () => PagePayload[];
  setShortlistedUrls?: (urls: string[]) => void;
  getShortlistedUrls?: () => string[];
  setResearchSourceCards?: (cards: ResearchSourceCard[]) => void;
  getResearchSourceCards?: () => ResearchSourceCard[];
}

export interface LeadAgentToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TSchema;
  inputHint: string;
  requiresApproval?: boolean;
  execute: (
    input: z.infer<TSchema>,
    context: LeadAgentToolContext
  ) => Promise<Record<string, unknown>>;
}
