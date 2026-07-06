/**
 * Local-model smoke test.
 *
 * Probes an OpenAI-compatible server (LM Studio, mlx-lm, Ollama, llama.cpp, …)
 * for the two capabilities Alfred actually depends on — tool calling and
 * `json_schema` structured output — plus a check for GPT-OSS / Harmony reasoning
 * leaking into the answer. It talks to the server DIRECTLY, not through Alfred's
 * provider stack, so it isolates the model/runtime question from Alfred entirely.
 *
 * Run:
 *   pnpm probe:model
 *   PROBE_BASE_URL=http://localhost:8080 PROBE_MODEL=gpt-oss-20b pnpm probe:model
 *   node --import tsx scripts/probe-local-model.ts
 *
 * Env:
 *   PROBE_BASE_URL    default http://localhost:1234   (LM Studio; mlx-lm is usually :8080)
 *   PROBE_MODEL       default "local-model"           (the id your server reports)
 *   PROBE_API_KEY     default "not-needed"            (local servers ignore it)
 *   PROBE_TIMEOUT_MS  default 120000                  (local models can be slow)
 *
 * Exit code is 0 only if all probes pass, so it is safe to gate on in a script.
 */

const BASE_URL = (process.env.PROBE_BASE_URL ?? "http://localhost:1234").replace(/\/+$/, "");
const MODEL = process.env.PROBE_MODEL ?? "local-model";
const API_KEY = process.env.PROBE_API_KEY ?? "not-needed";
const TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS ?? 120_000);
const CHAT_ENDPOINT = `${BASE_URL}/v1/chat/completions`;
const MODELS_ENDPOINT = `${BASE_URL}/v1/models`;

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);
const PASS = green("PASS");
const FAIL = red("FAIL");
const WARN = yellow("WARN");

interface ChatMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: unknown } }>;
  reasoning_content?: string | null;
  reasoning?: string | null;
}
interface ChatResult {
  ok: boolean;
  status: number;
  message?: ChatMessage;
  finishReason?: string;
  raw: string;
  errorText?: string;
  transportError?: string;
}

async function chat(body: Record<string, unknown>): Promise<ChatResult> {
  try {
    const res = await fetch(CHAT_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
      body: JSON.stringify({ model: MODEL, ...body }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const raw = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* leave parsed null */
    }
    if (!res.ok) {
      return { ok: false, status: res.status, raw, errorText: raw.slice(0, 400) };
    }
    const choice = (parsed as { choices?: Array<{ message?: ChatMessage; finish_reason?: string }> })?.choices?.[0];
    return { ok: true, status: res.status, message: choice?.message, finishReason: choice?.finish_reason, raw };
  } catch (error) {
    return { ok: false, status: 0, raw: "", transportError: error instanceof Error ? error.message : String(error) };
  }
}

// Harmony/CoT special tokens or obvious reasoning preamble leaking into content.
function looksLikeLeakedReasoning(content: string): boolean {
  return /<\|(channel|start|message|end|constrain)\|>|<\|assistant\|>|(^|\n)\s*analysis\b/i.test(content);
}

function stripCodeFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1] ?? text;
}

function separatedReasoning(message: ChatMessage | undefined): string | null {
  const r = message?.reasoning_content ?? message?.reasoning;
  return typeof r === "string" && r.trim() ? r : null;
}

let passCount = 0;
let failCount = 0;
const notes: string[] = [];

function report(name: string, ok: boolean, detail: string, extra?: string): void {
  console.log(`  ${ok ? PASS : FAIL}  ${bold(name)} ${dim("— " + detail)}`);
  if (extra) {
    console.log(dim(extra.split("\n").map((l) => "        " + l).join("\n")));
  }
  ok ? passCount++ : failCount++;
}

