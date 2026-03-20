export type PolicyMode = "trusted" | "balanced";

export type RunStatus = "queued" | "running" | "completed" | "cancelled" | "failed" | "needs_approval";

export type SearchProviderName = "searxng" | "brave" | "brightdata";

export type SessionOutputKind =
  | "article"
  | "draft"
  | "research_packet"
  | "lead_csv"
  | "lead_set"
  | "notes"
  | "generic_output";

export type SessionOutputAvailability = "body_available" | "metadata_only" | "missing";

export type TurnOutputShape =
  | "article"
  | "ranked_list"
  | "comparison"
  | "brief"
  | "memo"
  | "email"
  | "outline"
  | "social_post"
  | "notes"
  | "rewrite"
  | "generic"
  | "list"
  | "table"
  | "csv";

export interface TurnContract {
  taskType: "lead_generation" | "general";
  groundedObjective: string;
  requiredDeliverable: string;
  hardConstraints: string[];
  softPreferences: string[];
  doneCriteria: string[];
  assumptions: string[];
  blockingUnknowns: string[];
  preferredOutputShape: TurnOutputShape | null;
  requiredFields: string[];
  requiresDraft: boolean;
  requiresCitations: boolean;
  targetWordCount: number | null;
  requestedOutputPath: string | null;
  clarificationNeeded: boolean;
  clarificationQuestion: string | null;
}

export interface SessionOutputRecord {
  id: string;
  kind: SessionOutputKind;
  runId: string;
  createdAt: string;
  title: string;
  summary: string;
  artifactPath?: string;
  contentPreview?: string;
  availability: SessionOutputAvailability;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface SessionWorkingMemory {
  activeObjective?: string;
  lastRunId?: string;
  lastCompletedRunId?: string;
  lastCompletedAt?: string;
  lastArtifacts?: string[];
  lastOutcomeSummary?: string;
  activeThreadSummary?: string;
  sessionSummary?: string;
  recentTurns?: SessionTurnSnippet[];
  recentOutputs?: SessionOutputRecord[];
  unresolvedItems?: string[];
  lastSpecialist?: string;
}

export interface SessionTurnSnippet {
  role: "user" | "assistant";
  content: string;
  runId?: string;
  timestamp: string;
}

export interface SessionPromptContext {
  activeObjective?: string;
  lastRunId?: string;
  lastSpecialist?: string;
  lastCompletedRun?: {
    runId: string;
    message?: string;
    assistantText?: string;
    artifactPaths?: string[];
    completedAt?: string;
  };
  lastArtifacts?: string[];
  lastOutcomeSummary?: string;
  activeThreadSummary?: string;
  sessionSummary?: string;
  recentTurns?: SessionTurnSnippet[];
  recentOutputs?: SessionOutputRecord[];
  unresolvedItems?: string[];
}

export interface SessionRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: "active";
  metadata?: Record<string, unknown>;
  workingMemory?: SessionWorkingMemory;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: SearchProviderName;
  rank: number;
}


export interface ToolCallRecord {
  toolName: string;
  inputRedacted: unknown;
  outputRedacted: unknown;
  durationMs: number;
  status: "ok" | "error";
  timestamp: string;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface LlmUsageTotals extends LlmUsage {
  callCount: number;
}

export type RunPhase =
  | "session"
  | "thought"
  | "sub_react_step"
  | "tool"
  | "observe"
  | "persist"
  | "route"
  | "final"
  | "approval";

export interface RunEvent {
  runId: string;
  sessionId: string;
  phase: RunPhase;
  eventType: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface RunRecord {
  runId: string;
  sessionId: string;
  message: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  cancelRequestedAt?: string;
  cancelledAt?: string;
  assistantText?: string;
  artifactPaths?: string[];
  approvalToken?: string;
  llmUsage?: LlmUsageTotals;
  toolCalls: ToolCallRecord[];
}

export interface RunOutcome {
  status: RunStatus;
  assistantText?: string;
  artifactPaths?: string[];
  approvalToken?: string;
  specialist?: string;
}
