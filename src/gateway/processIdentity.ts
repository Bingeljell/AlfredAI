export const ALFRED_SERVER_PROCESS_TAG = "alfred-server";

function normalizeLabel(label: string): string {
  return label.trim().replace(/[^a-zA-Z0-9._-]+/g, "-") || "child";
}

export function managedProcessTag(label: string): string {
  return `${ALFRED_SERVER_PROCESS_TAG}:managed:${normalizeLabel(label)}`;
}
