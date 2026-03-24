import type { RunStatus, SessionOutputAvailability, SessionOutputKind, SessionOutputRecord, ToolCallRecord } from "../types.js";

function clipSessionText(value: string | undefined, maxLength: number): string {
  if (!value) {
    return "";
  }
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function deriveSessionOutputKind(args: {
  artifactPath: string | null;
  toolName: string | null;
  format: string | null;
}): SessionOutputKind {
  const artifactPath = args.artifactPath?.toLowerCase() ?? "";
  if (artifactPath.endsWith(".csv")) {
    return "lead_csv";
  }
  if (args.toolName === "writer_agent" || args.toolName === "article_writer") {
    return args.format === "blog_post" ? "article" : "draft";
  }
  if (artifactPath.endsWith(".md") || artifactPath.endsWith(".txt")) {
    return "notes";
  }
  return "generic_output";
}

export function deriveSessionOutputAvailability(args: {
  artifactPath: string | null;
  contentPreview: string;
  isWriterOutput?: boolean;
  draftQuality?: string | null;
  deliverableStatus?: string | null;
  processCommentaryDetected?: boolean;
}): SessionOutputAvailability {
  const hasBody = Boolean(args.artifactPath) || args.contentPreview.length > 0;
  if (args.isWriterOutput !== true) {
    if (args.artifactPath) {
      return "body_available";
    }
    return args.contentPreview.length > 0 ? "metadata_only" : "missing";
  }
  if (args.draftQuality === "complete" || args.deliverableStatus === "complete") {
    return hasBody ? "body_available" : "missing";
  }
  if (args.deliverableStatus === "partial" && args.processCommentaryDetected !== true) {
    return hasBody ? "body_available" : "metadata_only";
  }
  if (hasBody) {
    return "metadata_only";
  }
  return "missing";
}

export function deriveSessionOutputRecordFromRun(args: {
  runId: string;
  message: string;
  runStatus: RunStatus;
  runCreatedAt?: string;
  assistantText?: string;
  artifactPaths?: string[];
  toolCalls?: ToolCallRecord[];
}): SessionOutputRecord | null {
  if (args.runStatus !== "completed") {
    return null;
  }

  const llmUsage = args.toolCalls?.reduce(
    (acc, call) => {
      // Assuming tool output contains usage info if standardized
      if (call.outputRedacted && typeof call.outputRedacted === "object" && "usage" in call.outputRedacted) {
        const usage = (call.outputRedacted as any).usage;
        if (usage) {
          if (typeof usage.promptTokens === "number") acc.promptTokens += usage.promptTokens;
          if (typeof usage.completionTokens === "number") acc.completionTokens += usage.completionTokens;
          if (typeof usage.totalTokens === "number") acc.totalTokens += usage.totalTokens;
          if (typeof usage.cachedTokens === "number") acc.cachedTokens += usage.cachedTokens;
        }
      }
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 }
  );

  const artifactPath = args.artifactPaths?.[0] ?? null;
  const writerToolCall = [...(args.toolCalls ?? [])]
    .reverse()
    .find((call) =>
      call.status === "ok" &&
      (call.toolName === "writer_agent" || call.toolName === "article_writer")
    );
  const writerOutput =
    writerToolCall?.outputRedacted && typeof writerToolCall.outputRedacted === "object"
      ? (writerToolCall.outputRedacted as Record<string, unknown>)
      : null;
  const title =
    (typeof writerOutput?.title === "string" && clipSessionText(writerOutput.title, 160))
    || (artifactPath ? artifactPath.split("/").at(-1) ?? "session-output" : clipSessionText(args.message, 160))
    || "session-output";
  const contentPreview =
    (typeof writerOutput?.content === "string" && clipSessionText(writerOutput.content, 320))
    || clipSessionText(args.assistantText, 320);
  const summary =
    (typeof writerOutput?.summary === "string" && clipSessionText(writerOutput.summary, 220))
    || clipSessionText(args.assistantText, 220)
    || `Completed output for: ${clipSessionText(args.message, 160)}`;
  const format = typeof writerOutput?.format === "string" ? writerOutput.format : null;
  const kind = deriveSessionOutputKind({
    artifactPath,
    toolName: writerToolCall?.toolName ?? null,
    format
  });
  const draftQuality = typeof writerOutput?.draftQuality === "string" ? writerOutput.draftQuality : null;
  const deliverableStatus = typeof writerOutput?.deliverableStatus === "string" ? writerOutput.deliverableStatus : null;
  const processCommentaryDetected = writerOutput?.processCommentaryDetected === true;
  const availability = deriveSessionOutputAvailability({
    artifactPath,
    contentPreview,
    isWriterOutput: Boolean(writerToolCall),
    draftQuality,
    deliverableStatus,
    processCommentaryDetected
  });
  const metadata: Record<string, string | number | boolean | null> = {};
  if (typeof writerOutput?.wordCount === "number") {
    metadata.wordCount = writerOutput.wordCount;
  }
  if (draftQuality) {
    metadata.draftQuality = draftQuality;
  }
  if (deliverableStatus) {
    metadata.deliverableStatus = deliverableStatus;
  }
  if (processCommentaryDetected) {
    metadata.processCommentaryDetected = true;
  }
  if (typeof format === "string") {
    metadata.outputFormat = format;
  }
  if (artifactPath) {
    metadata.primaryArtifactPath = artifactPath;
  }
  if (llmUsage) {
    if (llmUsage.promptTokens > 0) metadata.promptTokens = llmUsage.promptTokens;
    if (llmUsage.completionTokens > 0) metadata.completionTokens = llmUsage.completionTokens;
    if (llmUsage.totalTokens > 0) metadata.totalTokens = llmUsage.totalTokens;
    if (llmUsage.cachedTokens > 0) metadata.cachedTokens = llmUsage.cachedTokens;
  }

  return {
    id: `${args.runId}:${kind}`,
    kind,
    runId: args.runId,
    createdAt: args.runCreatedAt ?? new Date().toISOString(),
    title,
    summary,
    artifactPath: artifactPath ?? undefined,
    contentPreview: contentPreview || undefined,
    availability,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined
  };
}

export function mergeSessionOutputRecords(
  primary: SessionOutputRecord[] | undefined,
  fallback: SessionOutputRecord[] | undefined,
  maxCount = 6
): SessionOutputRecord[] | undefined {
  const ordered: SessionOutputRecord[] = [];
  const seen = new Set<string>();
  for (const output of [...(fallback ?? []), ...(primary ?? [])]) {
    if (seen.has(output.id)) {
      continue;
    }
    seen.add(output.id);
    ordered.push(output);
  }
  if (ordered.length === 0) {
    return undefined;
  }
  return ordered.slice(-Math.max(1, maxCount));
}
