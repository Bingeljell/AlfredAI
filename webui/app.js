const CHAT_RUN_CAP = 24;
const TELEMETRY_EVENT_CAP = 400;
const RAW_VIEW_CAP = 120_000;
const POLL_INTERVAL_MS = 4_000;
const PROVIDER_REFRESH_MS = 60_000;
const CHAT_THINKING_LINE_COUNT = 16;
const CHAT_THINKING_THROTTLE_MS = 1_500;

const state = {
  activeSessionId: null,
  activeRunId: null,
  sessions: [],
  sessionRuns: [],
  activeRunPayload: null,
  providerStatus: null,
  llmStatus: null,
  channelSessionMap: {},
  drawerOpen: false,
  drawerTab: 'inspector',
  telemetryMode: 'formatted',
  runPollTimer: null,
  providerTimer: null,
  isSending: false,
  telemetryFilter: '',
  thinkingCache: new Map()
};

const els = {
  brandOrb: document.getElementById('brand-orb'),
  sessionList: document.getElementById('session-list'),
  newSessionBtn: document.getElementById('new-session-btn'),
  navDebug: document.getElementById('nav-debug'),
  navSettings: document.getElementById('nav-settings'),
  activeSessionName: document.getElementById('active-session-name'),
  channelBadge: document.getElementById('channel-badge'),
  runStatusPill: document.getElementById('run-status-pill'),
  resetCtxBtn: document.getElementById('reset-ctx-btn'),
  debugOpenBtn: document.getElementById('debug-open-btn'),
  chatHistory: document.getElementById('chat-history'),
  artifactsStrip: document.getElementById('artifacts-strip'),
  artifactChips: document.getElementById('artifact-chips'),
  exportCurrentRun: document.getElementById('export-current-run'),
  message: document.getElementById('message'),
  send: document.getElementById('send'),
  debugDrawer: document.getElementById('debug-drawer'),
  debugCloseBtn: document.getElementById('debug-close-btn'),
  drawerTabs: document.getElementById('drawer-tabs'),
  dpaneInspector: document.getElementById('dpane-inspector'),
  dpaneTelemetry: document.getElementById('dpane-telemetry'),
  dpaneStatus: document.getElementById('dpane-status'),
  dpaneSettings: document.getElementById('dpane-settings'),
  inspectorRunStatus: document.getElementById('inspector-run-status'),
  livePulse: document.getElementById('live-pulse'),
  thoughtFeed: document.getElementById('thought-feed'),
  toolFeed: document.getElementById('tool-feed'),
  budgetGrid: document.getElementById('budget-grid'),
  runIdInput: document.getElementById('run-id-input'),
  loadRun: document.getElementById('load-run'),
  cancelRun: document.getElementById('cancel-run'),
  exportRun: document.getElementById('export-run'),
  telemetryFilter: document.getElementById('telemetry-filter'),
  refreshRuns: document.getElementById('refresh-runs'),
  telemetryRuns: document.getElementById('telemetry-runs'),
  telemetryFormat: document.getElementById('telemetry-format'),
  telemetryRaw: document.getElementById('telemetry-raw'),
  telemetryExport: document.getElementById('telemetry-export'),
  telemetryMeta: document.getElementById('telemetry-meta'),
  telemetryConsole: document.getElementById('telemetry-console'),
  sessionTokensBadge: document.getElementById('session-tokens-badge'),
  statusLlmCard: document.getElementById('status-llm-card'),
  statusProviderCard: document.getElementById('status-provider-card'),
  statusSessionCard: document.getElementById('status-session-card'),
  statusChannelCard: document.getElementById('status-channel-card'),
  settingsUiCard: document.getElementById('settings-ui-card'),
  modalBackdrop: document.getElementById('modal-backdrop'),
  sessionName: document.getElementById('session-name'),
  modalCancel: document.getElementById('modal-cancel'),
  modalConfirm: document.getElementById('modal-confirm')
};

// ── Utility helpers ──────────────────────────────────────────────

