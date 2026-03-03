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

export interface LeadCandidate {
  companyName: string;
  fullName?: string;
  role?: string;
  location?: string;
  email?: string;
  emailConfidence: number;
  sourceUrls: string[];
  notes?: string;
}

export interface ToolCallRecord {
  toolName: string;
  inputRedacted: unknown;
  outputRedacted: unknown;
  durationMs: number;
  status: "ok" | "error";
  timestamp: string;
}

export interface RunEvent {
  runId: string;
  sessionId: string;
  phase: "session" | "thought" | "tool" | "observe" | "persist" | "route" | "final" | "approval";
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

export interface ReActContext {
  runId: string;
  sessionId: string;
  message: string;
}
