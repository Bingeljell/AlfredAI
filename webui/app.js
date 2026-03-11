const CHAT_RUN_CAP = 24;
const TELEMETRY_EVENT_CAP = 400;
const RAW_VIEW_CAP = 120_000;
const POLL_INTERVAL_MS = 4_000;
const PROVIDER_REFRESH_MS = 60_000;

const VIEW_META = {
  workspace: {
    kicker: "Workspace",
    title: "Alfred Workspace",
    subtitle: "Run Alfred, review outputs, and continue the same conversation without losing the thread."
  },
  telemetry: {
    kicker: "Telemetry",
    title: "Run Telemetry",
    subtitle: "Browse sessions, inspect runs, and export exactly what Alfred saw during execution."
  },
  status: {
    kicker: "Status",
    title: "Runtime Status",
    subtitle: "Search health, session activity, and the current state of Alfred's operating surface."
  },
  settings: {
    kicker: "Settings",
    title: "Settings",
    subtitle: "Read-only for now. This page will become the browser control plane for tools, skills, and providers."
  }
};

const state = {
  view: "workspace",
  activeSessionId: null,
  activeRunId: null,
  sessions: [],
  sessionRuns: [],
  activeRunPayload: null,
  providerStatus: null,
  telemetryMode: "formatted",
  runPollTimer: null,
  providerTimer: null,
  isSending: false,
  notice: "",
  telemetryFilter: ""
};

const els = {
  navList: document.getElementById("nav-list"),
  pageKicker: document.getElementById("page-kicker"),
  pageTitle: document.getElementById("page-title"),
  pageSubtitle: document.getElementById("page-subtitle"),
  activeSessionBadge: document.getElementById("active-session-badge"),
  activeRunBadge: document.getElementById("active-run-badge"),
  sessionName: document.getElementById("session-name"),
  createSession: document.getElementById("create-session"),
  refreshSessions: document.getElementById("refresh-sessions"),
  resetContext: document.getElementById("reset-context"),
  sessionList: document.getElementById("session-list"),
  providerStatus: document.getElementById("provider-status"),
  workspaceRefresh: document.getElementById("workspace-refresh"),
  openTelemetry: document.getElementById("open-telemetry"),
  workspaceSummary: document.getElementById("workspace-summary"),
  chatHistory: document.getElementById("chat-history"),
  message: document.getElementById("message"),
  requestJob: document.getElementById("request-job"),
  clearMessage: document.getElementById("clear-message"),
  send: document.getElementById("send"),
  telemetryRuns: document.getElementById("telemetry-runs"),
  telemetryFilter: document.getElementById("telemetry-filter"),
  refreshRuns: document.getElementById("refresh-runs"),
  telemetryFormat: document.getElementById("telemetry-format"),
  telemetryRaw: document.getElementById("telemetry-raw"),
  telemetryExport: document.getElementById("telemetry-export"),
  telemetryMeta: document.getElementById("telemetry-meta"),
  telemetryConsole: document.getElementById("telemetry-console"),
  statusProviderCard: document.getElementById("status-provider-card"),
  statusSessionCard: document.getElementById("status-session-card"),
  settingsUiCard: document.getElementById("settings-ui-card"),
  inspectorRunStatus: document.getElementById("inspector-run-status"),
  livePulse: document.getElementById("live-pulse"),
  thoughtFeed: document.getElementById("thought-feed"),
  toolFeed: document.getElementById("tool-feed"),
  budgetGrid: document.getElementById("budget-grid"),
  runIdInput: document.getElementById("run-id-input"),
  loadRun: document.getElementById("load-run"),
  cancelRun: document.getElementById("cancel-run"),
  exportRun: document.getElementById("export-run"),
  artifactList: document.getElementById("artifact-list"),
  pages: {
    workspace: document.getElementById("workspace-page"),
    telemetry: document.getElementById("telemetry-page"),
    status: document.getElementById("status-page"),
    settings: document.getElementById("settings-page")
  }
};

