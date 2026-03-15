import type { PolicyMode, RunOutcome } from "../../types.js";
import type { RunStore } from "../../runs/runStore.js";
import type { SearchManager } from "../../tools/search/searchManager.js";
import type { LeadAgentDefaults } from "../types.js";
import type { executeLeadSubReactPipeline } from "../../tools/lead/subReactPipeline.js";
import type { LeadExecutionBrief } from "../../tools/lead/schemas.js";

export interface AgentTaskContract {
  requiredDeliverable: string;
  requiresDraft: boolean;
  requiresCitations: boolean;
  minimumCitationCount: number;
  doneCriteria: string[];
  requestedOutputPath?: string | null;
  targetWordCount?: number | null;
}

export interface AgentSkillRunOptions {
  parentRunId?: string;
  delegationId?: string;
  scratchpad?: Record<string, unknown>;
  leadExecutionBrief?: LeadExecutionBrief;
  taskContract?: AgentTaskContract;
  runStore: RunStore;
  searchManager: SearchManager;
  workspaceDir: string;
  message: string;
  runId: string;
  sessionId: string;
  openAiApiKey?: string;
  defaults: LeadAgentDefaults;
  leadPipelineExecutor: typeof executeLeadSubReactPipeline;
  maxIterations: number;
  maxDurationMs: number;
  maxToolCalls: number;
  maxParallelTools: number;
  plannerMaxCalls: number;
  observationWindow: number;
  diminishingThreshold: number;
  policyMode: PolicyMode;
  isCancellationRequested: () => Promise<boolean>;
}

export interface AgentSkillDefinition {
  name: string;
  description: string;
  toolAllowlist?: string[];
  run: (options: AgentSkillRunOptions) => Promise<RunOutcome>;
}
