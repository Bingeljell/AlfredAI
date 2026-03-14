export const LEAD_AGENT_TOOL_ALLOWLIST = [
  "search",
  "search_status",
  "recover_search",
  "run_diagnostics",
  "doc_qa",
  "writer_agent",
  "lead_search_shortlist",
  "web_fetch",
  "lead_extract",
  "email_enrich",
  "lead_pipeline",
  "write_csv",
  "file_list",
  "file_read",
  "file_write",
  "file_edit",
  "shell_exec",
  "process_list",
  "process_stop"
] as const;

export function resolveLeadAgentToolAllowlist(): string[] {
  return [...LEAD_AGENT_TOOL_ALLOWLIST];
}

export const RESEARCH_AGENT_TOOL_ALLOWLIST = [
  "search",
  "search_status",
  "recover_search",
  "lead_search_shortlist",
  "web_fetch",
  "writer_agent",
  "doc_qa",
  "file_read",
  "file_write",
  "file_edit"
] as const;

export function resolveResearchAgentToolAllowlist(): string[] {
  return [...RESEARCH_AGENT_TOOL_ALLOWLIST];
}

export const OPS_AGENT_TOOL_ALLOWLIST = [
  "doc_qa",
  "file_list",
  "file_read",
  "file_write",
  "file_edit",
  "shell_exec",
  "process_list",
  "process_stop"
] as const;

export function resolveOpsAgentToolAllowlist(): string[] {
  return [...OPS_AGENT_TOOL_ALLOWLIST];
}
