import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { AlfredPaths } from "./paths.js";

export const DEFAULT_SERVICE_LABEL = "com.alfred.agent";

const execFileAsync = promisify(execFile);

export interface ServiceCommandResult {
  action: "install" | "status" | "restart" | "uninstall";
  label: string;
  plistPath: string;
  installed: boolean;
  running: boolean | null;
  message: string;
}

export interface ServiceManagerOptions {
  paths: AlfredPaths;
  entryPath: string;
  execArguments?: string[];
  platform?: NodeJS.Platform;
  uid?: number;
  launchAgentsDir?: string;
  run?: (file: string, args: string[]) => Promise<{ stdout?: string; stderr?: string }>;
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function stringNode(value: string): string {
  return `    <string>${xml(value)}</string>`;
}

export function renderLaunchAgent(options: {
  label?: string;
  alfredHome: string;
  nodePath: string;
  entryPath: string;
  execArguments?: string[];
  stdoutPath: string;
  stderrPath: string;
}): string {
  const label = options.label ?? DEFAULT_SERVICE_LABEL;
  const argumentsList = [options.nodePath, ...(options.execArguments ?? []), options.entryPath, "start"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsList.map(stringNode).join("\n")}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ALFRED_HOME</key>
    <string>${xml(options.alfredHome)}</string>
    <key>ALFRED_PACKAGE_MODE</key>
    <string>true</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.stderrPath)}</string>
</dict>
</plist>
`;
}

export class MacServiceManager {
  readonly label = DEFAULT_SERVICE_LABEL;
  readonly domain: string;
  readonly plistPath: string;
  private readonly platform: NodeJS.Platform;
  private readonly runCommand: NonNullable<ServiceManagerOptions["run"]>;

  constructor(private readonly options: ServiceManagerOptions) {
    this.platform = options.platform ?? process.platform;
    const uid = options.uid ?? process.getuid?.();
    if (uid === undefined) throw new Error("Unable to determine the current user id");
    this.domain = `gui/${uid}`;
    this.plistPath = path.join(options.launchAgentsDir ?? path.join(os.homedir(), "Library", "LaunchAgents"), `${this.label}.plist`);
    this.runCommand = options.run ?? (async (file, args) => execFileAsync(file, args));
  }

  private assertMacOs(): void {
    if (this.platform !== "darwin") throw new Error("Background service management currently supports macOS only");
  }

  private async launchctl(args: string[]): Promise<{ stdout?: string; stderr?: string }> {
    return this.runCommand("launchctl", args);
  }

  private async isInstalled(): Promise<boolean> {
    return readFile(this.plistPath, "utf8").then(() => true).catch(() => false);
  }

  private async isRunning(): Promise<boolean> {
    return this.launchctl(["print", `${this.domain}/${this.label}`]).then(() => true).catch(() => false);
  }

  async install(): Promise<ServiceCommandResult> {
    this.assertMacOs();
    await mkdir(path.dirname(this.plistPath), { recursive: true, mode: 0o700 });
    await mkdir(this.options.paths.logsDir, { recursive: true, mode: 0o700 });
    const content = renderLaunchAgent({
      label: this.label,
      alfredHome: this.options.paths.alfredHome,
      nodePath: process.execPath,
      entryPath: path.resolve(this.options.entryPath),
      execArguments: this.options.execArguments,
      stdoutPath: path.join(this.options.paths.logsDir, "service.stdout.log"),
      stderrPath: path.join(this.options.paths.logsDir, "service.stderr.log")
    });
    const temporaryPlist = `${this.plistPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPlist, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await this.runCommand("plutil", ["-lint", temporaryPlist]);
      await rename(temporaryPlist, this.plistPath);
    } finally {
      await rm(temporaryPlist, { force: true });
    }
    if (await this.isRunning()) await this.launchctl(["bootout", `${this.domain}/${this.label}`]);
    await this.launchctl(["bootstrap", this.domain, this.plistPath]);
    return {
      action: "install",
      label: this.label,
      plistPath: this.plistPath,
      installed: true,
      running: true,
      message: "LaunchAgent installed and started"
    };
  }

  async status(): Promise<ServiceCommandResult> {
    this.assertMacOs();
    const installed = await this.isInstalled();
    const running = await this.isRunning();
    return {
      action: "status",
      label: this.label,
      plistPath: this.plistPath,
      installed,
      running,
      message: running ? "LaunchAgent is running" : installed ? "LaunchAgent is installed but not running" : "LaunchAgent is not installed"
    };
  }

  async restart(): Promise<ServiceCommandResult> {
    this.assertMacOs();
    if (!(await this.isInstalled())) throw new Error("Alfred service is not installed; run alfred service install first");
    await this.launchctl(["kickstart", "-k", `${this.domain}/${this.label}`]);
    return {
      action: "restart",
      label: this.label,
      plistPath: this.plistPath,
      installed: true,
      running: true,
      message: "LaunchAgent restarted"
    };
  }

  async uninstall(): Promise<ServiceCommandResult> {
    this.assertMacOs();
    if (await this.isRunning()) await this.launchctl(["bootout", `${this.domain}/${this.label}`]);
    await rm(this.plistPath, { force: true });
    return {
      action: "uninstall",
      label: this.label,
      plistPath: this.plistPath,
      installed: false,
      running: false,
      message: "LaunchAgent stopped and removed; Alfred home was preserved"
    };
  }
}
