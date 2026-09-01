import { CodexAccountService, type OpenAiLoginMode } from "../src/provider/codex/accountService.js";

function usage(): never {
  throw new Error("Usage: pnpm alfred auth login openai [--device-code] | pnpm alfred auth status openai | pnpm alfred auth logout openai");
}

const args = process.argv.slice(2);
if (args[0] !== "auth" || !["login", "status", "logout"].includes(args[1] ?? "") || args[2] !== "openai") usage();

const service = new CodexAccountService();
try {
  if (args[1] === "login") {
    const mode: OpenAiLoginMode = args.includes("--device-code") ? "device-code" : "browser";
    const login = await service.startLogin(mode);
    console.log(JSON.stringify(login, null, 2));
  } else if (args[1] === "status") {
    console.log(JSON.stringify(await service.readAccount(), null, 2));
  } else {
    await service.logout();
    console.log(JSON.stringify({ ok: true }, null, 2));
  }
} finally {
  await service.close();
}
