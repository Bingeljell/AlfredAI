import { readFile } from "node:fs/promises";
import type { RunStore } from "../runs/runStore.js";
import type { SessionOutputRecord, SessionPromptContext } from "../types.js";
import { resolvePathInProject } from "../agent/tools/helpers/pathSafety.js";
import { deriveSessionOutputRecordFromRun, mergeSessionOutputRecords } from "./sessionOutputs.js";

export interface SessionOutputBodyPreview {
  content: string;
  truncated: boolean;
}

export async function recoverDurableSessionOutputs(args: {
  runStore: RunStore;
  sessionId: string;
  excludeRunId?: string;
  limit?: number;
}): Promise<SessionOutputRecord[]> {
  const targetLimit = Math.max(1, args.limit ?? 6);
  const runs = await args.runStore.listRuns(args.sessionId, Math.max(targetLimit * 4, targetLimit + 4));
  const recovered: SessionOutputRecord[] = [];
  const seen = new Set<string>();

  for (const run of runs) {
    if (run.runId === args.excludeRunId) {
      continue;
    }
    const output = deriveSessionOutputRecordFromRun({
      runId: run.runId,
      message: run.message,
      runStatus: run.status,
      runCreatedAt: run.createdAt,
      assistantText: run.assistantText,
      artifactPaths: run.artifactPaths,
      toolCalls: run.toolCalls
    });
    if (!output || seen.has(output.id)) {
      continue;
    }
    seen.add(output.id);
    recovered.push(output);
    if (recovered.length >= targetLimit) {
      break;
    }
  }

  return recovered.reverse();
}

export async function buildRuntimeSessionContext(args: {
  sessionContext?: SessionPromptContext;
  runStore: RunStore;
  sessionId: string;
  excludeRunId?: string;
  recentOutputLimit?: number;
}): Promise<{
  sessionContext?: SessionPromptContext;
  recoveredOutputs: SessionOutputRecord[];
}> {
  const recoveredOutputs = await recoverDurableSessionOutputs({
    runStore: args.runStore,
    sessionId: args.sessionId,
    excludeRunId: args.excludeRunId,
    limit: args.recentOutputLimit ?? 6
  });
  if (!args.sessionContext && recoveredOutputs.length === 0) {
    return {
      sessionContext: args.sessionContext,
      recoveredOutputs
    };
  }

  const mergedRecentOutputs = mergeSessionOutputRecords(
    args.sessionContext?.recentOutputs,
    recoveredOutputs,
    args.recentOutputLimit ?? 6
  );

  return {
    sessionContext: {
      ...(args.sessionContext ?? {}),
      recentOutputs: mergedRecentOutputs
    },
    recoveredOutputs
  };
}

export async function loadSessionOutputBodyPreview(args: {
  workspaceDir: string;
  output: SessionOutputRecord | null | undefined;
  maxChars?: number;
}): Promise<SessionOutputBodyPreview | null> {
  if (!args.output?.artifactPath || args.output.availability !== "body_available") {
    return null;
  }

  try {
    const absolute = resolvePathInProject(args.workspaceDir, args.output.artifactPath);
    const raw = await readFile(absolute, "utf8");
    if (raw.includes("\u0000")) {
      return null;
    }
    const maxChars = Math.max(500, args.maxChars ?? 6_000);
    return {
      content: raw.slice(0, maxChars),
      truncated: raw.length > maxChars
    };
  } catch {
    return null;
  }
}
