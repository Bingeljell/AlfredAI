const state = {
  activeSessionId: null,
  activeRunId: null,
  sessions: [],
  runPollTimer: null
};

const els = {
  sessionName: document.getElementById("session-name"),
  createSession: document.getElementById("create-session"),
  sessionList: document.getElementById("session-list"),
  providerStatus: document.getElementById("provider-status"),
  message: document.getElementById("message"),
  send: document.getElementById("send"),
  requestJob: document.getElementById("request-job"),
  runMeta: document.getElementById("run-meta"),
  assistantOutput: document.getElementById("assistant-output"),
  runIdInput: document.getElementById("run-id-input"),
  loadRun: document.getElementById("load-run"),
  cancelRun: document.getElementById("cancel-run"),
  exportRun: document.getElementById("export-run"),
  timeline: document.getElementById("timeline")
};

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
}

function isTerminalStatus(status) {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "needs_approval";
}

function formatElapsedMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  return `${Math.round(ms / 1000)}s`;
}

function summarizeEvent(event) {
  const payload = event.payload || {};
  if (event.phase === "observe" && event.eventType === "heartbeat") {
    return `still running, elapsed ${formatElapsedMs(payload.elapsedMs)}`;
  }

  if (event.phase === "sub_react_step") {
    const step = payload.step || "unknown";
    const status = payload.status || "n/a";
    if (step === "browse_batch" && status === "started") {
      return `step=${step} status=${status} queries=${payload.queryCount ?? "?"} urls=${payload.urlCount ?? "?"}`;
    }
    if (step === "browse_batch" && status === "completed") {
      return `step=${step} status=${status} visited=${payload.pagesVisited ?? "?"}/${payload.urlCount ?? "?"}`;
    }
    if (step === "extraction" && status === "completed") {
      return `step=${step} status=${status} batch=${payload.batchIndex ?? "?"}/${payload.totalBatches ?? "?"} extracted=${payload.extractedCount ?? 0}`;
    }
    if (step === "quality_gate" && status === "completed") {
      return `step=${step} status=${status} final=${payload.finalCandidateCount ?? 0} deficit=${payload.deficitCount ?? 0}`;
    }
    return `step=${step} status=${status}`;
  }

  return `${event.phase}:${event.eventType}`;
}

function latestProgressMessage(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const reversed = [...events].reverse();
  for (const event of reversed) {
    if (event.phase === "observe" && event.eventType === "heartbeat") {
      return `Still running (${formatElapsedMs(event.payload?.elapsedMs)} elapsed)`;
    }
    if (event.phase === "sub_react_step") {
      return `Progress: ${summarizeEvent(event)}`;
    }
  }
  return "Run is in progress...";
}

function renderTimelineView(payload) {
  if (!payload || !payload.run || !Array.isArray(payload.events)) {
    return pretty(payload);
  }

  const lines = [];
  lines.push(`Run: ${payload.run.runId}`);
  lines.push(`Status: ${payload.run.status}`);
  lines.push(`Message: ${payload.run.message}`);
  lines.push("");
  lines.push("Timeline:");

  for (const event of payload.events) {
    if (event.phase === "sub_react_step") {
      const step = event.payload?.step || "unknown";
      const status = event.payload?.status || "n/a";
      lines.push(`- [${event.timestamp}] ${event.phase}:${step} (${status})`);
      continue;
    }
    if (event.phase === "observe" && event.eventType === "heartbeat") {
      lines.push(`- [${event.timestamp}] observe:heartbeat (${formatElapsedMs(event.payload?.elapsedMs)} elapsed)`);
      continue;
    }
    lines.push(`- [${event.timestamp}] ${event.phase}:${event.eventType}`);
  }

  lines.push("");
  lines.push("Tool Calls:");
  for (const call of payload.run.toolCalls || []) {
    lines.push(`- ${call.toolName} | ${call.status} | ${call.durationMs}ms`);
  }

  lines.push("");
  lines.push("Raw JSON:");
  lines.push(pretty(payload));
  return lines.join("\n");
}

async function api(path, init = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || "Request failed");
  }
  return body;
}

function renderSessions() {
  els.sessionList.innerHTML = "";
  for (const session of state.sessions) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.textContent = `${session.name} (${session.id.slice(0, 8)})`;
    if (session.id === state.activeSessionId) {
      btn.classList.add("active");
    }
    btn.addEventListener("click", () => {
      state.activeSessionId = session.id;
      renderSessions();
    });
    li.appendChild(btn);
    els.sessionList.appendChild(li);
  }
}

