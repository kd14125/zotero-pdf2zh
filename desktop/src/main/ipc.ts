import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { pathSchema } from "../shared/schemas";
import { channels } from "../shared/channels";
import type { PreviewResult, TaskRecord } from "../shared/types";
import { CodexIntegration } from "./codex-integration";
import { EngineClient } from "./engine-client";
import { UpdateManager } from "./update-manager";

export function registerIpc(options: {
  engine: EngineClient;
  codex: CodexIntegration;
  updates: UpdateManager;
  previewFiles: Map<string, string>;
}): void {
  const { engine, codex, updates, previewFiles } = options;

  ipcMain.handle(channels.appVersion, () => app.getVersion());
  ipcMain.handle(channels.appOpenSource, async () => {
    await shell.openExternal("https://github.com/kd14125/pdf2zh-desktop");
  });
  ipcMain.handle(channels.appOpenLicense, () =>
    shell.openPath(
      app.isPackaged
        ? join(process.resourcesPath, "LICENSE.txt")
        : join(app.getAppPath(), "../LICENSE"),
    ),
  );
  ipcMain.handle(channels.settingsGet, () => engine.request("settings.get"));
  ipcMain.handle(channels.settingsSave, (_event, input) => engine.request("settings.save", input));
  ipcMain.handle(channels.updateState, () => updates.getState());
  ipcMain.handle(channels.updateCheck, () => updates.check());
  ipcMain.handle(channels.updateDownload, () => updates.download());
  ipcMain.handle(channels.updateInstall, async () => {
    const tasks = await engine.request<TaskRecord[]>("tasks.list");
    if (tasks.some((task) => task.status === "queued" || task.status === "running")) {
      throw new Error("请先完成或取消正在运行的翻译任务");
    }
    await engine.request("engine.shutdown");
    return updates.install();
  });
  ipcMain.handle(channels.mcpState, () => codex.getState());
  ipcMain.handle(channels.mcpRegister, () => codex.register());
  ipcMain.handle(channels.mcpRemove, () => codex.remove());
  ipcMain.handle(channels.mcpCopyConfig, async () => {
    clipboard.writeText(codex.manualConfig());
    return codex.getState();
  });

  ipcMain.handle(channels.dialogPdfs, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择需要翻译的 PDF",
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "PDF 文档", extensions: ["pdf"] }],
    });
    return result.canceled ? [] : result.filePaths;
  });
  ipcMain.handle(channels.dialogOutput, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择翻译结果目录",
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? undefined : result.filePaths[0];
  });

  ipcMain.handle(channels.providersList, () => engine.request("providers.list"));
  ipcMain.handle(channels.providersSave, (_event, input) =>
    engine.request("providers.save", input),
  );
  ipcMain.handle(channels.providersRemove, (_event, input) =>
    engine.request("providers.remove", input),
  );
  ipcMain.handle(channels.providersTest, (_event, input) =>
    engine.request("providers.test", input),
  );
  ipcMain.handle(channels.providersModels, (_event, input) =>
    engine.request("providers.models", input),
  );
  ipcMain.handle(channels.mineruGet, () => engine.request("mineru.get"));
  ipcMain.handle(channels.mineruSave, (_event, input) => engine.request("mineru.save", input));
  ipcMain.handle(channels.mineruTest, (_event, input) => engine.request("mineru.test", input));
  ipcMain.handle(channels.mineruLatexState, () => engine.request("mineru.latex-state"));
  ipcMain.handle(channels.mineruLatexInstall, () => engine.request("mineru.latex-install"));

  ipcMain.handle(channels.runtimeState, () => engine.request("runtime.state"));
  ipcMain.handle(channels.runtimeEnsure, () => engine.request("runtime.ensure"));
  ipcMain.handle(channels.runtimeCheckUpdate, () => engine.request("runtime.check-update"));
  ipcMain.handle(channels.runtimeUpdate, () => engine.request("runtime.update"));
  ipcMain.handle(channels.runtimeRollback, () => engine.request("runtime.rollback"));

  ipcMain.handle(channels.tasksList, () => engine.request("tasks.list"));
  ipcMain.handle(channels.tasksEnqueue, (_event, input) => engine.request("tasks.enqueue", input));
  ipcMain.handle(channels.tasksCancel, (_event, input) => engine.request("tasks.cancel", input));
  ipcMain.handle(channels.tasksRetry, (_event, input) => engine.request("tasks.retry", input));
  ipcMain.handle(channels.tasksOptimizeFormulas, (_event, input) =>
    engine.request("tasks.optimize-formulas", input),
  );
  ipcMain.handle(channels.tasksRemove, (_event, input) => engine.request("tasks.remove", input));
  ipcMain.handle(channels.tasksClearHistory, () => engine.request("tasks.clear-history"));

  ipcMain.handle(channels.fileOpen, async (_event, input) => {
    const path = pathSchema.parse(input);
    return shell.openPath(path);
  });
  ipcMain.handle(channels.fileReveal, async (_event, input) => {
    shell.showItemInFolder(pathSchema.parse(input));
  });
  ipcMain.handle(channels.filePreview, async (_event, input): Promise<PreviewResult> => {
    const path = pathSchema.parse(input);
    if (extname(path).toLowerCase() !== ".pdf") throw new Error("仅支持预览 PDF 文件");
    const token = randomUUID();
    previewFiles.set(token, path);
    return { url: `pdf2zh-file://preview/${token}`, name: path.split(/[\\/]/).at(-1) || "PDF" };
  });

  engine.onEvent("runtime.changed", (state) => broadcast(channels.runtimeChanged, state));
  engine.onEvent("tasks.changed", (records) => broadcast(channels.tasksChanged, records));
  updates.on("changed", (state) => broadcast(channels.updateChanged, state));
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}