function setTextIfChanged(element, nextValue) {
  const text = nextValue ?? "";
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

function setHtmlIfChanged(element, nextHtml) {
  const html = nextHtml ?? "";
  if (element.innerHTML !== html) {
    element.innerHTML = html;
  }
}

function pretty(value, maxChars) {
  const text = JSON.stringify(value, null, 2);
  if (!maxChars || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... truncated in browser view (${text.length - maxChars} more chars). Export JSON for full output.`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortId(value) {
  const text = String(value || "");
  return text ? text.slice(0, 8) : "-";
}

function toShortText(value, max = 160) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function formatDateTime(iso) {
  if (!iso) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatRelativeTime(iso) {
  if (!iso) {
    return "-";
  }
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) {
    return "-";
  }
  const deltaSec = Math.round(deltaMs / 1000);
  if (deltaSec < 60) {
    return `${Math.max(deltaSec, 0)}s ago`;
  }
  const deltaMin = Math.round(deltaSec / 60);
  if (deltaMin < 60) {
    return `${deltaMin}m ago`;
  }
  const deltaHr = Math.round(deltaMin / 60);
  if (deltaHr < 24) {
    return `${deltaHr}h ago`;
  }
  return `${Math.round(deltaHr / 24)}d ago`;
}

function formatElapsedMs(value) {
  const ms = Number(value || 0);
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  if (ms < 60_000) {
    return `${Math.round(ms / 1000)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function formatTokenUsage(value) {
  const usage = value || {};
  const total = Number(usage.totalTokens || 0);
  const prompt = Number(usage.promptTokens || 0);
  const completion = Number(usage.completionTokens || 0);
  const calls = Number(usage.callCount || 0);
  return `${total} total | ${prompt} prompt | ${completion} completion | ${calls} calls`;
}

function isTerminalStatus(status) {
  return status === "completed" || status === "cancelled" || status === "failed" || status === "needs_approval";
}

function statusClass(status) {
  return (status || "idle").toLowerCase();
}

function statusLabel(status) {
  return String(status || "idle").replaceAll("_", " ");
}

function metricCard(label, value) {
  return `
    <div class="metric-card">
      <span class="metric-label">${escapeHtml(label)}</span>
      <span class="metric-value">${escapeHtml(value)}</span>
    </div>
  `;
}

function emptyState(text) {
  return `<div class="empty-state">${escapeHtml(text)}</div>`;
}

function getLastEvent(payload, predicate = () => true) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (predicate(events[index])) {
      return events[index];
    }
  }
  return undefined;
}

function getRecentEvents(payload, predicate, limit = 5) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  return events.filter(predicate).slice(-limit);
}

function computeRunElapsed(payload) {
  const heartbeat = getLastEvent(payload, (event) => event.phase === "observe" && event.eventType === "heartbeat");
  if (heartbeat?.payload?.elapsedMs) {
    return Number(heartbeat.payload.elapsedMs);
  }
  const run = payload?.run;
  if (!run?.createdAt || !run?.updatedAt) {
    return 0;
  }
  return Math.max(0, new Date(run.updatedAt).getTime() - new Date(run.createdAt).getTime());
}

function latestProgressMessage(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const reversed = [...events].reverse();
  for (const event of reversed) {
    if (event.phase === "observe" && event.eventType === "heartbeat") {
      return `Still running (${formatElapsedMs(event.payload?.elapsedMs)} elapsed)`;
    }
    if (event.phase === "sub_react_step") {
      return summarizeEvent(event);
    }
    if (event.phase === "thought") {
      return summarizeEvent(event);
    }
  }
  return "Run is in progress...";
}

function summarizeEvent(event) {
  const payload = event.payload || {};

  if (event.phase === "session" && event.eventType === "session_context_loaded") {
    return `loaded session context: active=${payload.hasActiveObjective ? "yes" : "no"}, lastCompleted=${payload.hasLastCompletedRun ? "yes" : "no"}, artifacts=${payload.artifactCount ?? 0}`;
  }

  if (event.phase === "observe" && event.eventType === "heartbeat") {
    return `still running, elapsed ${formatElapsedMs(payload.elapsedMs)}`;
  }

  if (event.phase === "observe" && event.eventType === "llm_usage") {
    return `llm usage delta ${formatTokenUsage({
      ...payload.usageDelta,
      callCount: payload.callCountDelta || 0
    })} via ${payload.source || "unknown"}`;
  }

  if (event.phase === "thought" && event.eventType === "alfred_plan_created") {
    return `alfred plan ${payload.actionType || "unknown"}: ${toShortText(payload.thought, 200) || "no planner thought"}`;
  }

  if (event.phase === "thought" && event.eventType === "agent_plan_created") {
    const thought = toShortText(payload.thought, 200) || "no planner thought";
    const actionType = payload.action?.type || payload.stop?.reason || payload.actionType || "unknown";
    const fallback = payload.usedFallback ? "fallback" : "model";
    return `agent plan (${fallback}) ${actionType}: ${thought}`;
  }

  if (event.phase === "thought" && event.eventType === "agent_delegated") {
    return `delegated ${payload.agentName || "agent"}: ${toShortText(payload.brief, 180)}`;
  }

  if (event.phase === "observe" && event.eventType === "agent_delegation_result") {
    return `delegation result ${payload.agentName || "agent"}: status=${payload.status || "unknown"}, artifacts=${payload.artifactCount ?? 0}`;
  }

  if (event.phase === "thought" && event.eventType === "alfred_completion_evaluated") {
    const intent = payload.shouldRespond ? "respond" : "continue";
    const reason = payload.continueReason || payload.thought || "no note";
    return `completion evaluator -> ${intent} (${Math.round(Number(payload.confidence || 0) * 100)}%): ${toShortText(reason, 180)}`;
  }

  if (event.phase === "observe" && event.eventType === "agent_action_result") {
    return `observe new=${payload.newLeadCount ?? 0} total=${payload.totalLeadCount ?? 0} failedTools=${payload.failedToolCount ?? 0} failures(search=${payload.searchFailureCount ?? 0}, browse=${payload.browseFailureCount ?? 0}, extraction=${payload.extractionFailureCount ?? 0})`;
  }

  if (event.phase === "final" && event.eventType === "agent_stop") {
    const budget = payload.budgetSnapshot || {};
    const budgetText = budget.mode
      ? ` | budget mode=${budget.mode}, time=${Math.round((Number(budget.remainingTimeRatio || 0) * 100))}% left, llm=${Math.round((Number(budget.llmCallRatio || 0) * 100))}% left`
      : "";
    return `agent_stop ${payload.reason || "unknown"}: ${toShortText(payload.explanation, 180)}${budgetText}`;
  }

  if (event.phase === "sub_react_step") {
    const step = payload.step || "unknown";
    const status = payload.status || "n/a";
    if (step === "query_expansion" && status === "completed") {
      const source = payload.usedModelPlan ? "model_plan" : "fallback_plan";
      return `step=${step} status=${status} queryCount=${payload.queryCount ?? "?"} source=${source}`;
    }
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

  if (event.phase === "tool") {
    const detail = payload.toolName || payload.provider || payload.primaryProvider || payload.csvPath || payload.status;
    return `${event.eventType}${detail ? `: ${toShortText(detail, 160)}` : ""}`;
  }

  if (event.phase === "final" && event.eventType === "final_answer") {
    return `final answer ready`;
  }

  if (event.phase === "route" && event.eventType === "session_reset") {
    return `session context cleared`;
  }

  return `${event.phase}:${event.eventType}`;
}

function buildFormattedTelemetry(payload) {
  if (!payload?.run || !Array.isArray(payload.events)) {
    return emptyState("No run selected.");
  }

  return payload.events.slice(-TELEMETRY_EVENT_CAP).map((event) => {
    const detailLines = [];
    if (event.phase === "observe" && event.eventType === "agent_action_result" && Array.isArray(event.payload?.results)) {
      detailLines.push(`resultSummary: ${toShortText(pretty(event.payload.results), 420)}`);
    }
    if (event.phase === "sub_react_step" && event.payload?.step === "extraction") {
      const reasons = Array.isArray(event.payload?.failureReasons) ? event.payload.failureReasons : [];
      if (reasons.length > 0) {
        detailLines.push(`failureReasons: ${reasons.map((item) => toShortText(item, 90)).join(" | ")}`);
      }
    }
    const detailText = detailLines.length > 0 ? `\n${detailLines.join("\n")}` : "";
    return `
      <div class="console-line phase-${escapeHtml(event.phase)}">
        [${escapeHtml(event.timestamp)}] ${escapeHtml(event.phase)}:${escapeHtml(event.eventType)} | ${escapeHtml(summarizeEvent(event))}${escapeHtml(detailText)}
      </div>
    `;
  }).join("");
}

function buildRawTelemetry(payload) {
  return `<pre class="console-raw">${escapeHtml(pretty(payload, RAW_VIEW_CAP))}</pre>`;
}

function renderPageHeader() {
  const meta = VIEW_META[state.view];
  setTextIfChanged(els.pageKicker, meta.kicker);
  setTextIfChanged(els.pageTitle, meta.title);
  setTextIfChanged(els.pageSubtitle, meta.subtitle);

  const session = getActiveSession();
  const run = getSelectedRunRecord();
  setTextIfChanged(els.activeSessionBadge, session ? `${session.name} (${shortId(session.id)})` : "No session");
  setTextIfChanged(els.activeRunBadge, run ? `${statusLabel(run.status)} | ${shortId(run.runId)}` : "No run");
  els.activeRunBadge.className = `status-pill ${statusClass(run?.status)}`;
}

function getActiveSession() {
  return state.sessions.find((session) => session.id === state.activeSessionId) || null;
}

function getSelectedRunRecord() {
  if (state.activeRunPayload?.run?.runId === state.activeRunId) {
    return state.activeRunPayload.run;
  }
  return state.sessionRuns.find((run) => run.runId === state.activeRunId) || null;
}

function renderNav() {
  for (const button of els.navList.querySelectorAll("[data-view]")) {
    button.classList.toggle("active", button.dataset.view === state.view);
  }
  Object.entries(els.pages).forEach(([view, element]) => {
    element.classList.toggle("active", view === state.view);
    element.classList.toggle("hidden", view !== state.view);
  });
}

function renderSessions() {
  if (state.sessions.length === 0) {
    setHtmlIfChanged(els.sessionList, emptyState("Create a session to start talking to Alfred."));
    return;
  }

  const html = state.sessions.map((session) => {
    const active = session.id === state.activeSessionId ? "active" : "";
    const working = session.workingMemory || {};
    const latest = working.lastOutcomeSummary || working.activeObjective || "No recent summary yet.";
    return `
      <button class="session-item ${active}" data-session-id="${escapeHtml(session.id)}">
        <div>
          <strong>${escapeHtml(session.name)}</strong>
        </div>
        <div class="session-meta">
          <span>${escapeHtml(shortId(session.id))}</span>
          <span>${escapeHtml(formatRelativeTime(session.updatedAt))}</span>
        </div>
        <div class="session-summary">${escapeHtml(toShortText(latest, 150))}</div>
      </button>
    `;
  }).join("");
  setHtmlIfChanged(els.sessionList, html);
}

function renderWorkspaceSummary() {
  const session = getActiveSession();
  const run = getSelectedRunRecord();
  const summary = session?.workingMemory || {};
  const headerText = state.notice || summary.sessionSummary || "Alfred keeps bounded session memory here. Follow-up turns can refer to prior outputs without raw transcript stuffing.";
  const cards = [
    metricCard("Active Session", session ? session.name : "None"),
    metricCard("Last Run", run ? shortId(run.runId) : summary.lastRunId ? shortId(summary.lastRunId) : "-"),
    metricCard("Artifacts", String((run?.artifactPaths || summary.lastArtifacts || []).length || 0)),
    metricCard("Chat Cap", `${CHAT_RUN_CAP} runs`)
  ].join("");

  setHtmlIfChanged(els.workspaceSummary, `
    <div class="stacked-copy">
      <p>${escapeHtml(headerText)}</p>
    </div>
    <div class="summary-grid">${cards}</div>
  `);
}

function buildRunAssistantPreview(run) {
  if (state.activeRunPayload?.run?.runId === run.runId && !isTerminalStatus(run.status)) {
    return latestProgressMessage(state.activeRunPayload);
  }
  if (!run.assistantText && !isTerminalStatus(run.status)) {
    return "Run in progress...";
  }
  return run.assistantText || `Run status: ${run.status}`;
}

function renderChatHistory() {
  if (!state.activeSessionId) {
    setHtmlIfChanged(els.chatHistory, emptyState("No session selected."));
    return;
  }

  if (state.sessionRuns.length === 0) {
    setHtmlIfChanged(els.chatHistory, emptyState("No runs yet in this session."));
    return;
  }

  const runs = state.sessionRuns.slice(0, CHAT_RUN_CAP).reverse();
  const html = runs.map((run) => {
    const active = run.runId === state.activeRunId;
    const assistantPreview = buildRunAssistantPreview(run);
    const userMax = active ? 4000 : 1200;
    const assistantMax = active ? 9000 : 3200;
    const artifacts = run.artifactPaths?.length ? `<span>${run.artifactPaths.length} artifacts</span>` : "";
    return `
      <section class="chat-turn ${active ? "active" : ""}" data-run-id="${escapeHtml(run.runId)}">
        <article class="chat-bubble user-bubble">
          <div class="message-role">User</div>
          <div class="message-body user">${escapeHtml(toShortText(run.message, userMax))}</div>
        </article>
        <article class="chat-bubble assistant-bubble">
          <div class="message-role">Alfred</div>
          <div class="message-body assistant">${escapeHtml(toShortText(assistantPreview, assistantMax))}</div>
          <div class="message-meta">
            <span>${escapeHtml(statusLabel(run.status))}</span>
            <span>${escapeHtml(shortId(run.runId))}</span>
            <span>${escapeHtml(formatDateTime(run.updatedAt))}</span>
            <span>${escapeHtml(formatTokenUsage(run.llmUsage || {}))}</span>
            ${artifacts}
          </div>
          <div class="message-actions">
            <button class="ghost-button" data-open-run="${escapeHtml(run.runId)}">Inspect</button>
            <button class="ghost-button" data-export-run="${escapeHtml(run.runId)}">Export JSON</button>
          </div>
        </article>
      </section>
    `;
  }).join("");
  setHtmlIfChanged(els.chatHistory, html);
}

function renderTelemetryRuns() {
  const filter = state.telemetryFilter.trim().toLowerCase();
  const runs = state.sessionRuns.filter((run) => {
    if (!filter) {
      return true;
    }
    return run.runId.toLowerCase().includes(filter) || run.message.toLowerCase().includes(filter);
  });

  if (runs.length === 0) {
    setHtmlIfChanged(els.telemetryRuns, emptyState(filter ? "No runs matched that filter." : "No runs available for this session."));
    return;
  }

  const html = runs.map((run) => {
    const active = run.runId === state.activeRunId ? "active" : "";
    const detail = run.assistantText || `Status ${run.status}`;
    return `
      <button class="run-item ${active}" data-run-id="${escapeHtml(run.runId)}">
        <div><strong>${escapeHtml(toShortText(run.message, 72))}</strong></div>
        <div class="run-meta">
          <span>${escapeHtml(statusLabel(run.status))}</span>
          <span>${escapeHtml(shortId(run.runId))}</span>
          <span>${escapeHtml(formatRelativeTime(run.updatedAt))}</span>
        </div>
        <div class="run-summary">${escapeHtml(toShortText(detail, 140))}</div>
      </button>
    `;
  }).join("");
  setHtmlIfChanged(els.telemetryRuns, html);
}

function renderTelemetry() {
  const payload = state.activeRunPayload;
  const run = payload?.run;

  if (!run) {
    setHtmlIfChanged(els.telemetryMeta, emptyState("Select a run to inspect telemetry."));
    setHtmlIfChanged(els.telemetryConsole, emptyState("No telemetry loaded."));
    return;
  }

  setHtmlIfChanged(els.telemetryMeta, [
    metricCard("Run", shortId(run.runId)),
    metricCard("Status", statusLabel(run.status)),
    metricCard("Events", String(payload.events?.length || 0)),
    metricCard("Tool Calls", String(run.toolCalls?.length || 0)),
    metricCard("Tokens", String(run.llmUsage?.totalTokens || 0)),
    metricCard("Artifacts", String(run.artifactPaths?.length || 0))
  ].join(""));

  setHtmlIfChanged(els.telemetryConsole, state.telemetryMode === "raw" ? buildRawTelemetry(payload) : buildFormattedTelemetry(payload));
  els.telemetryFormat.classList.toggle("active", state.telemetryMode === "formatted");
  els.telemetryRaw.classList.toggle("active", state.telemetryMode === "raw");
}

function renderStatusPage() {
  const status = state.providerStatus;
  const session = getActiveSession();
  const run = getSelectedRunRecord();

  setHtmlIfChanged(els.statusProviderCard, status
    ? `
        <p>Primary healthy: ${escapeHtml(String(status.primaryHealthy))}</p>
        <p>Fallback healthy: ${escapeHtml(String(status.fallbackHealthy))}</p>
        <p>Active default: ${escapeHtml(String(status.activeDefault || "unknown"))}</p>
        <p>Primary provider: ${escapeHtml(String(status.primaryProvider || "unknown"))}</p>
      `
    : `<p>Status not loaded yet.</p>`);

  setHtmlIfChanged(els.statusSessionCard, `
    <p>Total sessions visible: ${escapeHtml(String(state.sessions.length))}</p>
    <p>Selected session: ${escapeHtml(session?.name || "none")}</p>
    <p>Runs in selected session: ${escapeHtml(String(state.sessionRuns.length))}</p>
    <p>Selected run: ${escapeHtml(run ? shortId(run.runId) : "none")}</p>
  `);
}

function renderSettingsPage() {
  setHtmlIfChanged(els.settingsUiCard, `
    <p>Chat run cap: ${CHAT_RUN_CAP}</p>
    <p>Telemetry event cap: ${TELEMETRY_EVENT_CAP}</p>
    <p>Raw JSON browser cap: ${RAW_VIEW_CAP} chars</p>
    <p>Auto-poll interval: ${POLL_INTERVAL_MS}ms</p>
  `);
}

function renderInspector() {
  const payload = state.activeRunPayload;
  const run = payload?.run;
  const latestHeartbeat = getLastEvent(payload, (event) => event.phase === "observe" && event.eventType === "heartbeat");
  const recentThoughts = getRecentEvents(payload, (event) => event.phase === "thought", 6);
  const recentTools = (run?.toolCalls || []).slice(-6).reverse();
  const artifacts = run?.artifactPaths || [];

  setTextIfChanged(els.inspectorRunStatus, run ? statusLabel(run.status) : "idle");
  els.inspectorRunStatus.className = `status-pill ${statusClass(run?.status)}`;

  if (!run) {
    setHtmlIfChanged(els.livePulse, emptyState("Select a run to populate the live right rail."));
    setHtmlIfChanged(els.thoughtFeed, emptyState("No thought events yet."));
    setHtmlIfChanged(els.toolFeed, emptyState("No tool activity yet."));
    setHtmlIfChanged(els.budgetGrid, [
      metricCard("Tokens", "0"),
      metricCard("Elapsed", "0s"),
      metricCard("Tool Calls", "0"),
      metricCard("Artifacts", "0")
    ].join(""));
    setHtmlIfChanged(els.artifactList, emptyState("No artifacts yet."));
    return;
  }

  const pulseText = latestHeartbeat ? summarizeEvent(latestHeartbeat) : latestProgressMessage(payload);
  setHtmlIfChanged(els.livePulse, `
    <p><strong>${escapeHtml(toShortText(run.message, 140))}</strong></p>
    <p>${escapeHtml(pulseText)}</p>
    <p>Updated ${escapeHtml(formatRelativeTime(run.updatedAt))}</p>
  `);

  setHtmlIfChanged(els.thoughtFeed, recentThoughts.length > 0
    ? recentThoughts.reverse().map((event) => `
        <div class="event-item">
          <span class="event-label">${escapeHtml(event.eventType)}</span>
          <div class="event-text">${escapeHtml(summarizeEvent(event))}</div>
        </div>
      `).join("")
    : emptyState("No thought events on this run."));

  setHtmlIfChanged(els.toolFeed, recentTools.length > 0
    ? recentTools.map((call) => `
        <div class="event-item">
          <span class="event-label">${escapeHtml(call.toolName)} | ${escapeHtml(call.status)}</span>
          <div class="event-text">${escapeHtml(`${call.durationMs}ms | ${toShortText(pretty(call.outputRedacted), 130)}`)}</div>
        </div>
      `).join("")
    : emptyState("No tool calls recorded."));

  setHtmlIfChanged(els.budgetGrid, [
    metricCard("Tokens", String(run.llmUsage?.totalTokens || 0)),
    metricCard("Elapsed", formatElapsedMs(computeRunElapsed(payload))),
    metricCard("Tool Calls", String(run.toolCalls?.length || 0)),
    metricCard("Artifacts", String(artifacts.length || 0))
  ].join(""));

  setHtmlIfChanged(els.artifactList, artifacts.length > 0
    ? artifacts.map((artifact) => `<div class="artifact-chip">${escapeHtml(artifact.split("/").pop() || artifact)}</div>`).join("")
    : emptyState("No artifacts on this run."));
}

function renderAll() {
  renderNav();
  renderPageHeader();
  renderSessions();
  if (state.view === "workspace") {
    renderWorkspaceSummary();
    renderChatHistory();
  } else if (state.view === "telemetry") {
    renderTelemetryRuns();
    renderTelemetry();
  } else if (state.view === "status") {
    renderStatusPage();
  } else if (state.view === "settings") {
    renderSettingsPage();
  }
  renderInspector();
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

function patchRunSummary(runRecord) {
  const index = state.sessionRuns.findIndex((run) => run.runId === runRecord.runId);
  if (index >= 0) {
    state.sessionRuns[index] = runRecord;
  } else {
    state.sessionRuns.unshift(runRecord);
  }
  state.sessionRuns.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

async function refreshProviderStatus() {
  try {
    const status = await api("/v1/providers/status");
    state.providerStatus = status;
    const lines = [
      `Primary: ${status.primaryProvider || "unknown"} (${status.primaryHealthy ? "healthy" : "degraded"})`,
      `Fallback: ${status.fallbackHealthy ? "healthy" : "degraded"}`,
      `Default: ${status.activeDefault || "unknown"}`
    ];
    setTextIfChanged(els.providerStatus, lines.join(" | "));
    if (state.view === "status") {
      renderStatusPage();
    }
  } catch (error) {
    setTextIfChanged(els.providerStatus, `Provider status error: ${error.message}`);
  }
}

async function refreshSessions() {
  const payload = await api("/v1/sessions?limit=30");
  state.sessions = payload.sessions || [];
  if (!state.activeSessionId && state.sessions.length > 0) {
    state.activeSessionId = state.sessions[0].id;
  }
  if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0]?.id || null;
  }
  renderSessions();
}

async function refreshSessionRuns(options = {}) {
  const sessionId = options.sessionId || state.activeSessionId;
  if (!sessionId) {
    state.sessionRuns = [];
    renderAll();
    return;
  }

  const payload = await api(`/v1/runs?sessionId=${encodeURIComponent(sessionId)}&limit=40`);
  state.sessionRuns = payload.runs || [];
  if (!state.activeRunId || !state.sessionRuns.some((run) => run.runId === state.activeRunId)) {
    state.activeRunId = state.sessionRuns[0]?.runId || null;
  }
  if (state.activeRunId) {
    els.runIdInput.value = state.activeRunId;
  }
  renderAll();
}

async function loadRun(runId) {
  const payload = await api(`/v1/runs/${runId}`);
  state.activeRunId = runId;
  state.activeRunPayload = payload;
  els.runIdInput.value = runId;
  patchRunSummary(payload.run);
  renderAll();
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
        stopRunPolling();
        await Promise.all([refreshSessions(), refreshSessionRuns()]);
      }
    } catch (error) {
      stopRunPolling();
      state.notice = `Polling error: ${error.message}`;
      renderWorkspaceSummary();
    }
  };

  void tick();
  state.runPollTimer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}

