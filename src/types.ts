export type PolicyMode = "trusted" | "balanced";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "needs_approval";

export type SearchProviderName = "searxng" | "brave";

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
  website?: string;
  location?: string;
  employeeSizeText?: string;
  employeeMin?: number;
  employeeMax?: number;
  sizeSource?: string;
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
  assistantText?: string;
  artifactPaths?: string[];
  approvalToken?: string;
  toolCalls: ToolCallRecord[];
}

export interface RunOutcome {
  status: RunStatus;
  assistantText?: string;
  artifactPaths?: string[];
  approvalToken?: string;
}
