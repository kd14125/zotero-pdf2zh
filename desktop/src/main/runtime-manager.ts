import { app } from "electron";
import { EventEmitter } from "node:events";
import {
  access,
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import extract from "extract-zip";
import type { AppSettings, RuntimeManifest, RuntimeState } from "../shared/types";
import { resolveRuntimeRoot, sha256File } from "./file-utils";

const REMOTE_MANIFEST_URL =
  "https://raw.githubusercontent.com/kd14125/zotero-pdf2zh/main/desktop/runtime-manifest.json";

export class RuntimeManager extends EventEmitter {
  private manifest!: RuntimeManifest;
  private state!: RuntimeState;
  private operation?: Promise<RuntimeState>;
  private readonly runtimeRoot: string;
  private readonly legacyRuntimeRoot: string;

  constructor(private readonly getSettings: () => AppSettings) {
    super();
    this.legacyRuntimeRoot = join(app.getPath("userData"), "runtime");
    this.runtimeRoot = resolveRuntimeRoot(process.env.LOCALAPPDATA, app.getPath("userData"));
  }

  async initialize(): Promise<void> {
    this.manifest = JSON.parse(await readFile(this.manifestPath(), "utf8")) as RuntimeManifest;
    this.state = {
      status: "missing",
      version: this.manifest.version,
      progress: 0,
      downloadedBytes: 0,
      totalBytes: this.manifest.size,
    };
    await this.migrateLegacyRuntime();
    await mkdir(this.runtimeRoot, { recursive: true });
    await this.refreshInstalledState();
  }

  getManifest(): RuntimeManifest {
    return structuredClone(this.manifest);
  }

  getState(): RuntimeState {
    return structuredClone(this.state);
  }

  getBinaryPath(): string {
    if (this.state.status !== "ready" || !this.state.binaryPath) {
      throw new Error("PDF2ZH 运行时尚未安装完成");
    }
    return this.state.binaryPath;
  }

  ensureInstalled(force = false): Promise<RuntimeState> {
    if (!force && this.state.status === "ready") return Promise.resolve(this.getState());
    if (this.operation) return this.operation;
    this.operation = this.install(this.manifest).finally(() => {
      this.operation = undefined;
    });
    return this.operation;
  }

  async checkForUpdate(): Promise<RuntimeState> {
    try {
      const response = await fetch(REMOTE_MANIFEST_URL, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const remote = (await response.json()) as RuntimeManifest;
      this.state.updateAvailable = remote.version !== this.state.installedVersion;
      if (this.state.updateAvailable) this.manifest = remote;
      this.state.version = this.manifest.version;
      this.emitState();
      return this.getState();
    } catch (error) {
      this.state.error = `检查更新失败：${error instanceof Error ? error.message : String(error)}`;
      this.emitState();
      return this.getState();
    }
  }

  async update(): Promise<RuntimeState> {
    return this.ensureInstalled(true);
  }

  async rollback(): Promise<RuntimeState> {
    const versions = await this.installedVersions();
    const current = this.state.installedVersion;
    const previous = versions.find((version) => version !== current);
    if (!previous) throw new Error("没有可回滚的运行时版本");
    await writeFile(
      join(this.runtimeRoot, "current.json"),
      JSON.stringify({ version: previous }),
      "utf8",
    );
    await this.refreshInstalledState();
    return this.getState();
  }

  private async install(manifest: RuntimeManifest): Promise<RuntimeState> {
    const versionDir = join(this.runtimeRoot, manifest.version);
    const archivePath = join(this.runtimeRoot, manifest.fileName);
    const stagingDir = `${versionDir}.extracting`;
    try {
      await mkdir(this.runtimeRoot, { recursive: true });
      await this.download(manifest, archivePath);
      this.updateState({ status: "verifying", progress: 100, error: undefined });
      const digest = await sha256File(archivePath);
      if (manifest.sha256 === "PENDING_VERIFICATION" || digest !== manifest.sha256.toLowerCase()) {
        await rm(archivePath, { force: true });
        throw new Error(`运行时校验失败，实际 SHA-256：${digest}`);
      }
      this.updateState({ status: "extracting", progress: 0 });
      await rm(stagingDir, { recursive: true, force: true });
      await mkdir(stagingDir, { recursive: true });
      await extract(archivePath, { dir: stagingDir });
      const binary = await findFile(stagingDir, "pdf2zh.exe");
      if (!binary) throw new Error("压缩包中未找到 pdf2zh.exe");
      await rm(versionDir, { recursive: true, force: true });
      await rename(stagingDir, versionDir);
      const installedBinary = join(versionDir, relative(stagingDir, binary));
      const oldVersion = this.state.installedVersion;
      await writeFile(
        join(versionDir, "installed.json"),
        JSON.stringify(
          {
            manifest,
            binary: relative(versionDir, installedBinary),
            installedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf8",
      );
      await writeFile(
        join(this.runtimeRoot, "current.json"),
        JSON.stringify({ version: manifest.version }),
        "utf8",
      );
      await rm(archivePath, { force: true });
      this.state = {
        status: "ready",
        version: manifest.version,
        installedVersion: manifest.version,
        previousVersion:
          oldVersion && oldVersion !== manifest.version ? oldVersion : this.state.previousVersion,
        progress: 100,
        downloadedBytes: manifest.size,
        totalBytes: manifest.size,
        binaryPath: installedBinary,
        updateAvailable: false,
      };
      this.emitState();
      return this.getState();
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      this.updateState({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async download(manifest: RuntimeManifest, archivePath: string): Promise<void> {
    const existing = await fileSize(archivePath);
    const customUrl = this.getSettings().runtimeMirrorUrl.trim();
    const url = customUrl || manifest.url;
    this.updateState({
      status: "downloading",
      progress: Math.floor((existing / manifest.size) * 100),
      downloadedBytes: existing,
      totalBytes: manifest.size,
      error: undefined,
    });
    const response = await fetch(url, {
      headers: existing > 0 ? { Range: `bytes=${existing}-` } : {},
      signal: AbortSignal.timeout(30 * 60 * 1000),
    });
    if (!response.ok && response.status !== 206)
      throw new Error(`下载失败：HTTP ${response.status}`);
    if (!response.body) throw new Error("下载响应为空");
    const append = existing > 0 && response.status === 206;
    const handle = await open(archivePath, append ? "a" : "w", 0o600);
    let received = append ? existing : 0;
    try {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await handle.write(value);
        received += value.byteLength;
        this.updateState({
          downloadedBytes: received,
          progress: Math.min(99, Math.floor((received / manifest.size) * 100)),
        });
      }
    } finally {
      await handle.close();
    }
  }

  private async refreshInstalledState(): Promise<void> {
    try {
      const current = JSON.parse(
        await readFile(join(this.runtimeRoot, "current.json"), "utf8"),
      ) as {
        version: string;
      };
      const versionDir = join(this.runtimeRoot, current.version);
      const installed = JSON.parse(await readFile(join(versionDir, "installed.json"), "utf8")) as {
        binary: string;
      };
      const binaryPath = join(versionDir, installed.binary);
      await access(binaryPath);
      const versions = await this.installedVersions();
      this.state = {
        ...this.state,
        status: "ready",
        installedVersion: current.version,
        previousVersion: versions.find((version) => version !== current.version),
        progress: 100,
        downloadedBytes: this.manifest.size,
        binaryPath,
      };
    } catch {
      this.state.status = "missing";
    }
    this.emitState();
  }

  private async installedVersions(): Promise<string[]> {
    try {
      const entries = await readdir(this.runtimeRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".extracting"))
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      return [];
    }
  }

  private async migrateLegacyRuntime(): Promise<void> {
    if (this.runtimeRoot === this.legacyRuntimeRoot) return;
    if (await pathExists(join(this.runtimeRoot, "current.json"))) return;
    if (!(await pathExists(join(this.legacyRuntimeRoot, "current.json")))) return;
    await mkdir(dirname(this.runtimeRoot), { recursive: true });
    try {
      await rename(this.legacyRuntimeRoot, this.runtimeRoot);
    } catch {
      await cp(this.legacyRuntimeRoot, this.runtimeRoot, { recursive: true });
      await rm(this.legacyRuntimeRoot, { recursive: true, force: true });
    }
  }

  private updateState(patch: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...patch };
    this.emitState();
  }

  private emitState(): void {
    this.emit("changed", this.getState());
  }

  private manifestPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, "runtime-manifest.json")
      : join(app.getAppPath(), "runtime-manifest.json");
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findFile(root: string, name: string): Promise<string | undefined> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && basename(entry.name).toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const nested = await findFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}
