export type PolicyMode = "trusted" | "balanced";

export type RunStatus = "queued" | "running" | "completed" | "cancelled" | "failed" | "needs_approval";

export type SearchProviderName = "searxng" | "brave" | "brightdata";

export interface SessionRecord {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  status: "active";
  metadata?: Record<string, unknown>;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  provider: SearchProviderName;
  rank: number;
}

export type LeadSizeMatch = "in_range" | "near_range" | "unknown" | "out_of_range";
export type LeadSelectionMode = "strict" | "relaxed";

export interface LeadCandidate {
  companyName: string;
  email?: string;
  emailEvidence?: string;
  website?: string;
  location?: string;
  employeeSizeText?: string;
  employeeMin?: number;
  employeeMax?: number;
  sizeEvidence?: string;
  sizeMatch?: LeadSizeMatch;
  selectionMode?: LeadSelectionMode;
  shortDesc: string;
  sourceUrl: string;
  confidence: number;
  evidence: string;
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
}
