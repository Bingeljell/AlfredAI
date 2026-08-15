# Interactive Browser Automation Tool Spec (`browser_action`)

## 1. Overview & Objectives
This specification outlines the design and implementation of an interactive, token-efficient browser automation tool (`browser_action`) for Alfred.

### Primary Goals
1. **Interactive Capability**: Support granular browser interactions (navigation, click, type, select, file upload, script execution, scrolling, screenshot capture).
2. **Dual Operation Modes**:
   - **Headless / Isolated Chrome**: For unattended background tasks or clean sessions.
   - **User Chrome / Headful / CDP Attach**: Connect to an active Chrome instance (via remote debugging port 9222) or launch a headful window to share user sessions, cookies, and allow visual inspection.
3. **Extreme Token Efficiency**:
   - Rely on interactive Accessibility Tree (AXTree) snapshots with numbered references (`[1]`, `[2]`, `[3]`) rather than dumping raw HTML.
   - Limit typical page representations to 300–800 tokens per action cycle.
4. **Model Agnostic & Vision Fallback**:
   - Operates cleanly on pure text output for any LLM (Gemini, Claude, DeepSeek, local models).
   - Screenshots are optional artifacts for multimodal inspection or user reporting.
5. **Separation of Concerns**:
   - `web_fetch` & `pinchtab_fetch` remain the default for fast, lightweight, background read-only scraping.
   - `browser_action` is reserved for interactive workflows, web app manipulation, file uploads to local servers (e.g. 3D viewers, Gradio/Streamlit), and authenticated browsing.

---

## 2. Tool Definition Contract

### Tool Name
`browser_action`

### Action Primitives
| Action | Parameters | Description |
|---|---|---|
| `navigate` | `url: string`, `mode?: "headless" \| "user_chrome"` | Open a URL. Can launch isolated or connect to existing Chrome CDP. |
| `click` | `refId: number` or `selector: string` | Click an element by its numeric AXTree ID or CSS selector. |
| `type` | `refId: number` or `selector: string`, `text: string`, `submit?: boolean` | Type text into an input / textarea. |
| `upload` | `refId: number` or `selector: string`, `filePath: string` | Set input files for `<input type="file">`. |
| `select` | `refId: number` or `selector: string`, `value: string` | Choose option in dropdown. |
| `snapshot` | `includeFullText?: boolean` | Return updated token-efficient AXTree reference map. |
| `screenshot` | `outputPath?: string` | Save full page or viewport screenshot to disk. |
| `evaluate` | `script: string` | Run custom JavaScript in the active page context. |
| `close` | none | Close current tab / context. |

---

## 3. Architecture & Implementation Details

### A. Lifecycle Management (`browserPool.ts` / CDP Connector)
- Maintain a single shared persistent browser session manager.
- If `mode: "user_chrome"`, attempt connection to `http://localhost:9222` via Playwright CDP (`chromium.connectOverCDP`).
- If no debugging instance is found or `mode: "headless"`, use in-process Playwright Chromium instance.

### B. DOM / AXTree Sanitizer
To ensure token efficiency, the DOM inspection returns a structured tree:
```text
PAGE: https://localhost:3000/viewer
TITLE: 3D Model Viewer

INTERACTIVE ELEMENTS:
[1] button "Upload Mesh"
[2] input[type="file"] (hidden / upload target)
[3] select "Render Mode" (current: "PBR")
[4] button "Export GLB"

VISIBLE TEXT SUMMARY:
- Ready to load model. Drop file or click upload.
```

---

## 4. Integration with Alfred
1. Implement `src/tools/definitions/browser_action.tool.ts`.
2. Add `browser_action` to `toolAllowlist` in `src/runtime/specialists.ts`.
3. Add Playwright dependency (`pnpm add playwright`) if not already present.
4. Run `pnpm tsc --noEmit` to verify type safety.
