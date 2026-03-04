import type { z } from "zod";
import type { LeadCandidate } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";

export interface LeadAgentDefaults {
  searchMaxResults: number;
  subReactMaxPages: number;
  subReactBrowseConcurrency: number;
  subReactBatchSize: number;
  subReactLlmMaxCalls: number;
  subReactMinConfidence: number;
}

export interface LeadAgentState {
  leads: LeadCandidate[];
  artifacts: string[];
  requestedLeadCount: number;
}

export interface LeadAgentToolContext {
  runId: string;
  sessionId: string;
  message: string;
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  openAiApiKey?: string;
  defaults: LeadAgentDefaults;
  leadPipelineExecutor: typeof executeLeadSubReactPipeline;
  state: LeadAgentState;
  addLeads: (leads: LeadCandidate[]) => { addedCount: number; totalCount: number };
  addArtifact: (artifactPath: string) => void;
}

export interface LeadAgentToolDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  inputSchema: TSchema;
  inputHint: string;
  execute: (
    input: z.infer<TSchema>,
    context: LeadAgentToolContext
  ) => Promise<Record<string, unknown>>;
}
