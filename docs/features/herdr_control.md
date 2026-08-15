# Feature Spec: Herdr Control (`herdr_control`)

**Date:** 2026-08-15  
**Author:** Alfred & Nikhil Shahane  
**Status:** In Progress / Implementing  

---

## 1. Overview & Objective

Alfred serves as a personal AI execution partner and remote control centre for Nikhil. When Nikhil is remote (e.g. driving tasks via Telegram), Alfred needs the capability to monitor, inspect, coordinate, and dispatch tasks to AI coding agents (Claude, Codex, Pi, OpenCodeInterpreter, etc.) running on the host machine.

Instead of managing raw pseudo-terminals or brittle tmux string parsing, Alfred interfaces with **Herdr**—the local terminal workspace manager built for AI coding agents (`https://herdr.dev`). Herdr provides a structured JSON API over its local socket (`~/.config/herdr/herdr.sock`) and exposes native agent lifecycle states (`idle`, `working`, `blocked`, `done`).

---

## 2. Herdr Architecture & Integration Model

Herdr organizes terminal topology as:
- **Workspaces (`w1`, `w2`, ...)**
- **Tabs (`w1:t1`, ...)**
- **Panes (`w1:p1`, ...)**
- **Agents:** Named instances occupying panes with recognized status (`idle`, `working`, `blocked`, `done`, `unknown`).

`herdr` CLI outputs clean JSON responses for all query and mutation subcommands (`herdr agent list`, `herdr pane capture`, `herdr agent prompt`, etc.).

---

## 3. Tool Specification: `herdr_control`

The `herdr_control` tool wraps the Herdr CLI into a clean, action-oriented interface with token-bounded outputs suitable for any LLM (Gemini, Claude, GPT, DeepSeek).

### 3.1 Input Schema Actions
- `list_agents`: Returns all active agents, their workspace/pane IDs, kinds (`pi`, `claude`, `codex`, etc.), and lifecycle states.
- `list_workspaces`: Returns all workspaces, tabs, and pane hierarchy.
- `capture_pane`: Retrieves scrollback text from a specified pane or agent (supports line bounds and text filtering).
- `prompt_agent`: Sends a text prompt/task to a running agent (`herdr agent prompt <name> "<text>"`).
- `start_agent`: Starts a named agent (`pi`, `claude`, `codex`) in a target pane.
- `split_pane`: Splits an existing pane (`right` or `down`) with an optional working directory.
- `send_keys`: Sends raw keystrokes or confirmation keys (e.g., `y\n`, `Enter`, `Ctrl+C`) to handle blocked prompts.
- `focus`: Focuses a pane or tab for visual inspection.

### 3.2 Token Efficiency & Safeguards
- All raw terminal captures are sliced and cleaned (ANSI escape removal, bounded to last N lines, default max 100 lines / 4,000 chars) to prevent context flooding.
- Strict error handling if Herdr daemon is not running or if pane/agent handles are invalid.