async function preflight(): Promise<boolean> {
  console.log(bold(`\nAlfred local-model probe`));
  console.log(dim(`  server  ${BASE_URL}`));
  console.log(dim(`  model   ${MODEL}`));
  try {
    const res = await fetch(MODELS_ENDPOINT, {
      headers: { authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10_000)
    });
    if (!res.ok) {
      console.log(`  ${WARN}  /v1/models returned ${res.status} — continuing anyway`);
      return true;
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const ids = (data.data ?? []).map((m) => m.id).filter(Boolean) as string[];
    console.log(dim(`  loaded  ${ids.length ? ids.join(", ") : "(none reported)"}`));
    if (ids.length && !ids.includes(MODEL)) {
      console.log(`  ${WARN}  PROBE_MODEL="${MODEL}" is not in the loaded list — set PROBE_MODEL to one of the above.`);
    }
    return true;
  } catch (error) {
    console.log(`\n  ${FAIL}  Cannot reach ${MODELS_ENDPOINT}`);
    console.log(dim(`        ${error instanceof Error ? error.message : String(error)}`));
    console.log(dim(`        Is the server running? Try: curl ${MODELS_ENDPOINT}`));
    return false;
  }
}

async function probeBasicAndReasoning(): Promise<void> {
  console.log(bold("\n1. Basic chat + reasoning separation"));
  const r = await chat({
    messages: [{ role: "user", content: "Reply with exactly one word: PONG" }],
    max_tokens: 512,
    temperature: 0
  });
  if (r.transportError) return report("basic chat", false, "transport error", r.transportError);
  if (!r.ok) return report("basic chat", false, `HTTP ${r.status}`, r.errorText);

  const content = (r.message?.content ?? "").trim();
  if (!content) return report("basic chat", false, "empty content", `finish_reason=${r.finishReason}\nraw=${r.raw.slice(0, 300)}`);

  const leaked = looksLikeLeakedReasoning(content);
  const sepReasoning = separatedReasoning(r.message);
  report("basic chat", !leaked, leaked ? "responds, but reasoning is leaking into content" : "responds cleanly",
    `content: ${JSON.stringify(content.slice(0, 160))}`);
  if (sepReasoning) {
    console.log(dim(`        note: server exposes reasoning separately (reasoning_content) — good, Alfred ignores it`));
  }
  if (leaked) {
    notes.push("Reasoning is leaking into `content`. For GPT-OSS this means the server isn't parsing the Harmony channels — expect a fixed chat template (LM Studio) or use mlx-lm, which handles Harmony natively.");
  }
}

async function probeToolCalling(): Promise<void> {
  console.log(bold("\n2. Tool calling"));
  const r = await chat({
    messages: [
      { role: "system", content: "You are a helpful assistant with access to tools. When a tool is relevant, call it." },
      { role: "user", content: "What is the weather in Tokyo right now? Use the get_weather tool." }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the current weather for a city.",
          parameters: {
            type: "object",
            additionalProperties: false,
            properties: { city: { type: "string", description: "City name" } },
            required: ["city"]
          }
        }
      }
    ],
    tool_choice: "auto",
    temperature: 0
  });
  if (r.transportError) return report("tool calling", false, "transport error", r.transportError);
  if (!r.ok) return report("tool calling", false, `HTTP ${r.status}`, r.errorText);

  const calls = r.message?.tool_calls ?? [];
  if (calls.length === 0) {
    const content = (r.message?.content ?? "").trim();
    const emittedAsText = /get_weather|"city"|\{\s*"name"/i.test(content);
    report("tool calling", false, emittedAsText ? "no tool_calls — model emitted the call as TEXT" : "no tool_calls returned",
      `finish_reason=${r.finishReason}\ncontent: ${JSON.stringify(content.slice(0, 200))}`);
    notes.push(emittedAsText
      ? "The model wanted to call the tool but the runtime returned it as text, not structured tool_calls — this is a chat-template / tool-parser problem in the server."
      : "The model did not attempt the tool. Try a stronger prompt or confirm the runtime advertises tool support for this model.");
    return;
  }

  const call = calls[0];
  const name = call.function?.name;
  const rawArgs = call.function?.arguments;
  let args: unknown = null;
  let argsOk = false;
  try {
    args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs;
    argsOk = !!args && typeof args === "object" && typeof (args as { city?: unknown }).city === "string";
  } catch {
    argsOk = false;
  }
  const ok = name === "get_weather" && argsOk;
  report("tool calling", ok,
    ok ? "returned a valid tool_call" : `tool_call present but ${name !== "get_weather" ? `name="${name}"` : "arguments not valid JSON with 'city'"}`,
    `name=${name}  arguments=${typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs)}`);
  if (!ok) notes.push("Tool call shape is off — Alfred needs message.tool_calls[].function.{name, arguments:<json string>}.");
}

