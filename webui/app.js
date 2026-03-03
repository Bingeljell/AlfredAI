const state = {
  activeSessionId: null,
  activeRunId: null,
  sessions: []
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
  exportRun: document.getElementById("export-run"),
  timeline: document.getElementById("timeline")
};

function pretty(obj) {
  return JSON.stringify(obj, null, 2);
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
  els.timeline.textContent = renderTimelineView(payload);
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

  els.assistantOutput.textContent = "Running...";
  const payload = await api("/v1/chat/turn", {
    method: "POST",
    body: JSON.stringify({
      sessionId: state.activeSessionId,
      message,
      requestJob: els.requestJob.checked
    })
  });

  els.runMeta.textContent = `Run ${payload.runId} | status ${payload.status}`;
  els.assistantOutput.textContent = payload.assistantText || "Queued. Open Run Timeline after completion.";
  if (payload.runId) {
    await loadRun(payload.runId);
  }
});

els.loadRun.addEventListener("click", async () => {
  const runId = els.runIdInput.value.trim();
  if (!runId) {
    return;
  }
  await loadRun(runId);
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
