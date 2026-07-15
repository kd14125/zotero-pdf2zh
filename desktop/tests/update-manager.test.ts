import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { UpdateManager, type UpdateAdapter } from "../src/main/update-manager";

class FakeUpdater extends EventEmitter implements UpdateAdapter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  checkForUpdates = vi.fn(async () => undefined);
  downloadUpdate = vi.fn(async () => []);
  quitAndInstall = vi.fn();
}

describe("UpdateManager", () => {
  it("checks, downloads and installs an available update", async () => {
    const updater = new FakeUpdater();
    const manager = new UpdateManager(updater, true, "0.2.0");
    const states: string[] = [];
    manager.on("changed", (state) => states.push(state.status));

    const checking = manager.check();
    updater.emit("update-available", { version: "0.2.1" });
    await checking;

    expect(manager.getState()).toMatchObject({
      status: "available",
      currentVersion: "0.2.0",
      availableVersion: "0.2.1",
    });
    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);

    const downloading = manager.download();
    updater.emit("download-progress", { percent: 48.6 });
    updater.emit("update-downloaded", { version: "0.2.1" });
    await downloading;

    expect(manager.getState()).toMatchObject({ status: "downloaded", progress: 100 });
    expect(states).toContain("downloading");
    expect(states).toContain("downloaded");

    manager.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it("reports when the installed version is current", async () => {
    const updater = new FakeUpdater();
    const manager = new UpdateManager(updater, true, "0.2.0");

    const checking = manager.check();
    updater.emit("update-not-available", { version: "0.2.0" });
    await checking;

    expect(manager.getState()).toMatchObject({ status: "up-to-date", progress: 0 });
  });

  it("does not call the updater outside a packaged Windows build", async () => {
    const updater = new FakeUpdater();
    const manager = new UpdateManager(updater, false, "0.2.0");

    await manager.check();

    expect(manager.getState().status).toBe("unsupported");
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });
});
