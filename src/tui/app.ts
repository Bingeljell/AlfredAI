import { emitKeypressEvents, type Key } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import type { SessionRecord, RunRecord, ConversationSnapshot } from "../types.js";
import { GatewayClient } from "./client.js";
import { Composer, clip, graphemes, transcript, wrap } from "./screen.js";

const HELP = "Ctrl-P conversations · Ctrl-N new · Ctrl-T tools · Ctrl-X cancel · Ctrl-Q detach\nEnter send · Ctrl-J newline · PgUp/PgDn scroll · Ctrl-L older history · Esc follow latest\n/model, /reasoning, /usage, /status use Alfred's shared controls. /newsession [name] creates a separate conversation. Artifacts show their server paths.";

/** UI state is disposable. The gateway alone owns conversations and execution. */
export async function runTerminal(client: GatewayClient, sessionId?: string): Promise<void> {
  const input = process.stdin;
  const output = process.stdout;
  if (!input.isTTY || !output.isTTY) throw new Error("Alfred TUI requires an interactive terminal.");
  let sessions = await client.sessions();
  let selected = sessionId ? sessions.find((session) => session.id === sessionId) : undefined;
  if (sessionId && !selected) {
    // The picker is bounded; explicit session IDs can still open older sessions.
    const controller = new AbortController();
    try {
      for await (const snapshot of client.watch(sessionId, controller.signal)) {
        selected = snapshot.session;
        break;
      }
    } finally { controller.abort(); }
    if (!selected) throw new Error("Conversation not found");
  }

  const lifetime = new AbortController();
  let watching: AbortController | undefined;
  let picker = !selected;
  let pickerIndex = 0;
  let filter = "";
  let runs: RunRecord[] = [];
  let notifications: ConversationSnapshot["notifications"] = [];
  let connection = "Connecting";
  let scroll = 0;
  let details = false;
  let notice = "Choose a conversation to continue, or press Ctrl-N to create one.";
  let controlOutput = "";
  const drafts = new Map<string, Composer>();
  const pending = new Map<string, string>();
  let composer = new Composer();
  let paste = false;
  let pasteText = "";
  let frame: string[] = [];
  let paintTimer: NodeJS.Timeout | undefined;
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });

  const visibleSessions = () => sessions.filter((session) => `${session.name} ${session.id}`.toLowerCase().includes(filter.toLowerCase()));
  const width = () => Math.max(1, (output.columns || 80) - 2);

  function paint(): void {
    if (lifetime.signal.aborted) return;
    const w = width();
    const rows = Math.max(1, output.rows || 24);
    const lines: string[] = [];
    const heading = `ALFRED  /  ${picker ? "Conversations" : selected?.name ?? "Terminal"}`;
    lines.push(`\x1b[1;36m${clip(heading, w)}\x1b[0m`);
    lines.push(`\x1b[2m${clip(picker ? "Same conversation. Any surface.  ·  Ctrl-N new  ·  Esc back" : `${connection} · ${selected?.id} · ${selected?.preferences?.modelId ?? "default model"}`, w)}\x1b[0m`);
    lines.push("─".repeat(w));
    if (picker) {
      lines.push(clip(`Search: ${filter}▏`, w), "");
      const visible = visibleSessions();
      pickerIndex = Math.max(0, Math.min(pickerIndex, visible.length - 1));
      const count = Math.max(1, rows - 9);
      const start = Math.max(0, pickerIndex - count + 1);
      for (let i = start; i < Math.min(visible.length, start + count); i++) {
        const session = visible[i]!;
        const label = clip(`${i === pickerIndex ? "›" : " "} ${session.name}  ${session.id.slice(0, 8)}`, w);
        lines.push(i === pickerIndex ? `\x1b[7m${label}\x1b[0m` : label);
      }
      if (!visible.length) lines.push("No conversations found. Ctrl-N creates one.");
      while (lines.length < rows - 3) lines.push("");
      lines.push(clip(notice, w), "", clip("↑/↓ select · Enter open · Type to search · Ctrl-Q detach", w));
    } else {
      const editor = wrap(composer.display(), Math.max(1, w - 2));
      const editorHeight = Math.min(5, editor.length, Math.max(1, rows - 10));
      const noticeLines = wrap(notice, w).slice(0, Math.min(3, Math.max(1, rows - 12)));
      const bodyHeight = Math.max(1, rows - 7 - editorHeight - noticeLines.length);
      const body = transcript(runs, w, details);
      if (notifications.length) body.push("NOTIFICATIONS", ...notifications.flatMap((item) => wrap(item.text, w)), "");
      if (controlOutput) body.push("TERMINAL", ...wrap(controlOutput, w), "");
      if (!body.length) body.push("A fresh conversation. What would you like to work on?");
      scroll = Math.min(scroll, Math.max(0, body.length - bodyHeight));
      const end = Math.max(bodyHeight, body.length - scroll);
      lines.push(...body.slice(Math.max(0, end - bodyHeight), end));
      while (lines.length < 3 + bodyHeight) lines.push("");
      lines.push("─".repeat(w));
      lines.push(...noticeLines.map((line) => `\x1b[33m${line}\x1b[0m`));
      // Keep the cursor's wrapped line visible while editing long drafts.
      const cursorLine = Math.max(0, editor.findIndex((line) => line.includes("▏")));
      const editorStart = Math.max(0, cursorLine - editorHeight + 1);
      lines.push(...editor.slice(editorStart, editorStart + editorHeight).map((line, i) => `${i ? "  " : "› "}${line}`));
      lines.push(`\x1b[2m${clip(pending.has(selected!.id) ? "Submitting… Other surfaces may be finishing a turn. Do not resend." : "Enter send · Ctrl-J newline · Ctrl-P conversations · Ctrl-T tools", w)}\x1b[0m`);
      lines.push(`\x1b[2m${clip(`${scroll ? "Scrolled · Esc follows latest" : "Following latest"} · Ctrl-X cancel · Ctrl-Q detach · /help`, w)}\x1b[0m`);
    }
    while (lines.length < rows) lines.push("");
    const next = lines.slice(0, rows);
    let changes = "";
    for (let i = 0; i < next.length; i++) {
      if (frame[i] !== next[i]) changes += `\x1b[${i + 1};1H\x1b[2K${next[i]}`;
    }
    if (changes) output.write(changes);
    frame = next;
  }

  function render(): void {
    if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = undefined; paint(); }, 32);
  }

  async function watch(session: SessionRecord, controller: AbortController): Promise<void> {
    let backoff = 1_000;
    while (!controller.signal.aborted) {
      try {
        for await (const snapshot of client.watch(session.id, controller.signal)) {
          if (controller.signal.aborted) return;
          selected = snapshot.session;
          runs = [...new Map([...runs, ...snapshot.runs].map((run) => [run.runId, run])).values()];
          notifications = snapshot.notifications ?? [];
          connection = `Connected · latest ${runs.length} runs`;
          backoff = 1_000;
          render();
        }
        if (!controller.signal.aborted) throw new Error("Connection closed");
      } catch (error) {
        if (controller.signal.aborted) return;
        connection = `Reconnecting · ${error instanceof Error ? error.message : "gateway unavailable"}`;
        render();
        await delay(backoff, undefined, { signal: controller.signal }).catch(() => {});
        backoff = Math.min(15_000, backoff * 2);
      }
    }
  }

  function attach(session: SessionRecord): void {
    if (lifetime.signal.aborted) return;
    watching?.abort();
    selected = session;
    composer = drafts.get(session.id) ?? new Composer();
    drafts.set(session.id, composer);
    picker = false;
    scroll = 0;
    runs = [];
    notifications = [];
    controlOutput = "";
    notice = "Attached to shared history. Ctrl-Q detaches without stopping Alfred.";
    connection = "Connecting";
    watching = new AbortController();
    void watch(session, watching);
    render();
  }

  async function openPicker(): Promise<void> {
    picker = true;
    filter = "";
    pickerIndex = 0;
    render();
    sessions = (await client.sessions(lifetime.signal)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    render();
  }

  async function cancel(): Promise<void> {
    const active = runs.find((run) => run.status === "running") ?? runs.find((run) => run.status === "queued");
    notice = active ? await client.cancel(active.runId, lifetime.signal) : "No active run to cancel.";
    render();
  }

  async function send(): Promise<void> {
    if (!selected || pending.has(selected.id)) return;
    const message = composer.value.trim();
    if (!message) return;
    if (message === "/quit") { quit(); return; }
    if (message === "/sessions") { composer.clear(); await openPicker(); return; }
    if (message === "/tools") { composer.clear(); details = !details; render(); return; }
    if (message === "/cancel") { composer.clear(); await cancel(); return; }
    if (message === "/help") { composer.clear(); controlOutput = HELP; notice = "Terminal help"; scroll = 0; render(); return; }
    if (message.startsWith("/attach-channel ")) {
      const channelKey = message.slice(16).trim();
      await client.attachChannel(selected.id, channelKey, lifetime.signal);
      composer.clear(); notice = `${channelKey} now uses this conversation. Existing notification destinations are unchanged.`;
      render(); return;
    }
    if (message.startsWith("/link-telegram ")) {
      await client.linkTelegram(message.slice(15).trim(), lifetime.signal);
      composer.clear(); notice = "Telegram identity linked to the API owner for task access within shared conversations.";
      render(); return;
    }
    if (/^\/newsession(?:\s|$)/.test(message)) {
      const created = await client.create(message.slice(11).trim() || "Terminal conversation", lifetime.signal);
      composer.clear();
      sessions.unshift(created);
      attach(created);
      return;
    }
    const target = selected.id;
    const submittedDraft = composer;
    pending.set(target, message);
    controlOutput = "";
    notice = "Submitting to Alfred…";
    render();
    try {
      const result = await client.submit(target, message, lifetime.signal);
      // Do not erase edits made while admission was waiting on another surface.
      if (submittedDraft.value.trim() === message) submittedDraft.clear();
      if (selected?.id === target) {
        notice = result.runId ? `Accepted · ${result.runId}` : `Control command · ${result.status}`;
        if (!result.runId) controlOutput = result.assistantText ?? result.status;
        scroll = 0;
      }
    } catch (error) {
      if (selected?.id === target) notice = `Submission outcome unknown: ${error instanceof Error ? error.message : "connection failed"}. Check history before resending; draft retained.`;
    } finally {
      pending.delete(target);
      render();
    }
  }

  function quit(): void {
    watching?.abort();
    lifetime.abort();
    resolveExit();
  }

  async function keypress(text: string | undefined, key: Key): Promise<void> {
    if (key.name === "paste-start") { paste = true; pasteText = ""; return; }
    if (key.name === "paste-end") {
      paste = false;
      if (picker) filter += pasteText.replace(/[\r\n]/g, " ").slice(0, 200);
      else composer.insert(pasteText);
      pasteText = "";
      render();
      return;
    }
    if (paste) { pasteText += (text ?? "").slice(0, Math.max(0, 50_000 - pasteText.length)); return; }
    if (key.ctrl && key.name === "q") { quit(); return; }
    if (key.ctrl && key.name === "p") { await openPicker(); return; }
    if (key.ctrl && key.name === "n") {
      if (!selected) {
        const created = await client.create("Terminal conversation", lifetime.signal);
        sessions.unshift(created);
        attach(created);
      } else { picker = false; composer.clear(); composer.insert("/newsession "); }
      render(); return;
    }
    if (picker) {
      if (key.name === "escape" && selected) picker = false;
      else if (key.name === "up") pickerIndex = Math.max(0, pickerIndex - 1);
      else if (key.name === "down") pickerIndex = Math.min(visibleSessions().length - 1, pickerIndex + 1);
      else if (key.name === "return") { const session = visibleSessions()[pickerIndex]; if (session) attach(session); }
      else if (key.name === "backspace") { filter = graphemes(filter).slice(0, -1).join(""); pickerIndex = 0; }
      else if (text && !key.ctrl && !key.meta && !text.startsWith("\x1b")) { filter += text; pickerIndex = 0; }
      render(); return;
    }
    if (key.ctrl && key.name === "x") await cancel();
    else if (key.ctrl && key.name === "l" && selected) {
      const sessionId = selected.id;
      const oldest = [...runs].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.runId.localeCompare(b.runId))[0];
      const history = await client.history(sessionId, oldest?.runId, lifetime.signal);
      if (selected?.id === sessionId) {
        runs = [...new Map([...history.runs, ...runs].map((run) => [run.runId, run])).values()];
        notice = history.runs.length ? `Loaded ${history.runs.length} older turns. PgUp to read.` : "Beginning of conversation.";
      }
    }
    else if (key.ctrl && key.name === "t") details = !details;
    else if (key.ctrl && key.name === "c") { composer.clear(); notice = "Draft cleared. Ctrl-Q detaches; Ctrl-X cancels the active run."; }
    else if (key.name === "pageup") scroll += Math.max(1, (output.rows || 24) - 10);
    else if (key.name === "pagedown") scroll = Math.max(0, scroll - Math.max(1, (output.rows || 24) - 10));
    else if (key.name === "escape") scroll = 0;
    else if (key.name === "enter" || key.ctrl && key.name === "j") composer.insert("\n");
    else if (key.name === "return") { await send(); return; }
    else if (key.name === "backspace") composer.backspace();
    else if (key.name === "delete") composer.delete();
    else if (key.name === "left") composer.cursor = Math.max(0, composer.cursor - 1);
    else if (key.name === "right") composer.cursor = Math.min(graphemes(composer.value).length, composer.cursor + 1);
    else if (key.name === "home" || key.ctrl && key.name === "a") composer.cursor = 0;
    else if (key.name === "end" || key.ctrl && key.name === "e") composer.cursor = graphemes(composer.value).length;
    else if (text && !key.ctrl && !key.meta && !text.startsWith("\x1b")) composer.insert(text);
    render();
  }

  const onKey = (text: string | undefined, key: Key) => {
    void keypress(text, key).catch((error: unknown) => {
      notice = error instanceof Error ? error.message : "Terminal command failed";
      render();
    });
  };
  const onResize = () => { frame = []; render(); };
  const wasRaw = input.isRaw;
  emitKeypressEvents(input);
  try {
    output.write("\x1b[?1049h\x1b[?25l\x1b[?2004h");
    input.setRawMode(true);
    input.resume();
    input.on("keypress", onKey);
    input.on("end", quit);
    output.on("resize", onResize);
    process.on("SIGINT", quit);
    process.on("SIGTERM", quit);
    if (selected) attach(selected);
    paint();
    await exited;
  } finally {
    quit();
    if (paintTimer) clearTimeout(paintTimer);
    input.removeListener("keypress", onKey);
    input.removeListener("end", quit);
    output.removeListener("resize", onResize);
    process.removeListener("SIGINT", quit);
    process.removeListener("SIGTERM", quit);
    input.setRawMode(wasRaw);
    input.pause();
    output.write("\x1b[?2004l\x1b[?25h\x1b[?1049l");
  }
}