function setTextIfChanged(element, nextValue) {
  const text = nextValue ?? '';
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

function setHtmlIfChanged(element, nextHtml) {
  const html = nextHtml ?? '';
  if (element.innerHTML !== html) {
    element.innerHTML = html;
  }
}

function hasActiveTextSelectionWithin(container) {
  const selection = window.getSelection?.();
  if (!selection || selection.isCollapsed) {
    return false;
  }
  const text = selection.toString().trim();
  if (!text) {
    return false;
  }
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  const anchorElement = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
  const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement;
  return Boolean(
    (anchorElement && container.contains(anchorElement))
    || (focusElement && container.contains(focusElement))
  );
}

function pretty(value, maxChars) {
  const text = JSON.stringify(value, null, 2);
  if (!maxChars || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... truncated in browser view (${text.length - maxChars} more chars). Export JSON for full output.`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function shortId(value) {
  const text = String(value || '');
  return text ? text.slice(0, 8) : '-';
}

function toShortText(value, max = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function truncatePreserveLayout(value, max = 3200) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

function formatDateTime(iso) {
  if (!iso) {
    return '-';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return '-';
  }
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function formatRelativeTime(iso) {
  if (!iso) {
    return '-';
  }
  const deltaMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(deltaMs)) {
    return '-';
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
    return '0s';
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
  return status === 'completed' || status === 'cancelled' || status === 'failed' || status === 'needs_approval';
}

function statusClass(status) {
  return (status || 'idle').toLowerCase();
}

function statusLabel(status) {
  return String(status || 'idle').replaceAll('_', ' ');
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
  const heartbeat = getLastEvent(payload, (event) => event.phase === 'observe' && event.eventType === 'heartbeat');
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
    if ((event.phase === 'thought') || (event.phase === 'observe' && event.eventType === 'heartbeat')) {
      const line = distillThoughtForChat(event);
      if (line) {
        return line;
      }
    }
    if (event.phase === 'sub_react_step' && event.payload) {
      const step = event.payload.step || '';
      const status = event.payload.status || '';
      if (step === 'browse_batch' && status === 'started') {
        return 'Browsing shortlisted pages for evidence.';
      }
      if (step === 'extraction' && status === 'completed') {
        return 'Extracted candidate leads from fetched content.';
      }
      if (step === 'quality_gate' && status === 'completed') {
        return 'Scoring and filtering candidates against your request.';
      }
    }
  }
  return 'Alfred is working on your request...';
}

function mapPlanAdjustmentReason(reason) {
  switch (reason) {
    case 'phase_lock_forced_transition_discovery_to_fetch':
      return 'Switching from search discovery to page fetch.';
    case 'phase_lock_forced_transition_fetch_to_synthesis':
      return 'Switching from fetch to drafting.';
    case 'diagnostic_thrash_guard':
      return 'Moving past repeated health checks to real retrieval.';
    case 'schema_recovery_forced':
      return 'Repairing tool input before retrying.';
    case 'single_action_input_defaulted':
      return 'Applying safe default tool input to keep progress moving.';
    case 'single_action_input_repaired':
      return 'Repaired malformed tool input before execution.';
    case 'flaky_search_retry_profile':
      return 'Narrowing search fan-out due flaky responses.';
    default:
      return '';
  }
}

function compactJson(value, max = 140) {
  if (value === null || value === undefined) {
    return '';
  }
  try {
    return toShortText(JSON.stringify(value), max);
  } catch {
    return toShortText(String(value), max);
  }
}

function distillThoughtForChat(event) {
  const payload = event.payload || {};
  if (event.phase === 'observe' && event.eventType === 'heartbeat') {
    return `Observe • heartbeat elapsed=${formatElapsedMs(payload.elapsedMs)}`;
  }

  if (event.phase !== 'thought') {
    return '';
  }

  const thought = typeof payload.thought === 'string' ? toShortText(payload.thought, 240) : '';
  const actionType = payload.actionType || '';
  const actionTool =
    payload.singleTool ||
    payload.toolName ||
    payload.delegateAgent ||
    payload.agentName ||
    payload.skill ||
    '';
  if (thought) {
    const actionBits = [actionType, actionTool].filter(Boolean).join(':');
    return actionBits ? `Thought • ${thought} | plan=${actionBits}` : `Thought • ${thought}`;
  }

  if (event.eventType === 'specialist_plan_adjusted') {
    const reason = mapPlanAdjustmentReason(payload.reason) || String(payload.reason || 'plan_adjusted');
    return `Adjust • ${reason}`;
  }
  if (event.eventType === 'alfred_turn_mode_selected') {
    const mode = payload.turnMode || 'execute';
    const permission = payload.executionPermission || 'execute';
    return `State • turn mode=${mode}, permission=${permission}`;
  }
  if (event.eventType === 'alfred_turn_objective_resolved') {
    const source = payload.source || 'message';
    return `State • objective resolved from ${source}`;
  }
  if (event.eventType === 'alfred_objective_contract_created') {
    return 'State • objective contract established for this turn.';
  }
  if (event.eventType === 'alfred_turn_state_updated') {
    const missing = Array.isArray(payload.turnState?.missingRequirements)
      ? payload.turnState.missingRequirements.length
      : 0;
    const blocked = Array.isArray(payload.turnState?.blockingIssues)
      ? payload.turnState.blockingIssues.length
      : 0;
    return `State • requirements missing=${missing}, blocking=${blocked}`;
  }
  if (event.eventType === 'alfred_plan_adjusted') {
    const reason = String(payload.reason || 'plan_adjusted');
    return `Adjust • planner action adjusted (${reason}).`;
  }
  if (event.eventType === 'alfred_completion_contract_blocked') {
    return `Adjust • completion blocked: ${toShortText(payload.reason || 'contract_not_satisfied', 160)}`;
  }
  if (event.eventType === 'intent_identified') {
    return payload.intent ? `Thought • intent=${payload.intent}` : '';
  }
  if (event.eventType === 'specialist_phase_state' || event.eventType === 'specialist_plan_state') {
    const phase = payload.phase || 'unknown';
    const family = payload.expectedToolFamily || 'unspecified';
    return `State • phase=${phase} expected=${family}`;
  }
  if (event.eventType === 'agent_delegated') {
    const skill = payload.agentName || payload.skill || 'unknown';
    return `Action • delegate_agent skill=${skill}`;
  }
  if (event.eventType === 'alfred_completion_evaluated') {
    return `Observe • completion shouldRespond=${String(payload.shouldRespond)} confidence=${Number(payload.confidence || 0).toFixed(2)}`;
  }

  return '';
}

function distillActivityForChat(event) {
  const thoughtLine = distillThoughtForChat(event);
  if (thoughtLine) {
    return thoughtLine;
  }

  const payload = event.payload || {};
  if (event.phase === 'tool' && event.eventType === 'writer_stage') {
    const stage = payload.stage || 'unknown';
    const status = payload.status || 'unknown';
    return `Action • writer ${stage} (${status})`;
  }

  if (event.phase === 'tool') {
    if (event.eventType === 'tool_action_started') {
      return `Action • running ${payload.toolName || 'tool'}...`;
    }
    if (event.eventType === 'tool_action_completed') {
      const toolName = payload.toolName || 'tool';
      const duration = Number(payload.durationMs || 0);
      return `Action • ${toolName} completed (${duration}ms)`;
    }
    if (event.eventType === 'tool_action_failed') {
      const toolName = payload.toolName || 'tool';
      const err = toShortText(payload.error || 'tool failed', 120);
      return `Action • ${toolName} failed (${err})`;
    }
    if (event.eventType === 'tool_action_rejected') {
      return `Action • ${payload.toolName || 'tool'} rejected (approval required)`;
    }
    const detail = payload.toolName || payload.provider || payload.primaryProvider || payload.status || '';
    return detail ? `Action • ${toShortText(detail, 150)}` : '';
  }

  if (event.phase === 'observe' && event.eventType === 'specialist_action_result') {
    const results = Array.isArray(payload.results) ? payload.results : [];
    if (results.length === 0) {
      return 'Observe • specialist_action_result (no results payload)';
    }
    const lines = results.slice(0, 4).map((item) => {
      const durationMs = Number(item.durationMs || 0);
      const input = compactJson(item.input, 90);
      if (item.status === 'ok') {
        return `${item.tool}:ok ${durationMs}ms input=${input || '{}'} output=${compactJson(item.result, 90)}`;
      }
      return `${item.tool}:error ${durationMs}ms input=${input || '{}'} error=${toShortText(item.error, 110)}`;
    });
    return `Observe • ${toShortText(lines.join(' || '), 520)}`;
  }

  if (event.phase === 'observe' && event.eventType === 'agent_delegation_result') {
    const name = payload.agentName || payload.skill || 'specialist agent';
    const status = payload.status || 'unknown';
    const assistantText = toShortText(payload.assistantText, 140);
    return `Observe • delegation ${name} status=${status}${assistantText ? ` summary=${assistantText}` : ''}`;
  }

  if (event.phase === 'observe' && event.eventType === 'agent_action_result') {
    return `Observe • new=${payload.newLeadCount ?? 0} total=${payload.totalLeadCount ?? 0} failedTools=${payload.failedToolCount ?? 0}`;
  }

  if (event.phase === 'final' && event.eventType === 'specialist_stop') {
    return `Stop • specialist reason=${payload.reason || 'unknown'}`;
  }
  if (event.phase === 'final' && event.eventType === 'agent_stop') {
    return `Stop • agent reason=${payload.reason || 'unknown'}`;
  }

  if (event.phase === 'thought') {
    return '';
  }
  const genericPayload = compactJson(payload, 180);
  return genericPayload ? `${event.phase} • ${genericPayload}` : '';
}

function getChatThinkingLines(run) {
  if (!run) {
    return [];
  }
  const payload = state.activeRunPayload;
  if (!payload?.run || payload.run.runId !== run.runId || !Array.isArray(payload.events)) {
    return [];
  }
  const candidateEvents = payload.events.filter((event) =>
    ['thought', 'tool', 'observe', 'final'].includes(event.phase)
  );
  const cache = state.thinkingCache.get(run.runId);
  const now = Date.now();
  if (cache && cache.eventCount === candidateEvents.length && now - cache.updatedAt < CHAT_THINKING_THROTTLE_MS) {
    return cache.lines;
  }

  const formatTimestamp = (iso) => {
    const parsed = new Date(iso);
    if (!Number.isFinite(parsed.getTime())) {
      return '';
    }
    return parsed.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    });
  };
  const lines = candidateEvents
    .map((event) => {
      const distilled = distillActivityForChat(event);
      if (!distilled) {
        return '';
      }
      const time = formatTimestamp(event.timestamp);
      return time ? `[${time}] ${distilled}` : distilled;
    })
    .filter(Boolean)
    .slice(-CHAT_THINKING_LINE_COUNT);
  state.thinkingCache.set(run.runId, {
    eventCount: candidateEvents.length,
    updatedAt: now,
    lines
  });
  return lines;
}

function summarizeEvent(event) {
  const payload = event.payload || {};

  if (event.phase === 'session' && event.eventType === 'session_context_loaded') {
    return `loaded session context: active=${payload.hasActiveObjective ? 'yes' : 'no'}, lastCompleted=${payload.hasLastCompletedRun ? 'yes' : 'no'}, artifacts=${payload.artifactCount ?? 0}`;
  }

  if (event.phase === 'observe' && event.eventType === 'heartbeat') {
    return `still running, elapsed ${formatElapsedMs(payload.elapsedMs)}`;
  }

  if (event.phase === 'observe' && event.eventType === 'llm_usage') {
    return `llm usage delta ${formatTokenUsage({
      ...payload.usageDelta,
      callCount: payload.callCountDelta || 0
    })} via ${payload.source || 'unknown'}`;
  }

  if (event.phase === 'thought' && event.eventType === 'alfred_plan_created') {
    return `alfred plan ${payload.actionType || 'unknown'}: ${toShortText(payload.thought, 200) || 'no planner thought'}`;
  }

  if (event.phase === 'thought' && event.eventType === 'agent_plan_created') {
    const thought = toShortText(payload.thought, 200) || 'no planner thought';
    const actionType = payload.action?.type || payload.stop?.reason || payload.actionType || 'unknown';
    const fallback = payload.usedFallback ? 'fallback' : 'model';
    return `agent plan (${fallback}) ${actionType}: ${thought}`;
  }

  if (event.phase === 'thought' && event.eventType === 'agent_delegated') {
    return `delegated ${payload.agentName || 'agent'}: ${toShortText(payload.brief, 180)}`;
  }

  if (event.phase === 'observe' && event.eventType === 'agent_delegation_result') {
    return `delegation result ${payload.agentName || 'agent'}: status=${payload.status || 'unknown'}, artifacts=${payload.artifactCount ?? 0}`;
  }

  if (event.phase === 'thought' && event.eventType === 'alfred_completion_evaluated') {
    const intent = payload.shouldRespond ? 'respond' : 'continue';
    const reason = payload.continueReason || payload.thought || 'no note';
    return `completion evaluator -> ${intent} (${Math.round(Number(payload.confidence || 0) * 100)}%): ${toShortText(reason, 180)}`;
  }

  if (event.phase === 'observe' && event.eventType === 'agent_action_result') {
    return `observe new=${payload.newLeadCount ?? 0} total=${payload.totalLeadCount ?? 0} failedTools=${payload.failedToolCount ?? 0} failures(search=${payload.searchFailureCount ?? 0}, browse=${payload.browseFailureCount ?? 0}, extraction=${payload.extractionFailureCount ?? 0})`;
  }

  if (event.phase === 'final' && event.eventType === 'agent_stop') {
    const budget = payload.budgetSnapshot || {};
    const budgetText = budget.mode
      ? ` | budget mode=${budget.mode}, time=${Math.round((Number(budget.remainingTimeRatio || 0) * 100))}% left, llm=${Math.round((Number(budget.llmCallRatio || 0) * 100))}% left`
      : '';
    return `agent_stop ${payload.reason || 'unknown'}: ${toShortText(payload.explanation, 180)}${budgetText}`;
  }

  if (event.phase === 'sub_react_step') {
    const step = payload.step || 'unknown';
    const status = payload.status || 'n/a';
    if (step === 'query_expansion' && status === 'completed') {
      const source = payload.usedModelPlan ? 'model_plan' : 'fallback_plan';
      return `step=${step} status=${status} queryCount=${payload.queryCount ?? '?'} source=${source}`;
    }
    if (step === 'browse_batch' && status === 'started') {
      return `step=${step} status=${status} queries=${payload.queryCount ?? '?'} urls=${payload.urlCount ?? '?'}`;
    }
    if (step === 'browse_batch' && status === 'completed') {
      return `step=${step} status=${status} visited=${payload.pagesVisited ?? '?'}/${payload.urlCount ?? '?'}`;
    }
    if (step === 'extraction' && status === 'completed') {
      return `step=${step} status=${status} batch=${payload.batchIndex ?? '?'}/${payload.totalBatches ?? '?'} extracted=${payload.extractedCount ?? 0}`;
    }
    if (step === 'quality_gate' && status === 'completed') {
      return `step=${step} status=${status} final=${payload.finalCandidateCount ?? 0} deficit=${payload.deficitCount ?? 0}`;
    }
    return `step=${step} status=${status}`;
  }

  if (event.phase === 'tool') {
    const detail = payload.toolName || payload.provider || payload.primaryProvider || payload.csvPath || payload.status;
    return `${event.eventType}${detail ? `: ${toShortText(detail, 160)}` : ''}`;
  }

  if (event.phase === 'final' && event.eventType === 'final_answer') {
    return 'final answer ready';
  }

  if (event.phase === 'route' && event.eventType === 'session_reset') {
    return 'session context cleared';
  }

  return `${event.phase}:${event.eventType}`;
}

function buildFormattedTelemetry(payload) {
  if (!payload?.run || !Array.isArray(payload.events)) {
    return emptyState('No run selected.');
  }

  return payload.events.slice(-TELEMETRY_EVENT_CAP).map((event) => {
    const detailLines = [];
    if (event.phase === 'observe' && event.eventType === 'agent_action_result' && Array.isArray(event.payload?.results)) {
      detailLines.push(`resultSummary: ${toShortText(pretty(event.payload.results), 420)}`);
    }
    if (event.phase === 'sub_react_step' && event.payload?.step === 'extraction') {
      const reasons = Array.isArray(event.payload?.failureReasons) ? event.payload.failureReasons : [];
      if (reasons.length > 0) {
        detailLines.push(`failureReasons: ${reasons.map((item) => toShortText(item, 90)).join(' | ')}`);
      }
    }
    const detailText = detailLines.length > 0 ? `\n${detailLines.join('\n')}` : '';
    return `
      <div class="console-line phase-${escapeHtml(event.phase)}">
        [${escapeHtml(event.timestamp)}] ${escapeHtml(event.phase)}:${escapeHtml(event.eventType)} | ${escapeHtml(summarizeEvent(event))}${escapeHtml(detailText)}
      </div>
    `;
  }).join('');
}

function buildRawTelemetry(payload) {
  return `<pre class="console-raw">${escapeHtml(pretty(payload, RAW_VIEW_CAP))}</pre>`;
}

// ── Markdown rendering ───────────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return '';
  if (typeof marked === 'undefined') return `<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`;
  try {
    marked.setOptions({ breaks: true, gfm: true });
    return marked.parse(String(text));
  } catch {
    return `<pre style="white-space:pre-wrap">${escapeHtml(text)}</pre>`;
  }
}

// ── API ──────────────────────────────────────────────────────────

async function api(path, init = {}) {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init
  });
  const body = await res.json();
  if (!res.ok) {
    throw new Error(body.error || 'Request failed');
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

// ── Data fetchers ─────────────────────────────────────────────────

async function refreshProviderStatus() {
  try {
    const status = await api('/v1/providers/status');
    state.providerStatus = status;
    if (state.drawerOpen && state.drawerTab === 'status') {
      renderStatusPage();
    }
  } catch {
    // provider status optional on load
  }
}

async function refreshSessions() {
  const payload = await api('/v1/sessions?limit=30');
  state.sessions = payload.sessions || [];
  if (!state.activeSessionId && state.sessions.length > 0) {
    state.activeSessionId = state.sessions[0].id;
  }
  if (state.activeSessionId && !state.sessions.some((session) => session.id === state.activeSessionId)) {
    state.activeSessionId = state.sessions[0]?.id || null;
  }
  renderSessions();
}

async function refreshChannelSessions() {
  try {
    const data = await api('/v1/channels');
    const map = {};
    for (const [key, record] of Object.entries(data.channelSessions || {})) {
      map[record.sessionId] = { key, label: record.label };
    }
    state.channelSessionMap = map;
  } catch {
    // channel sessions optional - fail silently
  }
}

async function refreshLlmStatus() {
  try {
    state.llmStatus = await api('/v1/llm/status');
    if (state.drawerOpen && state.drawerTab === 'status') {
      renderStatusPage();
    }
  } catch {
    // optional
  }
}

function getSessionTotalTokens() {
  return state.sessionRuns.reduce((sum, run) => sum + (run.llmUsage?.totalTokens ?? 0), 0);
}

function formatTokenCount(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k tok`;
  return `${n} tok`;
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
        setRunningUi(false);
        await Promise.all([refreshSessions(), refreshSessionRuns()]);
      }
    } catch (error) {
      stopRunPolling();
      setRunningUi(false);
    }
  };

  void tick();
  state.runPollTimer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS);
}

