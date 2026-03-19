import type { RunOutcome, SessionPromptContext } from "../types.js";
import type { RunStore } from "../runs/runStore.js";

export type TurnRuntimeState = "idle" | "running" | "completed" | "aborted" | "shutdown";

export type TurnOp =
  | {
      type: "UserInput";
      payload: {
        runId: string;
        sessionId: string;
        message: string;
        sessionContext?: SessionPromptContext;
      };
    }
  | {
      type: "Interrupt";
      payload: {
        runId: string;
        sessionId: string;
        reason?: string;
      };
    }
  | {
      type: "Approve";
      payload: {
        runId: string;
        sessionId: string;
        token: string;
      };
    }
  | {
      type: "Reject";
      payload: {
        runId: string;
        sessionId: string;
        token: string;
      };
    }
  | {
      type: "Cancel";
      payload: {
        runId: string;
        sessionId: string;
        reason?: string;
      };
    }
  | {
      type: "Shutdown";
      payload: {
        runId: string;
        sessionId: string;
        reason?: string;
      };
    };

export interface TurnRuntimeDispatchResult {
  accepted: boolean;
  state: TurnRuntimeState;
  reason?: string;
  outcome?: RunOutcome;
}

interface TurnRuntimeOptions {
  runStore: RunStore;
  progressIntervalMs?: number;
  executeUserInput: (payload: {
    runId: string;
    sessionId: string;
    message: string;
    sessionContext?: SessionPromptContext;
  }) => Promise<RunOutcome>;
  requestCancellation: (runId: string) => Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class TurnRuntime {
  private state: TurnRuntimeState = "idle";
  private activeRunId: string | null = null;
  private activeSessionId: string | null = null;
  private activeMessage: string | null = null;

  constructor(private readonly options: TurnRuntimeOptions) {}

  getState(): TurnRuntimeState {
    return this.state;
  }

  async dispatch(op: TurnOp): Promise<TurnRuntimeDispatchResult> {
    if (op.type === "UserInput") {
      return this.handleUserInput(op.payload);
    }
    if (op.type === "Interrupt" || op.type === "Cancel") {
      return this.handleCancelLikeOp(op);
    }
    if (op.type === "Approve" || op.type === "Reject") {
      return this.handleApprovalOp(op);
    }
    return this.handleShutdownOp(op);
  }

  private async emitLifecycleEvent(
    runId: string,
    sessionId: string,
    eventType: "TurnStarted" | "TurnProgress" | "TurnComplete" | "TurnAborted",
    payload: Record<string, unknown>
  ): Promise<void> {
    await this.options.runStore.appendEvent({
      runId,
      sessionId,
      phase: "session",
      eventType,
      payload,
      timestamp: nowIso()
    });
  }

  private async handleUserInput(payload: {
    runId: string;
    sessionId: string;
    message: string;
    sessionContext?: SessionPromptContext;
  }): Promise<TurnRuntimeDispatchResult> {
    if (this.state === "running") {
      return {
        accepted: false,
        state: this.state,
        reason: "turn_already_running"
      };
    }
    if (this.state === "shutdown") {
      return {
        accepted: false,
        state: this.state,
        reason: "runtime_shutdown"
      };
    }

    this.state = "running";
    this.activeRunId = payload.runId;
    this.activeSessionId = payload.sessionId;
    this.activeMessage = payload.message;
    const startedAt = Date.now();
    const progressIntervalMs = this.options.progressIntervalMs ?? 30_000;

    await this.emitLifecycleEvent(payload.runId, payload.sessionId, "TurnStarted", {
      op: "UserInput",
      messagePreview: payload.message.replace(/\s+/g, " ").trim().slice(0, 220),
      startedAt: nowIso()
    });

    const progressTimer = setInterval(() => {
      void this.emitLifecycleEvent(payload.runId, payload.sessionId, "TurnProgress", {
        elapsedMs: Date.now() - startedAt,
        state: this.state
      });
    }, progressIntervalMs);
    progressTimer.unref?.();

    try {
      const outcome = await this.options.executeUserInput(payload);
      const terminalEvent = outcome.status === "failed" || outcome.status === "cancelled" ? "TurnAborted" : "TurnComplete";
      this.state = terminalEvent === "TurnComplete" ? "completed" : "aborted";
      await this.emitLifecycleEvent(payload.runId, payload.sessionId, terminalEvent, {
        status: outcome.status,
        elapsedMs: Date.now() - startedAt
      });
      return {
        accepted: true,
        state: this.state,
        outcome
      };
    } catch (error) {
      this.state = "aborted";
      await this.emitLifecycleEvent(payload.runId, payload.sessionId, "TurnAborted", {
        status: "failed",
        reason: error instanceof Error ? error.message : "turn_runtime_failure",
        elapsedMs: Date.now() - startedAt
      });
      throw error;
    } finally {
      clearInterval(progressTimer);
      this.activeRunId = null;
      this.activeSessionId = null;
      this.activeMessage = null;
      this.state = "idle";
    }
  }

  private async handleCancelLikeOp(op: Extract<TurnOp, { type: "Interrupt" | "Cancel" }>): Promise<TurnRuntimeDispatchResult> {
    const runId = this.activeRunId ?? op.payload.runId;
    const sessionId = this.activeSessionId ?? op.payload.sessionId;
    const reason = op.payload.reason ?? (op.type === "Interrupt" ? "interrupt_requested" : "cancel_requested");
    await this.options.requestCancellation(runId);
    await this.emitLifecycleEvent(runId, sessionId, "TurnAborted", {
      status: "cancel_requested",
      op: op.type,
      reason
    });
    return {
      accepted: true,
      state: this.state,
      reason
    };
  }

  private async handleApprovalOp(op: Extract<TurnOp, { type: "Approve" | "Reject" }>): Promise<TurnRuntimeDispatchResult> {
    await this.options.runStore.appendEvent({
      runId: op.payload.runId,
      sessionId: op.payload.sessionId,
      phase: "approval",
      eventType: op.type === "Approve" ? "turn_approval_accepted" : "turn_approval_rejected",
      payload: {
        token: op.payload.token,
        state: this.state
      },
      timestamp: nowIso()
    });
    return {
      accepted: true,
      state: this.state
    };
  }

  private async handleShutdownOp(op: Extract<TurnOp, { type: "Shutdown" }>): Promise<TurnRuntimeDispatchResult> {
    this.state = "shutdown";
    await this.options.runStore.appendEvent({
      runId: op.payload.runId,
      sessionId: op.payload.sessionId,
      phase: "session",
      eventType: "turn_runtime_shutdown",
      payload: {
        reason: op.payload.reason ?? "shutdown_requested"
      },
      timestamp: nowIso()
    });
    return {
      accepted: true,
      state: this.state,
      reason: op.payload.reason ?? "shutdown_requested"
    };
  }
}
