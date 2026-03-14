export interface ToolInputContract {
  required: string[];
  bounds: string[];
  exampleInput: Record<string, unknown>;
}

const DEFAULT_TOOL_CONTRACT: ToolInputContract = {
  required: [],
  bounds: [],
  exampleInput: {}
};

const CONTRACT_MAP: Record<string, ToolInputContract> = {
  search: {
    required: ["query"],
    bounds: ["query length <= 400", "maxResults <= 15"],
    exampleInput: {
      query: "latest AI policy updates this week",
      maxResults: 10
    }
  },
  lead_search_shortlist: {
    required: ["query"],
    bounds: ["query length <= 400", "maxResults <= 15", "maxUrls <= 25"],
    exampleInput: {
      query: "managed service providers texas",
      maxResults: 12,
      maxUrls: 12
    }
  },
  web_fetch: {
    required: ["one of: query | urls | useStoredUrls=true"],
    bounds: [
      "query length <= 400",
      "urls <= 30",
      "maxResults <= 15",
      "maxPages <= 25",
      "browseConcurrency <= 6"
    ],
    exampleInput: {
      query: "AI news March 2026 Reuters OpenAI Anthropic",
      maxPages: 10,
      browseConcurrency: 3
    }
  },
  writer_agent: {
    required: ["instruction"],
    bounds: ["instruction length <= 3000", "maxWords between 80 and 3000", "contextPaths <= 8"],
    exampleInput: {
      instruction: "Write an 800-1000 word blog post with citations from fetched sources.",
      format: "blog_post",
      maxWords: 950,
      outputPath: "workspace/alfred/artifacts/blog_test/latest.md"
    }
  },
  file_write: {
    required: ["path", "content"],
    bounds: ["path must resolve inside project root"],
    exampleInput: {
      path: "workspace/alfred/artifacts/notes.md",
      content: "# Notes\n\nDraft content"
    }
  },
  file_read: {
    required: ["path"],
    bounds: ["path must resolve inside project root"],
    exampleInput: {
      path: "README.md"
    }
  },
  file_edit: {
    required: ["path", "find", "replace"],
    bounds: ["path must resolve inside project root"],
    exampleInput: {
      path: "docs/spec.md",
      find: "old phrase",
      replace: "new phrase"
    }
  },
  doc_qa: {
    required: ["question"],
    bounds: ["scopePaths <= 8"],
    exampleInput: {
      question: "What does the lead pipeline do?",
      scopePaths: ["docs", "src/tools/lead"]
    }
  },
  run_diagnostics: {
    required: ["one of: runId | debugPath (optional if current run context is enough)"],
    bounds: [],
    exampleInput: {
      runId: "00000000-0000-0000-0000-000000000000"
    }
  },
  search_status: {
    required: [],
    bounds: [],
    exampleInput: {}
  },
  recover_search: {
    required: [],
    bounds: [],
    exampleInput: {}
  }
};

export function getToolInputContract(toolName: string): ToolInputContract {
  return CONTRACT_MAP[toolName] ?? DEFAULT_TOOL_CONTRACT;
}
