import test from "node:test";
import assert from "node:assert/strict";
import type { SearchResult } from "../../src/types.js";
import { toolDefinition as leadSearchShortlistTool } from "../../src/agent/tools/definitions/leadSearchShortlist.tool.js";

function buildContext(options?: {
  results?: SearchResult[];
  leadExecutionBrief?: {
    requestedLeadCount: number;
    emailRequired?: boolean;
    objectiveBrief: {
      objectiveSummary: string;
      geography?: string | null;
      companyType?: string | null;
    };
  };
}) {
  let storedUrls: string[] = [];
  const results = options?.results ?? [];
  return {
    runId: "run-1",
    sessionId: "session-1",
    message: "lead shortlist test",
    leadExecutionBrief: options?.leadExecutionBrief,
    deadlineAtMs: Date.now() + 60_000,
    policyMode: "trusted" as const,
    projectRoot: process.cwd(),
    runStore: {} as never,
    searchManager: {
      search: async () => ({
        provider: "brightdata" as const,
        fallbackUsed: true,
        results
      })
    } as never,
    workspaceDir: process.cwd(),
    openAiApiKey: undefined,
    defaults: {
      searchMaxResults: 15,
      subReactMaxPages: 10,
      subReactBrowseConcurrency: 3,
      subReactBatchSize: 4,
      subReactLlmMaxCalls: 6,
      subReactMinConfidence: 0.6
    },
    leadPipelineExecutor: (async () => {
      throw new Error("not used");
    }) as never,
    state: {
      leads: [],
      artifacts: [],
      requestedLeadCount: 0,
      fetchedPages: []
    },
    isCancellationRequested: async () => false,
    addLeads: () => ({ addedCount: 0, totalCount: 0 }),
    addArtifact: () => undefined,
    setFetchedPages: () => undefined,
    getFetchedPages: () => [],
    setShortlistedUrls: (urls: string[]) => {
      storedUrls = urls;
    },
    getShortlistedUrls: () => storedUrls
  };
}

test("lead_search_shortlist prioritizes high-signal pages and drops obvious low-signal links", async () => {
  const results: SearchResult[] = [
    {
      title: "What is MSP staffing?",
      url: "https://www.randstadenterprise.com/solutions/talent-acquisition/msp/what-is-msp/",
      snippet: "Definition of MSP for staffing programs",
      provider: "brightdata",
      rank: 1
    },
    {
      title: "Example MSP - Contact",
      url: "https://examplemsp.com/contact",
      snippet: "US-based managed service provider. Contact us for services.",
      provider: "brightdata",
      rank: 2
    },
    {
      title: "Acme SI Team",
      url: "https://acmesi.com/team",
      snippet: "Systems integrator team and leadership contacts.",
      provider: "brightdata",
      rank: 3
    },
    {
      title: "LinkedIn profile",
      url: "https://www.linkedin.com/in/john-doe",
      snippet: "Personal profile",
      provider: "brightdata",
      rank: 4
    },
    {
      title: "Example MSP About",
      url: "https://examplemsp.com/about",
      snippet: "About our managed IT services company",
      provider: "brightdata",
      rank: 5
    }
  ];
  const context = buildContext({
    results,
    leadExecutionBrief: {
      requestedLeadCount: 12,
      emailRequired: true,
      objectiveBrief: {
        objectiveSummary: "Find MSP leads in USA",
        geography: "USA",
        companyType: "MSP"
      }
    }
  });

  const output = await leadSearchShortlistTool.execute(
    {
      query: "managed service provider usa",
      maxResults: 12,
      maxUrls: 3
    },
    context
  );

  const shortlistedUrls = output.shortlistedUrls as string[];
  assert.equal(output.shortlistedCount, 3);
  assert.equal(shortlistedUrls.length, 3);
  assert.ok(shortlistedUrls.includes("https://examplemsp.com/contact"));
  assert.ok(shortlistedUrls.includes("https://acmesi.com/team"));
  assert.ok(shortlistedUrls.includes("https://examplemsp.com/about"));
  assert.ok(
    (output.shortlistDiagnostics as Array<{ reasons: string[] }>).some((item) => item.reasons.includes("contact_path"))
  );
});

test("lead_search_shortlist boosts geography-aligned candidates", async () => {
  const results: SearchResult[] = [
    {
      title: "US systems integrator contact",
      url: "https://alphasi.com/contact",
      snippet: "Systems integrator contact page",
      provider: "brightdata",
      rank: 1
    },
    {
      title: "Integrateur MSP France contact",
      url: "https://betasi.fr/contact",
      snippet: "MSP France contact email équipe direction",
      provider: "brightdata",
      rank: 2
    }
  ];
  const context = buildContext({
    results,
    leadExecutionBrief: {
      requestedLeadCount: 10,
      emailRequired: true,
      objectiveBrief: {
        objectiveSummary: "Find MSP and SI leads in France",
        geography: "France",
        companyType: "MSP SI"
      }
    }
  });

  const output = await leadSearchShortlistTool.execute(
    {
      query: "msp systems integrator france",
      maxResults: 10,
      maxUrls: 2
    },
    context
  );

  const shortlistedUrls = output.shortlistedUrls as string[];
  assert.equal(shortlistedUrls[0], "https://betasi.fr/contact");
});