async function probeStructuredOutput(): Promise<void> {
  console.log(bold("\n3. Structured output (json_schema)"));
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      company: { type: "string" },
      employees: { type: "integer" },
      isHiring: { type: "boolean" }
    },
    required: ["company", "employees", "isHiring"]
  };
  const r = await chat({
    messages: [
      { role: "system", content: "Extract structured data. Respond only with JSON matching the schema." },
      { role: "user", content: "Acme Corp has 42 employees and is currently hiring." }
    ],
    response_format: { type: "json_schema", json_schema: { name: "company_facts", strict: true, schema } },
    temperature: 0
  });
  if (r.transportError) return report("structured output", false, "transport error", r.transportError);
  if (!r.ok) {
    report("structured output", false, `HTTP ${r.status} — server may not support response_format json_schema`, r.errorText);
    notes.push("Server rejected response_format json_schema. Alfred's structured paths (classification, doc_qa, lead extraction) need this. LM Studio supports it; check your mlx-lm / runtime version.");
    return;
  }

  const content = (r.message?.content ?? "").trim();
  let parsed: unknown = null;
  let neededDefence = false;
  try {
    parsed = JSON.parse(content);
  } catch {
    try {
      parsed = JSON.parse(stripCodeFence(content));
      neededDefence = true;
    } catch {
      parsed = null;
    }
  }
  if (!parsed || typeof parsed !== "object") {
    return report("structured output", false, "content is not valid JSON", `content: ${JSON.stringify(content.slice(0, 200))}`);
  }
  const p = parsed as Record<string, unknown>;
  const shapeOk =
    typeof p.company === "string" && typeof p.employees === "number" && typeof p.isHiring === "boolean";
  const ok = shapeOk && !neededDefence;
  report("structured output", ok,
    !shapeOk ? "JSON parsed but does not match the schema shape"
      : neededDefence ? "valid JSON, but it was wrapped in a code fence (strict mode not honoured)"
        : "clean JSON matching the schema",
    `parsed: ${JSON.stringify(parsed)}`);
  if (shapeOk && neededDefence) {
    notes.push("Structured output works but the model wrapped JSON in ``` fences — Alfred's repair layer handles this, but strict json_schema isn't being enforced by the server.");
  } else if (!shapeOk) {
    notes.push("Structured output did not match the requested schema — Alfred's strict paths may fall back to heuristics with this model/runtime.");
  }
}

async function main(): Promise<void> {
  const reachable = await preflight();
  if (!reachable) process.exit(2);

  await probeBasicAndReasoning();
  await probeToolCalling();
  await probeStructuredOutput();

  console.log(bold("\nSummary"));
  console.log(`  ${passCount} passed, ${failCount} failed`);
  if (notes.length) {
    console.log(bold("\nWhat to look at:"));
    for (const n of notes) console.log(dim("  • " + n));
  }
  const verdict = failCount === 0;
  console.log(`\n  ${verdict ? green("Ready for Alfred") : red("Not yet ready")} ${dim(`— ${BASE_URL} (${MODEL})`)}\n`);
  process.exit(verdict ? 0 : 1);
}

void main();
