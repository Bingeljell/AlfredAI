import { z } from "zod";
import type { ToolDefinition } from "../types.js";
import { BrowserPool } from "../browser/browserPool.js";

const InputSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  deep: z.boolean().default(true).describe("Whether to search for Contact/About pages if email not found on homepage"),
});

export async function extractLead(
  url: string,
  deep: boolean,
  context: any,
  providedBrowserPool?: BrowserPool
): Promise<Record<string, any>> {
  const browserPool = providedBrowserPool || (await BrowserPool.create());
  
  try {
    // 1. Fetch homepage
    const collection = await browserPool.collectPages([url], 1, context.deadlineAtMs);
    if (collection.pages.length === 0) {
      return { url, error: collection.failures[0]?.error || "Failed to fetch homepage" };
    }

    const homepage = collection.pages[0];
    let combinedContent = `URL: ${url}\nTitle: ${homepage.title}\nContent: ${homepage.text}\n`;
    
    // 2. Simple regex check for initial signal
    const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    const initialEmails = homepage.text.match(emailRegex) || [];

    // 3. Deep search if needed
    if (deep && initialEmails.length === 0) {
      const contactLinks = homepage.outboundLinks
        .map(link => {
          const [text, href] = link.split(" -> ");
          return { text: text.toLowerCase(), href };
        })
        .filter(l => 
          l.text.includes("contact") || 
          l.text.includes("about") || 
          l.text.includes("team") || 
          l.text.includes("staff") ||
          l.text.includes("privacy")
        )
        .slice(0, 2);

      if (contactLinks.length > 0) {
        const deepCollection = await browserPool.collectPages(contactLinks.map(l => l.href), 2, context.deadlineAtMs);
        for (const page of deepCollection.pages) {
          combinedContent += `\n--- Subpage: ${page.url} ---\nContent: ${page.text}\n`;
        }
      }
    }

    const emailRegexFinal = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
    if (!context.llmProviders || context.llmProviders.length === 0) {
      const emails = [...new Set(combinedContent.match(emailRegexFinal) || [])];
      return {
        companyName: homepage.title,
        emails,
        sourceUrl: url,
        warning: "LLM provider not available for deep extraction"
      };
    }

    const llm = context.llmProviders[0];
    const extractionResult = await llm.generateStructured({
      messages: [
        {
          role: "system",
          content: "You are a professional lead researcher. Extract company information from the provided web page content. Focus on finding actual contact emails and determining the company size and industry. If you find multiple emails, prioritize ones that look like real people or general business contact (e.g. hello@, contact@) over technical ones (e.g. dmarc@, abuse@)."
        },
        {
          role: "user",
          content: `Content from ${url} and its subpages:\n\n${combinedContent.slice(0, 15000)}`
        }
      ],
      schemaName: "LeadExtraction",
      jsonSchema: {
        type: "object",
        properties: {
          companyName: { type: "string" },
          contactName: { type: "string" },
          emails: { type: "array", items: { type: "string" } },
          industry: { type: "string" },
          companySize: { type: "string", description: "e.g. 1-10, 11-50, 51-200, 201-500, 500+" },
          description: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["companyName", "emails", "confidence"]
      }
    }, z.object({
      companyName: z.string(),
      contactName: z.string().optional(),
      emails: z.array(z.string()),
      industry: z.string().optional(),
      companySize: z.string().optional(),
      description: z.string().optional(),
      confidence: z.number()
    }));

    if (extractionResult.result) {
      return {
        ...extractionResult.result,
        sourceUrl: url,
        usage: { ...extractionResult.usage, callCount: 1 }
      };
    }

    return {
      companyName: homepage.title,
      emails: [...new Set(combinedContent.match(emailRegexFinal) || [])],
      sourceUrl: url,
      error: extractionResult.failureMessage,
      usage: { ...extractionResult.usage, callCount: 1 }
    };

  } finally {
    if (!providedBrowserPool) {
      await browserPool.close();
    }
  }
}

export const toolDefinition: ToolDefinition<typeof InputSchema> = {
  name: "lead_extractor",
  description: "Deep extract company leads from a website using LLM-based parsing and navigation.",
  inputSchema: InputSchema,
  inputHint: '{"url": "https://example.com", "deep": true}',
  async execute(input, context) {
    return extractLead(input.url, input.deep, context);
  }
};
