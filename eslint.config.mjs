import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

export default tseslint.config(
  {
    plugins: {
      boundaries
    },
    settings: {
      "boundaries/elements": [
        { type: "types",    pattern: "src/types.ts" },
        { type: "utils",    pattern: "src/utils/*" },
        { type: "config",   pattern: "src/config/*" },
        { type: "provider", pattern: "src/provider/*" },
        { type: "tools",    pattern: "src/tools/**/*" },
        { type: "memory",   pattern: "src/memory/*" },
        { type: "runs",     pattern: "src/runs/**/*" },
        { type: "workers",  pattern: "src/workers/*" },
        { type: "runtime",  pattern: "src/runtime/*" },
        { type: "runner",   pattern: "src/runner/*" },
        { type: "channels", pattern: "src/channels/**/*" },
        { type: "gateway",  pattern: "src/gateway/*" }
      ],
      "boundaries/ignore": ["tests/**/*", "src/evals/**/*", "src/prompts/**/*"]
    },
    rules: {
      "boundaries/element-types": ["error", {
        default: "disallow",
        rules: [
          // Foundation
          { from: "types",    allow: [] },
          { from: "utils",    allow: ["types"] },
          { from: "config",   allow: ["types"] },
          // Core
          { from: "provider", allow: ["types", "utils", "config"] },
          { from: "runs",     allow: ["types", "utils", "config"] },
          { from: "workers",  allow: ["types"] },
          { from: "tools",    allow: ["types", "utils", "config", "provider", "runs"] },
          { from: "memory",   allow: ["types", "utils", "config", "runs"] },
          // Runtime
          { from: "runtime",  allow: ["types", "utils", "config", "provider", "tools", "memory", "runs", "workers"] },
          // Application
          { from: "runner",   allow: ["types", "utils", "config", "runtime", "memory", "runs", "tools", "workers"] },
          { from: "channels", allow: ["types", "utils", "config", "runner", "memory", "runs"] },
          { from: "gateway",  allow: ["types", "utils", "config", "runner", "channels", "runs", "memory"] }
        ]
      }]
    }
  },
  {
    files: ["src/**/*.ts"],
    extends: [tseslint.configs.base]
  }
);
