import type { z } from "zod";
import type { LeadCandidate, PolicyMode } from "../types.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { executeLeadSubReactPipeline } from "../tools/lead/subReactPipeline.js";
import type { PagePayload } from "../tools/lead/browserPool.js";
import type { LeadExecutionBrief } from "../tools/lead/schemas.js";
import type { LlmProvider } from "../services/llm/types.js";

export interface ResearchSourceCard {
  url: string;
  title: string | null;
  date: string | null;
  claim: string;
  quote: string | null;
  sourceTool: string;
}

export type AgentMetadataValue = string | number | boolean | null;

export interface AgentWorkAssumption {
  id: string;
  statement: string;
  source: "user" | "model" | "tool" | "runtime";
  confidence: "low" | "medium" | "high";
}

export interface AgentActiveWorkItem {
  id: string;
  kind: "task" | "candidate_set" | "evidence" | "draft" | "artifact" | "generic";
  label: string;
  summary: string;
  status: "pending" | "active" | "ready" | "blocked" | "completed";
  candidateSetIds?: string[];
  evidenceRecordIds?: string[];
  metadata?: Record<string, AgentMetadataValue>;
}

export interface AgentCandidateEntry {
  id: string;
  label: string;
  summary: string;
  status: "candidate" | "supported" | "selected" | "rejected" | "unknown";
  evidenceRecordIds?: string[];
  metadata?: Record<string, AgentMetadataValue>;
}

export interface AgentCandidateSet {
  id: string;
  label: string;
  objective?: string;
  status: "open" | "narrowing" | "ready" | "completed";
  items: AgentCandidateEntry[];
  metadata?: Record<string, AgentMetadataValue>;
}

export interface AgentEvidenceRecord {
  id: string;
  kind: "search_result" | "fetched_page" | "source_card" | "draft" | "artifact" | "generic";
  summary: string;
  source: "search" | "fetch" | "writer" | "tool" | "user" | "memory" | "runtime";
  toolName?: string;
  url?: string;
  artifactPath?: string;
  supports?: string[];
  confidence: "low" | "medium" | "high" | "unknown";
  metadata?: Record<string, AgentMetadataValue>;
}

export interface AgentSynthesisState {
  status: "not_ready" | "emerging" | "ready" | "partial" | "complete";
  summary: string;
  missingEvidence: string[];
  completionGaps?: string[];
  readyForSynthesis: boolean;
  metadata?: Record<string, AgentMetadataValue>;
}

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
  fetchedPages: PagePayload[];
  shortlistedUrls?: string[];
  executionBrief?: LeadExecutionBrief;
  researchSourceCards?: ResearchSourceCard[];
  assumptions?: AgentWorkAssumption[];
  unresolvedItems?: string[];
  activeWorkItems?: AgentActiveWorkItem[];
  candidateSets?: AgentCandidateSet[];
  evidenceRecords?: AgentEvidenceRecord[];
  synthesisState?: AgentSynthesisState;
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
  setAssumptions?: (assumptions: AgentWorkAssumption[]) => void;
  getAssumptions?: () => AgentWorkAssumption[];
  setUnresolvedItems?: (items: string[]) => void;
  getUnresolvedItems?: () => string[];
  setActiveWorkItems?: (items: AgentActiveWorkItem[]) => void;
  getActiveWorkItems?: () => AgentActiveWorkItem[];
  setCandidateSets?: (sets: AgentCandidateSet[]) => void;
  getCandidateSets?: () => AgentCandidateSet[];
  setEvidenceRecords?: (records: AgentEvidenceRecord[]) => void;
  getEvidenceRecords?: () => AgentEvidenceRecord[];
  setSynthesisState?: (state: AgentSynthesisState) => void;
  getSynthesisState?: () => AgentSynthesisState | undefined;
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