async function exportRun(runId) {
  if (!runId) {
    throw new Error('Run ID required');
  }
  const payload = await api(`/v1/runs/${runId}/export`);
  const blob = new Blob([pretty(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
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

// ── Running UI state ─────────────────────────────────────────────

function setRunningUi(running) {
  if (running) {
    els.send.classList.add('running');
    els.send.disabled = true;
    els.brandOrb.classList.add('active');
  } else {
    els.send.classList.remove('running');
    els.send.disabled = false;
    els.brandOrb.classList.remove('active');
  }
}

// ── Send turn ────────────────────────────────────────────────────

async function sendTurn(message) {
  if (!state.activeSessionId) {
    throw new Error('Create a session first');
  }
  state.isSending = true;
  setRunningUi(true);

  try {
    const payload = await api('/v1/chat/turn', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: state.activeSessionId,
        message,
        requestJob: true
      })
    });

    if (payload.runId) {
      state.activeRunId = payload.runId;
      els.runIdInput.value = payload.runId;
    }

    await Promise.all([refreshSessions(), refreshSessionRuns()]);

    if (payload.runId) {
      await loadRun(payload.runId);
    }

    if (payload.status === 'queued' || payload.status === 'running') {
      startRunPolling(payload.runId);
    } else {
      stopRunPolling();
      setRunningUi(false);
    }

    renderAll();
  } finally {
    state.isSending = false;
    if (!state.runPollTimer) {
      setRunningUi(false);
    }
  }
}

// ── Web UI command handling ──────────────────────────────────────

const WEB_HELP_TEXT = `**Alfred web commands**

\`/help\` — show this message
\`/status\` — current session info and token usage
\`/newsession\` — start a fresh session (opens the new session modal)
\`/label <text>\` — note: labels are a Telegram concept; use session names here instead

Any other message is sent to Alfred as a task.`;

function injectCommandResponse(text) {
  // Remove empty state placeholder if present
  const empty = els.chatHistory.querySelector('.empty-state');
  if (empty) empty.remove();

  const article = document.createElement('article');
  article.className = 'chat-bubble system-bubble';
  article.innerHTML = `
    <div class="message-role">System</div>
    <div class="md-body">${renderMarkdown(text)}</div>
  `;
  els.chatHistory.appendChild(article);
  els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

function handleWebCommand(message) {
  const lower = message.toLowerCase();

  if (lower === '/help' || lower.startsWith('/help ')) {
    injectCommandResponse(WEB_HELP_TEXT);
    return true;
  }

  if (lower === '/status') {
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    const channelInfo = state.channelSessionMap[state.activeSessionId];
    const tokens = getSessionTotalTokens();
    const lines = [
      `**Session:** \`${state.activeSessionId ?? 'none'}\``,
      session?.name ? `**Name:** ${session.name}` : null,
      channelInfo ? `**Channel:** Telegram (${channelInfo.key})${channelInfo.label ? ` — ${channelInfo.label}` : ''}` : null,
      `**Runs this session:** ${state.sessionRuns.length}`,
      `**Tokens used:** ${formatTokenCount(tokens) || '0'}`,
      state.llmStatus ? `**Model:** ${state.llmStatus.provider} — fast: ${state.llmStatus.modelFast}, smart: ${state.llmStatus.modelSmart}` : null,
    ].filter(Boolean).join('\n');
    injectCommandResponse(lines);
    return true;
  }

  if (lower === '/newsession' || lower.startsWith('/newsession ')) {
    els.modalBackdrop.classList.remove('hidden');
    return true;
  }

  if (lower.startsWith('/label')) {
    injectCommandResponse('Labels are a Telegram feature. To name this session, use the **+ New session** button or rename it from the sidebar.');
    return true;
  }

  // Unknown slash command — let Alfred handle it as a message
  return false;
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
  els.message.value = '';

  if (message.startsWith('/') && handleWebCommand(message)) {
    return;
  }

  try {
    await sendTurn(message);
  } catch (error) {
    els.message.value = rawMessage;
    throw error;
  }
}

async function createSession() {
  const name = els.sessionName.value.trim();
  const payload = await api('/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ action: 'create', name })
  });
  els.sessionName.value = '';
  await refreshSessions();
  await selectSession(payload.session.id);
}

async function resetSessionContext() {
  if (!state.activeSessionId) {
    throw new Error('No active session selected.');
  }
  await sendTurn('/newsession');
}

function startProviderRefreshLoop() {
  if (state.providerTimer) {
    clearInterval(state.providerTimer);
  }
  state.providerTimer = setInterval(() => {
    void refreshProviderStatus();
  }, PROVIDER_REFRESH_MS);
}

// ── Drawer controls ──────────────────────────────────────────────

function toggleDrawer(open) {
  state.drawerOpen = open;
  els.debugDrawer.classList.toggle('open', open);
}

function setDrawerTab(tab) {
  state.drawerTab = tab;
  for (const btn of els.drawerTabs.querySelectorAll('[data-tab]')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  const panes = {
    inspector: els.dpaneInspector,
    telemetry: els.dpaneTelemetry,
    status: els.dpaneStatus,
    settings: els.dpaneSettings
  };
  for (const [key, pane] of Object.entries(panes)) {
    pane.classList.toggle('active', key === tab);
  }
  renderDrawer();
}

// ── Getters ──────────────────────────────────────────────────────

function getActiveSession() {
  return state.sessions.find((session) => session.id === state.activeSessionId) || null;
}

function getSelectedRunRecord() {
  if (state.activeRunPayload?.run?.runId === state.activeRunId) {
    return state.activeRunPayload.run;
  }
  return state.sessionRuns.find((run) => run.runId === state.activeRunId) || null;
}

// ── Render functions ─────────────────────────────────────────────

function renderSessions() {
  if (state.sessions.length === 0) {
    setHtmlIfChanged(els.sessionList, emptyState('Create a session to start talking to Alfred.'));
    return;
  }

  const html = state.sessions.map((session) => {
    const active = session.id === state.activeSessionId ? 'active' : '';
    const working = session.workingMemory || {};
    const latest = working.lastOutcomeSummary || working.activeObjective || 'No recent summary yet.';
    const liveLabel = active ? '<span class="live-pill">Live</span>' : '';
    const tgInfo = state.channelSessionMap[session.id];
    const tgBadge = tgInfo
      ? `<span class="tg-badge">TG${tgInfo.label ? ' · ' + escapeHtml(tgInfo.label) : ''}</span>`
      : '';
    return `
      <button class="session-item ${active}" data-session-id="${escapeHtml(session.id)}">
        <div class="session-item-name">${escapeHtml(session.name)}</div>
        <div class="session-item-meta">
          ${liveLabel}
          ${tgBadge}
          <span class="session-meta">${escapeHtml(formatRelativeTime(session.updatedAt))}</span>
        </div>
        <div class="session-summary">${escapeHtml(toShortText(latest, 120))}</div>
      </button>
    `;
  }).join('');
  setHtmlIfChanged(els.sessionList, html);
}

function renderChatHeader() {
  const session = getActiveSession();
  const run = getSelectedRunRecord();

  setTextIfChanged(els.activeSessionName, session ? session.name : '—');

  const tgInfo = session ? state.channelSessionMap[session.id] : null;
  if (tgInfo) {
    els.channelBadge.textContent = `TG${tgInfo.label ? ' · ' + tgInfo.label : ''}`;
    els.channelBadge.classList.remove('hidden');
  } else {
    els.channelBadge.classList.add('hidden');
  }

  setTextIfChanged(els.runStatusPill, run ? statusLabel(run.status) : 'idle');
  els.runStatusPill.className = `status-pill ${statusClass(run?.status)}`;

  const totalTokens = getSessionTotalTokens();
  if (totalTokens > 0) {
    setTextIfChanged(els.sessionTokensBadge, formatTokenCount(totalTokens));
    els.sessionTokensBadge.classList.remove('hidden');
  } else {
    els.sessionTokensBadge.classList.add('hidden');
  }
}

function buildRunAssistantPreview(run) {
  if (state.activeRunPayload?.run?.runId === run.runId && !isTerminalStatus(run.status)) {
    return latestProgressMessage(state.activeRunPayload);
  }
  if (!run.assistantText && !isTerminalStatus(run.status)) {
    return 'Run in progress...';
  }
  return run.assistantText || `Run status: ${run.status}`;
}

function renderChatHistory() {
  if (!state.activeSessionId) {
    setHtmlIfChanged(els.chatHistory, emptyState('No session selected.'));
    return;
  }

  if (state.sessionRuns.length === 0) {
    setHtmlIfChanged(els.chatHistory, emptyState('No runs yet in this session.'));
    return;
  }

  const runs = state.sessionRuns.slice(0, CHAT_RUN_CAP).reverse();
  const html = runs.map((run) => {
    const active = run.runId === state.activeRunId;
    const assistantPreview = buildRunAssistantPreview(run);
    const thinkingLines = active ? getChatThinkingLines(run) : [];
    const thinkingBlock = thinkingLines.length > 0
      ? `
          <div class="thinking-stream">
            <div class="thinking-title">Alfred execution stream</div>
            ${thinkingLines.map((line) => `<div class="thinking-line">${escapeHtml(line)}</div>`).join('')}
          </div>
        `
      : '';
    const userMax = active ? 12_000 : 3_000;
    const artifacts = run.artifactPaths?.length ? `<span>${run.artifactPaths.length} artifacts</span>` : '';
    const actions = active
      ? `
          <div class="message-actions">
            <button class="ghost-btn" data-open-run="${escapeHtml(run.runId)}">Inspect</button>
            <button class="ghost-btn" data-export-run="${escapeHtml(run.runId)}">Export JSON</button>
          </div>
        `
      : '';
    return `
      <section class="chat-turn ${active ? 'active' : ''}" data-run-id="${escapeHtml(run.runId)}">
        <article class="chat-bubble user-bubble">
          <div class="message-role">User</div>
          <div class="message-body user">${escapeHtml(truncatePreserveLayout(run.message, userMax))}</div>
        </article>
        <article class="chat-bubble assistant-bubble">
          <div class="message-role">Alfred</div>
          ${thinkingBlock}
          <div class="md-body">${renderMarkdown(assistantPreview)}</div>
          <div class="message-meta">
            <span>${escapeHtml(statusLabel(run.status))}</span>
            <span>${escapeHtml(shortId(run.runId))}</span>
            <span>${escapeHtml(formatDateTime(run.updatedAt))}</span>
            <span>${escapeHtml(formatTokenUsage(run.llmUsage || {}))}</span>
            ${artifacts}
          </div>
          ${actions}
        </article>
      </section>
    `;
  }).join('');
  setHtmlIfChanged(els.chatHistory, html);

  // Scroll to bottom on update
  els.chatHistory.scrollTop = els.chatHistory.scrollHeight;
}

function renderArtifactsStrip() {
  const run = getSelectedRunRecord();
  const artifacts = run?.artifactPaths || [];
  if (artifacts.length === 0) {
    els.artifactsStrip.classList.add('hidden');
    return;
  }
  els.artifactsStrip.classList.remove('hidden');
  const chipsHtml = artifacts.map((artifact) =>
    `<div class="artifact-chip">${escapeHtml(artifact.split('/').pop() || artifact)}</div>`
  ).join('');
  setHtmlIfChanged(els.artifactChips, chipsHtml);
}

function renderInspector() {
  const payload = state.activeRunPayload;
  const run = payload?.run;
  const latestHeartbeat = getLastEvent(payload, (event) => event.phase === 'observe' && event.eventType === 'heartbeat');
  const recentThoughts = getRecentEvents(payload, (event) => event.phase === 'thought', 6);
  const recentTools = (run?.toolCalls || []).slice(-6).reverse();

  setTextIfChanged(els.inspectorRunStatus, run ? statusLabel(run.status) : 'idle');
  els.inspectorRunStatus.className = `status-pill ${statusClass(run?.status)}`;

  if (!run) {
    setHtmlIfChanged(els.livePulse, '');
    setHtmlIfChanged(els.thoughtFeed, emptyState('No thought events yet.'));
    setHtmlIfChanged(els.toolFeed, emptyState('No tool activity yet.'));
    setHtmlIfChanged(els.budgetGrid, [
      metricCard('Tokens', '0'),
      metricCard('Elapsed', '0s'),
      metricCard('Tool Calls', '0'),
      metricCard('Artifacts', '0')
    ].join(''));
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
          <span class="event-label">Thinking</span>
          <div class="event-text">${escapeHtml(distillThoughtForChat(event) || summarizeEvent(event))}</div>
        </div>
      `).join('')
    : emptyState('No thought events on this run.'));

  setHtmlIfChanged(els.toolFeed, recentTools.length > 0
    ? recentTools.map((call) => `
        <div class="event-item">
          <span class="event-label">${escapeHtml(call.toolName)} | ${escapeHtml(call.status)}</span>
          <div class="event-text">${escapeHtml(`${call.durationMs}ms | ${toShortText(pretty(call.outputRedacted), 130)}`)}</div>
        </div>
      `).join('')
    : emptyState('No tool calls recorded.'));

  setHtmlIfChanged(els.budgetGrid, [
    metricCard('Tokens', String(run.llmUsage?.totalTokens || 0)),
    metricCard('Elapsed', formatElapsedMs(computeRunElapsed(payload))),
    metricCard('Tool Calls', String(run.toolCalls?.length || 0)),
    metricCard('Artifacts', String((run.artifactPaths || []).length || 0))
  ].join(''));
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
    setHtmlIfChanged(els.telemetryRuns, emptyState(filter ? 'No runs matched that filter.' : 'No runs available for this session.'));
    return;
  }

  const html = runs.map((run) => {
    const active = run.runId === state.activeRunId ? 'active' : '';
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
  }).join('');
  setHtmlIfChanged(els.telemetryRuns, html);
}

function renderTelemetry() {
  const payload = state.activeRunPayload;
  const run = payload?.run;

  if (!run) {
    setHtmlIfChanged(els.telemetryMeta, emptyState('Select a run to inspect telemetry.'));
    setHtmlIfChanged(els.telemetryConsole, emptyState('No telemetry loaded.'));
    return;
  }

  setHtmlIfChanged(els.telemetryMeta, [
    metricCard('Run', shortId(run.runId)),
    metricCard('Status', statusLabel(run.status)),
    metricCard('Events', String(payload.events?.length || 0)),
    metricCard('Tool Calls', String(run.toolCalls?.length || 0)),
    metricCard('Tokens', String(run.llmUsage?.totalTokens || 0)),
    metricCard('Artifacts', String(run.artifactPaths?.length || 0))
  ].join(''));

  setHtmlIfChanged(els.telemetryConsole, state.telemetryMode === 'raw' ? buildRawTelemetry(payload) : buildFormattedTelemetry(payload));
  els.telemetryFormat.classList.toggle('active', state.telemetryMode === 'formatted');
  els.telemetryRaw.classList.toggle('active', state.telemetryMode === 'raw');
}

function renderStatusPage() {
  const status = state.providerStatus;
  const llm = state.llmStatus;
  const session = getActiveSession();
  const run = getSelectedRunRecord();
  const sessionTokens = getSessionTotalTokens();

  setHtmlIfChanged(els.statusLlmCard, llm
    ? `
        <p>Provider: ${escapeHtml(llm.provider)}</p>
        <p>Fast model: ${escapeHtml(llm.modelFast)}</p>
        <p>Smart model: ${escapeHtml(llm.modelSmart)}</p>
        <p>Session tokens: ${escapeHtml(formatTokenCount(sessionTokens))} (${escapeHtml(String(sessionTokens))} total)</p>
      `
    : '<p>Loading…</p>');

  setHtmlIfChanged(els.statusProviderCard, status
    ? `
        <p>Primary healthy: ${escapeHtml(String(status.primaryHealthy))}</p>
        <p>Fallback healthy: ${escapeHtml(String(status.fallbackHealthy))}</p>
        <p>Active default: ${escapeHtml(String(status.activeDefault || 'unknown'))}</p>
        <p>Primary provider: ${escapeHtml(String(status.primaryProvider || 'unknown'))}</p>
      `
    : '<p>Status not loaded yet.</p>');

  setHtmlIfChanged(els.statusSessionCard, `
    <p>Total sessions visible: ${escapeHtml(String(state.sessions.length))}</p>
    <p>Selected session: ${escapeHtml(session?.name || 'none')}</p>
    <p>Runs in selected session: ${escapeHtml(String(state.sessionRuns.length))}</p>
    <p>Selected run: ${escapeHtml(run ? shortId(run.runId) : 'none')}</p>
  `);

  const channelEntries = Object.entries(state.channelSessionMap);
  if (channelEntries.length === 0) {
    setHtmlIfChanged(els.statusChannelCard, '<p>No Telegram channels linked.</p>');
  } else {
    const lines = channelEntries.map(([sessionId, info]) => {
      const s = state.sessions.find((sess) => sess.id === sessionId);
      const sessionName = s ? escapeHtml(s.name) : escapeHtml(shortId(sessionId));
      const label = info.label ? escapeHtml(info.label) : '(no label)';
      return `<p>TG ${escapeHtml(info.key)} · ${label} → session ${sessionName}</p>`;
    }).join('');
    setHtmlIfChanged(els.statusChannelCard, lines);
  }
}

function renderSettingsPage() {
  setHtmlIfChanged(els.settingsUiCard, `
    <p>Chat run cap: ${CHAT_RUN_CAP}</p>
    <p>Telemetry event cap: ${TELEMETRY_EVENT_CAP}</p>
    <p>Raw JSON browser cap: ${RAW_VIEW_CAP} chars</p>
    <p>Auto-poll interval: ${POLL_INTERVAL_MS}ms</p>
  `);
}

function renderDrawer() {
  const tab = state.drawerTab;
  if (tab === 'inspector') renderInspector();
  else if (tab === 'telemetry') { renderTelemetryRuns(); renderTelemetry(); }
  else if (tab === 'status') renderStatusPage();
  else if (tab === 'settings') renderSettingsPage();
}

function renderAll() {
  renderSessions();
  renderChatHeader();
  renderChatHistory();
  renderArtifactsStrip();
  renderDrawer();
}

// ── Modal helpers ────────────────────────────────────────────────

function openModal() {
  els.modalBackdrop.classList.remove('hidden');
  els.sessionName.value = '';
  els.sessionName.focus();
}

function closeModal() {
  els.modalBackdrop.classList.add('hidden');
}

// ── Event listeners ──────────────────────────────────────────────

// Sidebar new session
els.newSessionBtn.addEventListener('click', () => {
  openModal();
});

// Modal confirm
els.modalConfirm.addEventListener('click', () => {
  void createSession().then(() => {
    closeModal();
  }).catch(() => {
    closeModal();
  });
});

// Modal cancel
els.modalCancel.addEventListener('click', () => {
  closeModal();
});

// Modal backdrop click outside
els.modalBackdrop.addEventListener('click', (event) => {
  if (event.target === els.modalBackdrop) {
    closeModal();
  }
});

// Session name enter key
els.sessionName.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    void createSession().then(() => {
      closeModal();
    }).catch(() => {
      closeModal();
    });
  }
});

// Debug open buttons
els.debugOpenBtn.addEventListener('click', () => {
  toggleDrawer(true);
  setDrawerTab('inspector');
});

els.navDebug.addEventListener('click', () => {
  toggleDrawer(true);
  setDrawerTab('inspector');
});

els.navSettings.addEventListener('click', () => {
  toggleDrawer(true);
  setDrawerTab('settings');
});

// Debug close
els.debugCloseBtn.addEventListener('click', () => {
  toggleDrawer(false);
});

// Drawer tabs
els.drawerTabs.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-tab]');
  if (!btn) return;
  setDrawerTab(btn.dataset.tab);
});

// Session list
els.sessionList.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-session-id]');
  if (!button) return;
  await selectSession(button.dataset.sessionId);
});

// Chat history
els.chatHistory.addEventListener('click', async (event) => {
  if (hasActiveTextSelectionWithin(els.chatHistory)) {
    return;
  }
  const loadButton = event.target.closest('[data-open-run]');
  const exportButton = event.target.closest('[data-export-run]');
  const card = event.target.closest('[data-run-id]');

  if (exportButton) {
    await exportRun(exportButton.dataset.exportRun);
    return;
  }
  if (loadButton) {
    await loadRun(loadButton.dataset.openRun);
    toggleDrawer(true);
    setDrawerTab('telemetry');
    return;
  }
  if (card?.dataset.runId) {
    await loadRun(card.dataset.runId);
    if (!isTerminalStatus(state.activeRunPayload?.run?.status)) {
      startRunPolling(card.dataset.runId);
    }
  }
});

// Send button
els.send.addEventListener('click', () => {
  void submitComposerTurn().catch(() => {
    // errors are silent in UI
  });
});

// Message keydown
els.message.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') {
    return;
  }
  if (event.shiftKey || event.metaKey || event.ctrlKey) {
    return;
  }
  event.preventDefault();
  void submitComposerTurn().catch(() => {
    // errors are silent in UI
  });
});

// Reset context
els.resetCtxBtn.addEventListener('click', () => {
  void resetSessionContext().catch(() => {
    // errors are silent in UI
  });
});

// Export current run
els.exportCurrentRun.addEventListener('click', () => {
  void exportRun(state.activeRunId).catch(() => {
    // errors are silent in UI
  });
});

// Inspector controls
els.loadRun.addEventListener('click', () => {
  const runId = els.runIdInput.value.trim();
  if (!runId) return;
  void loadRun(runId).then((payload) => {
    toggleDrawer(true);
    setDrawerTab('telemetry');
    if (!isTerminalStatus(payload.run.status)) {
      startRunPolling(runId);
    }
  }).catch(() => {
    // errors are silent in UI
  });
});

els.cancelRun.addEventListener('click', () => {
  const runId = els.runIdInput.value.trim() || state.activeRunId;
  if (!runId) return;
  void api(`/v1/runs/${runId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({})
  }).then(async (payload) => {
    await loadRun(runId);
    if (payload.accepted) {
      startRunPolling(runId);
    }
  }).catch(() => {
    // errors are silent in UI
  });
});

els.exportRun.addEventListener('click', () => {
  void exportRun(els.runIdInput.value.trim() || state.activeRunId).catch(() => {
    // errors are silent in UI
  });
});

// Telemetry controls
els.telemetryFilter.addEventListener('input', () => {
  state.telemetryFilter = els.telemetryFilter.value;
  renderTelemetryRuns();
});

els.refreshRuns.addEventListener('click', () => {
  void refreshSessionRuns().then(async () => {
    if (state.activeRunId) {
      await loadRun(state.activeRunId);
    }
  }).catch(() => {
    // errors are silent in UI
  });
});

els.telemetryFormat.addEventListener('click', () => {
  state.telemetryMode = 'formatted';
  renderTelemetry();
});

els.telemetryRaw.addEventListener('click', () => {
  state.telemetryMode = 'raw';
  renderTelemetry();
});

els.telemetryExport.addEventListener('click', () => {
  void exportRun(state.activeRunId).catch(() => {
    // errors are silent in UI
  });
});

// ── Init ─────────────────────────────────────────────────────────

async function init() {
  await Promise.all([refreshSessions(), refreshChannelSessions(), refreshProviderStatus(), refreshLlmStatus()]);
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

window.addEventListener('beforeunload', () => {
  stopRunPolling();
  if (state.providerTimer) {
    clearInterval(state.providerTimer);
    state.providerTimer = null;
  }
});

void init().catch(() => {
  renderAll();
});