async function exportRun(runId) {
  if (!runId) {
    throw new Error("Run ID required");
  }
  const payload = await api(`/v1/runs/${runId}/export`);
  const blob = new Blob([pretty(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `alfred-run-${runId}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function selectSession(sessionId) {
  if (!sessionId) {
    return;
  }
  state.activeSessionId = sessionId;
  state.activeRunId = null;
  state.activeRunPayload = null;
  stopRunPolling();
  await refreshSessionRuns({ sessionId });
  if (state.activeRunId) {
    await loadRun(state.activeRunId);
    if (!isTerminalStatus(state.activeRunPayload?.run?.status)) {
      startRunPolling(state.activeRunId);
    }
  }
  renderAll();
}

async function sendTurn(message) {
  if (!state.activeSessionId) {
    throw new Error("Create a session first");
  }
  state.isSending = true;
  state.notice = "Submitting turn to Alfred...";
  renderWorkspaceSummary();
  els.send.disabled = true;

  try {
    const payload = await api("/v1/chat/turn", {
      method: "POST",
      body: JSON.stringify({
        sessionId: state.activeSessionId,
        message,
        requestJob: els.requestJob.checked
      })
    });

    state.notice = payload.assistantText || `Run ${payload.runId} started with status ${payload.status}.`;

    if (payload.runId) {
      state.activeRunId = payload.runId;
      els.runIdInput.value = payload.runId;
    }

    await Promise.all([refreshSessions(), refreshSessionRuns()]);

    if (payload.runId) {
      await loadRun(payload.runId);
    }

    if (payload.status === "queued" || payload.status === "running") {
      startRunPolling(payload.runId);
    } else {
      stopRunPolling();
    }

    renderAll();
  } finally {
    state.isSending = false;
    els.send.disabled = false;
  }
}

async function submitComposerTurn() {
  if (state.isSending) {
    return;
  }
  const rawMessage = els.message.value;
  const message = rawMessage.trim();
  if (!message) {
    return;
  }
  els.message.value = "";
  try {
    await sendTurn(message);
  } catch (error) {
    els.message.value = rawMessage;
    throw error;
  }
}

async function createSession() {
  const name = els.sessionName.value.trim();
  const payload = await api("/v1/sessions", {
    method: "POST",
    body: JSON.stringify({ action: "create", name })
  });
  els.sessionName.value = "";
  state.notice = `Created session ${payload.session.name}.`;
  await refreshSessions();
  await selectSession(payload.session.id);
}

async function resetSessionContext() {
  if (!state.activeSessionId) {
    throw new Error("No active session selected.");
  }
  await sendTurn("/newsession");
}

function startProviderRefreshLoop() {
  if (state.providerTimer) {
    clearInterval(state.providerTimer);
  }
  state.providerTimer = setInterval(() => {
    void refreshProviderStatus();
  }, PROVIDER_REFRESH_MS);
}

els.navList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-view]");
  if (!button) {
    return;
  }
  state.view = button.dataset.view;
  renderAll();
  if (state.view === "telemetry" && state.activeRunId && !state.activeRunPayload) {
    await loadRun(state.activeRunId);
  }
});

els.sessionList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-session-id]");
  if (!button) {
    return;
  }
  await selectSession(button.dataset.sessionId);
});

els.chatHistory.addEventListener("click", async (event) => {
  const loadButton = event.target.closest("[data-open-run]");
  const exportButton = event.target.closest("[data-export-run]");
  const card = event.target.closest("[data-run-id]");

  if (exportButton) {
    await exportRun(exportButton.dataset.exportRun);
    return;
  }
  if (loadButton) {
    await loadRun(loadButton.dataset.openRun);
    state.view = "telemetry";
    renderAll();
    return;
  }
  if (card?.dataset.runId) {
    await loadRun(card.dataset.runId);
    if (!isTerminalStatus(state.activeRunPayload?.run?.status)) {
      startRunPolling(card.dataset.runId);
    }
  }
});

els.telemetryRuns.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-run-id]");
  if (!button) {
    return;
  }
  await loadRun(button.dataset.runId);
  if (!isTerminalStatus(state.activeRunPayload?.run?.status)) {
    startRunPolling(button.dataset.runId);
  }
});

els.createSession.addEventListener("click", () => {
  void createSession().catch((error) => {
    state.notice = `Create session failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.refreshSessions.addEventListener("click", () => {
  void Promise.all([refreshSessions(), refreshSessionRuns(), refreshProviderStatus()]).then(renderAll).catch((error) => {
    state.notice = `Refresh failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.resetContext.addEventListener("click", () => {
  void resetSessionContext().catch((error) => {
    state.notice = `Context reset failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.workspaceRefresh.addEventListener("click", () => {
  void Promise.all([refreshSessions(), refreshSessionRuns()]).then(() => {
    if (state.activeRunId) {
      return loadRun(state.activeRunId);
    }
    return undefined;
  }).catch((error) => {
    state.notice = `Workspace refresh failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.openTelemetry.addEventListener("click", () => {
  state.view = "telemetry";
  renderAll();
});

els.clearMessage.addEventListener("click", () => {
  els.message.value = "";
});

els.send.addEventListener("click", () => {
  void submitComposerTurn().catch((error) => {
    state.notice = `Send failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.message.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }
  if (event.metaKey || event.ctrlKey) {
    return;
  }
  event.preventDefault();
  void submitComposerTurn().catch((error) => {
    state.notice = `Send failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.telemetryFilter.addEventListener("input", () => {
  state.telemetryFilter = els.telemetryFilter.value;
  renderTelemetryRuns();
});

els.refreshRuns.addEventListener("click", () => {
  void refreshSessionRuns().then(async () => {
    if (state.activeRunId) {
      await loadRun(state.activeRunId);
    }
  }).catch((error) => {
    state.notice = `Run refresh failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.telemetryFormat.addEventListener("click", () => {
  state.telemetryMode = "formatted";
  renderTelemetry();
});

els.telemetryRaw.addEventListener("click", () => {
  state.telemetryMode = "raw";
  renderTelemetry();
});

els.telemetryExport.addEventListener("click", () => {
  void exportRun(state.activeRunId).catch((error) => {
    state.notice = `Export failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.loadRun.addEventListener("click", () => {
  const runId = els.runIdInput.value.trim();
  if (!runId) {
    return;
  }
  void loadRun(runId).then((payload) => {
    state.view = "telemetry";
    renderAll();
    if (!isTerminalStatus(payload.run.status)) {
      startRunPolling(runId);
    }
  }).catch((error) => {
    state.notice = `Load run failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.cancelRun.addEventListener("click", () => {
  const runId = els.runIdInput.value.trim() || state.activeRunId;
  if (!runId) {
    return;
  }
  void api(`/v1/runs/${runId}/cancel`, {
    method: "POST",
    body: JSON.stringify({})
  }).then(async (payload) => {
    state.notice = payload.message;
    await loadRun(runId);
    if (payload.accepted) {
      startRunPolling(runId);
    }
  }).catch((error) => {
    state.notice = `Cancel failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

els.exportRun.addEventListener("click", () => {
  void exportRun(els.runIdInput.value.trim() || state.activeRunId).catch((error) => {
    state.notice = `Export failed: ${error.message}`;
    renderWorkspaceSummary();
  });
});

async function init() {
  els.requestJob.checked = true;
  await Promise.all([refreshSessions(), refreshProviderStatus()]);
  if (state.activeSessionId) {
    await refreshSessionRuns();
    if (state.activeRunId) {
      const payload = await loadRun(state.activeRunId);
      if (!isTerminalStatus(payload.run.status)) {
        startRunPolling(state.activeRunId);
      }
    }
  }
  startProviderRefreshLoop();
  renderAll();
}

window.addEventListener("beforeunload", () => {
  stopRunPolling();
  if (state.providerTimer) {
    clearInterval(state.providerTimer);
    state.providerTimer = null;
  }
});

void init().catch((error) => {
  state.notice = `Initialization error: ${error.message}`;
  renderAll();
});
