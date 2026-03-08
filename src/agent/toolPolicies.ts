export const LEAD_AGENT_TOOL_ALLOWLIST = [
  "search",
  "search_status",
  "recover_search",
  "run_diagnostics",
  "doc_qa",
  "writer_agent",
  "web_fetch",
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
