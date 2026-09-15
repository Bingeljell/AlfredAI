import { z } from "zod";

export const ExtensionCapabilitySchema = z.enum([
  "workspace.read",
  "workspace.write",
  "network",
  "process",
  "secrets"
]);

export const ExtensionManifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  description: z.string().min(1).max(500),
  entry: z.string().regex(/^[A-Za-z0-9._-]+\.js$/).default("index.js"),
  inputHint: z.string().max(2_000).default("{}"),
  alfredVersion: z.string().min(1).max(80).default("0.1.x"),
  capabilities: z.array(ExtensionCapabilitySchema).max(10).default([])
}).strict();

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;
export type ExtensionCapability = z.infer<typeof ExtensionCapabilitySchema>;

export interface ExtensionActivation {
  schemaVersion: 1;
  approvedDigest: string;
  enabledAt: string;
  capabilities: ExtensionCapability[];
}

export type ExtensionState = "disabled" | "enabled" | "stale" | "invalid";

export interface ExtensionSummary {
  name: string;
  version: string | null;
  description: string | null;
  capabilities: ExtensionCapability[];
  digest: string | null;
  state: ExtensionState;
  error?: string;
}