async function refreshSessions() {
  const payload = await api("/v1/sessions");
  state.sessions = payload.sessions;
  if (!state.activeSessionId && state.sessions.length > 0) {
    state.activeSessionId = state.sessions[0].id;
  }
  renderSessions();
}

async function refreshProviderStatus() {
  const status = await api("/v1/providers/status");
  els.providerStatus.textContent = `Primary healthy: ${status.primaryHealthy} | Fallback healthy: ${status.fallbackHealthy} | Default: ${status.activeDefault}`;
}

async function loadRun(runId) {
  const payload = await api(`/v1/runs/${runId}`);
  state.activeRunId = runId;
  els.runIdInput.value = runId;
  els.runMeta.textContent = `Run ${payload.run.runId} | status ${payload.run.status}`;
  els.timeline.textContent = renderTimelineView(payload);
  return payload;
}

function stopRunPolling() {
  if (state.runPollTimer) {
    clearInterval(state.runPollTimer);
    state.runPollTimer = null;
  }
}

function startRunPolling(runId) {
  stopRunPolling();

  const tick = async () => {
    try {
      const payload = await loadRun(runId);
      if (isTerminalStatus(payload.run.status)) {
        els.assistantOutput.textContent =
          payload.run.assistantText || `Run finished with status ${payload.run.status}.`;
        stopRunPolling();
        return;
      }
      els.assistantOutput.textContent = latestProgressMessage(payload);
    } catch (error) {
      stopRunPolling();
      els.assistantOutput.textContent = `Polling error: ${error.message}`;
    }
  };

  void tick();
  state.runPollTimer = setInterval(() => {
    void tick();
  }, 2000);
}

els.createSession.addEventListener("click", async () => {
  const name = els.sessionName.value.trim();
  const payload = await api("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ action: "create", name })
  });
  state.activeSessionId = payload.session.id;
  els.sessionName.value = "";
  await refreshSessions();
});

els.send.addEventListener("click", async () => {
  if (!state.activeSessionId) {
    alert("Create a session first");
    return;
  }

  const message = els.message.value.trim();
  if (!message) {
    return;
  }

  stopRunPolling();
  els.assistantOutput.textContent = "Starting run...";
  const payload = await api("/v1/chat/turn", {
    method: "POST",
    body: JSON.stringify({
      sessionId: state.activeSessionId,
      message,
      requestJob: els.requestJob.checked
    })
  });

  els.runMeta.textContent = `Run ${payload.runId} | status ${payload.status}`;
  if (payload.runId) {
    state.activeRunId = payload.runId;
    els.runIdInput.value = payload.runId;
  }

  if (payload.status === "queued" || payload.status === "running") {
    els.assistantOutput.textContent = "Run queued. Loading live progress...";
    if (payload.runId) {
      startRunPolling(payload.runId);
    }
    return;
  }

  els.assistantOutput.textContent = payload.assistantText || "Run finished.";
  if (payload.runId) {
    await loadRun(payload.runId);
  }
});

els.loadRun.addEventListener("click", async () => {
  const runId = els.runIdInput.value.trim();
  if (!runId) {
    return;
  }
  const payload = await loadRun(runId);
  if (!isTerminalStatus(payload.run.status)) {
    startRunPolling(runId);
  }
});

els.cancelRun.addEventListener("click", async () => {
  const runId = els.runIdInput.value.trim() || state.activeRunId;
  if (!runId) {
    alert("Run ID required");
    return;
  }

  const payload = await api(`/v1/runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify({})
  });

  els.assistantOutput.textContent = payload.message;
  await loadRun(runId);
  if (payload.accepted) {
    startRunPolling(runId);
  }
});

els.exportRun.addEventListener("click", async () => {
  const runId = els.runIdInput.value.trim() || state.activeRunId;
  if (!runId) {
    alert("Run ID required");
    return;
  }
  const payload = await api(`/v1/runs/${runId}/export`);
  const blob = new Blob([pretty(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `alfred-run-${runId}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

Promise.all([refreshSessions(), refreshProviderStatus()]).catch((error) => {
  els.assistantOutput.textContent = `Initialization error: ${error.message}`;
});

window.addEventListener("beforeunload", () => {
  stopRunPolling();
});

els.requestJob.checked = true;
