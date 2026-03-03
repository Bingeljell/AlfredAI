import type { RunOutcome } from "../types.js";
import { runReActLoop } from "../core/runReActLoop.js";
import type { SessionStore } from "../memory/sessionStore.js";
import type { RunStore } from "../runs/runStore.js";
import type { SearchManager } from "../tools/search/searchManager.js";
import type { InMemoryQueue } from "../workers/inMemoryQueue.js";
import { getPolicyMode } from "../config/env.js";

interface ChatTurnInput {
  sessionId: string;
  message: string;
  requestJob?: boolean;
}

interface ChatServiceOptions {
  sessionStore: SessionStore;
  runStore: RunStore;
  searchManager: SearchManager;
  queue: InMemoryQueue;
  workspaceDir: string;
  searchMaxResults: number;
  fastScrapeCount: number;
  enablePlaywright: boolean;
  maxSteps: number;
  openAiApiKey?: string;
  subReactMaxPages: number;
  subReactBrowseConcurrency: number;
  subReactBatchSize: number;
  subReactLlmMaxCalls: number;
  subReactMinConfidence: number;
}

export class ChatService {
  constructor(private readonly options: ChatServiceOptions) {}

  private async executeRun(runId: string, sessionId: string, message: string): Promise<RunOutcome> {
    await this.options.runStore.updateRun(runId, { status: "running" });

    try {
      const outcome = await runReActLoop(sessionId, message, runId, {
        runStore: this.options.runStore,
        searchManager: this.options.searchManager,
        workspaceDir: this.options.workspaceDir,
        policyMode: getPolicyMode(),
        searchMaxResults: this.options.searchMaxResults,
        fastScrapeCount: this.options.fastScrapeCount,
        enablePlaywright: this.options.enablePlaywright,
        maxSteps: this.options.maxSteps,
        openAiApiKey: this.options.openAiApiKey,
        subReactMaxPages: this.options.subReactMaxPages,
        subReactBrowseConcurrency: this.options.subReactBrowseConcurrency,
        subReactBatchSize: this.options.subReactBatchSize,
        subReactLlmMaxCalls: this.options.subReactLlmMaxCalls,
        subReactMinConfidence: this.options.subReactMinConfidence
      });

      await this.options.runStore.updateRun(runId, {
        status: outcome.status,
        assistantText: outcome.assistantText,
        artifactPaths: outcome.artifactPaths,
        approvalToken: outcome.approvalToken
      });

      return outcome;
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "Unknown error";
      await this.options.runStore.appendEvent({
        runId,
        sessionId,
        phase: "final",
        eventType: "failed",
        payload: { error: messageText },
        timestamp: new Date().toISOString()
      });

      await this.options.runStore.updateRun(runId, {
        status: "failed",
        assistantText: `Run failed: ${messageText}`
      });

      return {
        status: "failed",
        assistantText: `Run failed: ${messageText}`
      };
    }
  }

  async handleTurn(input: ChatTurnInput): Promise<{
    runId: string;
    status: string;
    assistantText?: string;
    artifactPaths?: string[];
    approvalToken?: string;
  }> {
    const session = await this.options.sessionStore.getSession(input.sessionId);
    if (!session) {
      throw new Error(`Session ${input.sessionId} does not exist`);
    }

    await this.options.sessionStore.touchSession(input.sessionId);
    const run = await this.options.runStore.createRun(input.sessionId, input.message, input.requestJob ? "queued" : "running");

    await this.options.runStore.appendEvent({
      runId: run.runId,
      sessionId: input.sessionId,
      phase: "route",
      eventType: input.requestJob ? "queued" : "inline",
      payload: { requestJob: Boolean(input.requestJob) },
      timestamp: new Date().toISOString()
    });

    if (input.requestJob) {
      this.options.queue.enqueue(async () => {
        await this.executeRun(run.runId, input.sessionId, input.message);
      });

      return {
        runId: run.runId,
        status: "queued"
      };
    }

    const outcome = await this.executeRun(run.runId, input.sessionId, input.message);

    return {
      runId: run.runId,
      status: outcome.status,
      assistantText: outcome.assistantText,
      artifactPaths: outcome.artifactPaths,
      approvalToken: outcome.approvalToken
    };
  }
}
