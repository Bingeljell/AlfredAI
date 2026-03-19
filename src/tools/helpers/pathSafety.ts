import path from "node:path";

export function resolvePathInProject(projectRoot: string, requestedPath: string): string {
  const normalizedInput = requestedPath.trim();
  if (!normalizedInput) {
    throw new Error("path is required");
  }

  const absolute = path.isAbsolute(normalizedInput)
    ? path.resolve(normalizedInput)
    : path.resolve(projectRoot, normalizedInput);
  const normalizedRoot = path.resolve(projectRoot);
  if (absolute === normalizedRoot) {
    return absolute;
  }

  const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  if (!absolute.startsWith(prefix)) {
    throw new Error("path escapes project root");
  }
  return absolute;
}

export function toProjectRelative(projectRoot: string, absolutePath: string): string {
  return path.relative(path.resolve(projectRoot), absolutePath) || ".";
}
