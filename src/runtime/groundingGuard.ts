export type GroundedActionCategory = "search" | "web_fetch" | "file_read" | "file_write" | "command" | "browser_action";

export interface GroundingViolation {
  category: GroundedActionCategory;
  claim: string;
  requiredTools: string[];
}

interface ActionRule {
  category: GroundedActionCategory;
  pattern: RegExp;
  requiredTools: string[];
}

const ACTION_RULES: ActionRule[] = [
  {
    category: "search",
    pattern: /\b(?:(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:searched|looked\s+up|queried)|(?:searxng|search)\s+(?:returned|found|gave\s+(?:me|us))|(?:done\s*[-—:]?\s*)?(?:straight|directly)\s+from\s+searxng)\b/i,
    requiredTools: ["search", "pinchtab_search"]
  },
  {
    category: "web_fetch",
    pattern: /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:fetched|browsed|opened|visited|navigated\s+to)\s+(?:the\s+)?(?:https?:\/\/\S+|web(?:site|page)?|site|page|url|link)\b/i,
    requiredTools: ["web_fetch", "pinchtab_fetch", "browser_navigate"]
  },
  {
    category: "file_read",
    pattern: /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:read|inspected|reviewed|checked)\s+(?:the\s+|this\s+|your\s+)?(?:repo(?:sitory)?|code(?:base)?|source|file|files|document|docs?)\b/i,
    requiredTools: ["file_read", "file_list", "code_discover"]
  },
  {
    category: "file_write",
    pattern: /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:wrote|created|saved|updated|edited|modified)\s+(?:the\s+|this\s+|your\s+|an?\s+)?(?:file|files|document|docs?|artifact|code|source|config(?:uration)?|readme)\b/i,
    requiredTools: ["file_write", "file_edit", "writer_agent"]
  },
  {
    category: "command",
    pattern: /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:ran|executed)\s+(?:the\s+|an?\s+)?(?:tests?|commands?|scripts?|build|checks?|type-?check|pnpm|npm|git|node|python)\b|\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:committed|pushed)\b/i,
    requiredTools: ["shell_exec", "herdr_control"]
  },
  {
    category: "browser_action",
    pattern: /\b(?:i|we)(?:'ve| have)?\s+(?:just\s+)?(?:clicked|typed\s+into|filled\s+(?:in|out)|submitted|took\s+(?:a\s+)?screenshot|opened\s+(?:a\s+)?new\s+tab)\b/i,
    requiredTools: ["browser_click", "browser_type", "browser_nav", "browser_screenshot", "browser_tabs"]
  }
];

function excerpt(text: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, text.lastIndexOf("\n", matchIndex) + 1);
  const nextNewline = text.indexOf("\n", matchIndex + matchLength);
  const end = nextNewline === -1 ? text.length : nextNewline;
  return text.slice(start, end).trim().slice(0, 240);
}

/**
 * Validate only claims about actions Alfred says it completed in this run.
 * This is intentionally not a general-purpose fact checker: it ties a narrow,
 * high-confidence class of claims to successful runtime tool receipts.
 */
export function findUngroundedActionClaims(
  text: string,
  successfulTools: ReadonlySet<string>
): GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  for (const rule of ACTION_RULES) {
    const match = rule.pattern.exec(text);
    if (!match || rule.requiredTools.some((tool) => successfulTools.has(tool))) continue;
    violations.push({
      category: rule.category,
      claim: excerpt(text, match.index, match[0].length),
      requiredTools: [...rule.requiredTools]
    });
  }
  return violations;
}

export function buildGroundingRepairInstruction(
  violations: GroundingViolation[],
  successfulTools: ReadonlySet<string>
): string {
  const requirements = violations
    .map((violation) => `${violation.category} requires one of: ${violation.requiredTools.join(", ")}`)
    .join("; ");
  const receipts = successfulTools.size > 0 ? Array.from(successfulTools).sort().join(", ") : "none";
  return [
    "Grounding correction: your previous draft claimed completed actions without matching successful tool evidence from this run.",
    `Missing evidence: ${requirements}.`,
    `Successful tool receipts in this run: ${receipts}.`,
    "Call the required tool now if it is available and needed. Otherwise answer honestly without saying that you performed or verified that action. Do not repeat the unsupported claim."
  ].join(" ");
}

export function buildGroundingFallback(violations: GroundingViolation[]): string {
  const actions = [...new Set(violations.map((violation) => violation.category.replace("_", " ")))];
  return `I need to correct my previous draft: I did not successfully perform the claimed ${actions.join(" or ")} action${actions.length === 1 ? "" : "s"} in this run, so I cannot present those results as verified.`;
}
