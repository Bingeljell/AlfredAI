export const LEAD_AGENT_TOOL_ALLOWLIST = [
  "search",
  "search_status",
  "recover_search",
  "run_diagnostics",
  "doc_qa",
  "article_writer",
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
