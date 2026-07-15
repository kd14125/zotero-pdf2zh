import { EventEmitter } from "node:events";
import type { AppUpdateState } from "../shared/types";

export interface UpdateAdapter extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

interface UpdateInfoLike {
  version?: string;
}

interface DownloadProgressLike {
  percent?: number;
}

export class UpdateManager extends EventEmitter {
  private state: AppUpdateState;

  constructor(
    private readonly updater: UpdateAdapter,
    private readonly supported: boolean,
    currentVersion: string,
  ) {
    super();
    this.state = {
      status: supported ? "idle" : "unsupported",
      currentVersion,
      progress: 0,
      message: supported ? "可手动检查新版本" : "仅安装后的 Windows 应用支持自动更新",
    };
    if (!supported) return;
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
    updater.allowPrerelease = false;
    this.bindEvents();
  }

  getState(): AppUpdateState {
    return structuredClone(this.state);
  }

  async check(): Promise<AppUpdateState> {
    if (!this.supported) return this.getState();
    if (this.state.status === "checking" || this.state.status === "downloading") {
      return this.getState();
    }
    this.update({
      status: "checking",
      progress: 0,
      availableVersion: undefined,
      error: undefined,
      message: "正在检查更新",
    });
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  async download(): Promise<AppUpdateState> {
    if (!this.supported || this.state.status !== "available") return this.getState();
    this.update({ status: "downloading", progress: 0, error: undefined, message: "正在下载更新" });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      this.fail(error);
    }
    return this.getState();
  }

  install(): AppUpdateState {
    if (!this.supported || this.state.status !== "downloaded") return this.getState();
    this.update({ status: "installing", message: "正在重启并安装更新" });
    this.updater.quitAndInstall(false, true);
    return this.getState();
  }

  private bindEvents(): void {
    this.updater.on("update-available", (info: UpdateInfoLike) => {
      const version = info.version || "新版本";
      this.update({
        status: "available",
        availableVersion: version,
        progress: 0,
        error: undefined,
        message: `发现新版本 v${version}`,
      });
    });
    this.updater.on("update-not-available", () => {
      this.update({
        status: "up-to-date",
        availableVersion: undefined,
        progress: 0,
        error: undefined,
        message: "当前已是最新版本",
      });
    });
    this.updater.on("download-progress", (progress: DownloadProgressLike) => {
      const percent = Math.max(0, Math.min(100, Math.round(progress.percent || 0)));
      this.update({
        status: "downloading",
        progress: percent,
        message: `正在下载更新 ${percent}%`,
      });
    });
    this.updater.on("update-downloaded", (info: UpdateInfoLike) => {
      this.update({
        status: "downloaded",
        availableVersion: info.version || this.state.availableVersion,
        progress: 100,
        error: undefined,
        message: "更新已下载，重启应用即可安装",
      });
    });
    this.updater.on("error", (error: Error) => this.fail(error));
  }

  private fail(error: unknown): void {
    const message = error instanceof Error ? error.message : "未知错误";
    this.update({ status: "error", error: message, message: `更新失败：${message}` });
  }

  private update(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.emit("changed", this.getState());
  }
}
