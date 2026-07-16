import { execFile } from "node:child_process";
import { access, copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { McpIntegrationState } from "../shared/types";

const execFileAsync = promisify(execFile);
const SERVER_NAME = "pdf2zh-desktop";

export class CodexIntegration {
  constructor(
    private readonly mcpDirectory: string,
    private readonly homePath: string,
  ) {}

  async getState(): Promise<McpIntegrationState> {
    const paths = this.paths();
    const available = await filesExist(paths.command, paths.script);
    const codex = await findCodexExecutable();
    if (!available) {
      return {
        available: false,
        codexAvailable: Boolean(codex),
        registered: false,
        args: [paths.script],
        message: "MCP 组件尚未生成，请使用安装版或先完成本地打包",
      };
    }
    if (!codex) {
      return {
        available: true,
        codexAvailable: false,
        registered: false,
        command: paths.command,
        args: [paths.script],
        message: "未检测到 Codex，可复制配置后手动接入",
      };
    }
    const current = await runCodex(codex, ["mcp", "get", SERVER_NAME], true);
    const currentPath = normalize(current.output).includes(normalize(paths.command));
    const registered = current.ok && currentPath;
    return {
      available: true,
      codexAvailable: true,
      registered,
      command: paths.command,
      args: [paths.script],
      message: registered
        ? "已接入 Codex，可以直接调用 PDF2ZH 工具"
        : current.ok
          ? "Codex 中存在旧的 PDF2ZH MCP 路径，请重新接入"
          : "MCP 组件已就绪，尚未接入 Codex",
    };
  }

  async register(): Promise<McpIntegrationState> {
    const state = await this.getState();
    if (!state.available || !state.command) throw new Error(state.message);
    const codex = await findCodexExecutable();
    if (!codex) throw new Error("未检测到 codex.exe");
    const configDirectory = join(this.homePath, ".codex");
    const configPath = join(configDirectory, "config.toml");
    const backupPath = join(configDirectory, "config.toml.pdf2zh-backup");
    await mkdir(configDirectory, { recursive: true });
    let backedUp = false;
    try {
      await access(configPath);
      await copyFile(configPath, backupPath);
      backedUp = true;
    } catch {
      // A new Codex config does not need a backup.
    }
    try {
      const current = await runCodex(codex, ["mcp", "get", SERVER_NAME], true);
      if (current.ok) await runCodexOrThrow(codex, ["mcp", "remove", SERVER_NAME]);
      await runCodexOrThrow(codex, ["mcp", "add", SERVER_NAME, "--", state.command, ...state.args]);
    } catch (error) {
      if (backedUp) await copyFile(backupPath, configPath);
      throw error;
    }
    return this.getState();
  }

  async remove(): Promise<McpIntegrationState> {
    const codex = await findCodexExecutable();
    if (!codex) throw new Error("未检测到 codex.exe");
    const current = await runCodex(codex, ["mcp", "get", SERVER_NAME], true);
    if (current.ok) await runCodexOrThrow(codex, ["mcp", "remove", SERVER_NAME]);
    return this.getState();
  }

  manualConfig(): string {
    const paths = this.paths();
    return [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(paths.command)}`,
      `args = [${tomlString(paths.script)}]`,
      "enabled = true",
    ].join("\n");
  }

  private paths(): { command: string; script: string } {
    return {
      command: resolve(this.mcpDirectory, "pdf2zh-mcp.exe"),
      script: resolve(this.mcpDirectory, "server.cjs"),
    };
  }
}

async function findCodexExecutable(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("where.exe", ["codex.exe"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
  } catch {
    return undefined;
  }
}

async function runCodex(
  executable: string,
  args: string[],
  allowFailure: boolean,
): Promise<{ ok: boolean; output: string }> {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    });
    return { ok: true, output: `${result.stdout}\n${result.stderr}`.trim() };
  } catch (error) {
    if (!allowFailure) throw error;
    const candidate = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${candidate.stdout || ""}\n${candidate.stderr || ""}`.trim() };
  }
}

async function runCodexOrThrow(executable: string, args: string[]): Promise<void> {
  const result = await runCodex(executable, args, false);
  if (!result.ok) throw new Error(result.output || "Codex MCP 配置失败");
}

async function filesExist(...paths: string[]): Promise<boolean> {
  try {
    await Promise.all(paths.map((path) => access(path)));
    return true;
  } catch {
    return false;
  }
}

function tomlString(value: string): string {
  return JSON.stringify(value.replaceAll("\\", "/"));
}

function normalize(value: string): string {
  return value.replaceAll("\\", "/").toLowerCase();
}
