import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import {
  appSettingsSchema,
  enqueueRequestSchema,
  idSchema,
  pathSchema,
  providerProfileSchema,
} from "../shared/schemas";
import { channels } from "../shared/channels";
import type { PreviewResult } from "../shared/types";
import { JsonStore } from "./store";
import { ProviderRepository } from "./providers";
import { RuntimeManager } from "./runtime-manager";
import { TaskManager } from "./task-manager";

export function registerIpc(options: {
  store: JsonStore;
  providers: ProviderRepository;
  runtime: RuntimeManager;
  tasks: TaskManager;
  previewFiles: Map<string, string>;
}): void {
  const { store, providers, runtime, tasks, previewFiles } = options;

  ipcMain.handle(channels.appVersion, () => app.getVersion());
  ipcMain.handle(channels.appOpenSource, async () => {
    await shell.openExternal("https://github.com/kd14125/zotero-pdf2zh");
  });
  ipcMain.handle(channels.appOpenLicense, () =>
    shell.openPath(
      app.isPackaged
        ? join(process.resourcesPath, "LICENSE.txt")
        : join(app.getAppPath(), "../LICENSE"),
    ),
  );
  ipcMain.handle(channels.settingsGet, () => store.getSettings());
  ipcMain.handle(channels.settingsSave, async (_event, input) => {
    const settings = appSettingsSchema.parse(input);
    return store.setSettings(settings);
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

  ipcMain.handle(channels.providersList, () => providers.list());
  ipcMain.handle(channels.providersSave, async (_event, input) =>
    providers.save(providerProfileSchema.parse(input)),
  );
  ipcMain.handle(channels.providersRemove, async (_event, input) =>
    providers.remove(idSchema.parse(input)),
  );
  ipcMain.handle(channels.providersTest, async (_event, input) =>
    providers.test(providerProfileSchema.parse(input)),
  );
  ipcMain.handle(channels.providersModels, async (_event, input) =>
    providers.listModels(providerProfileSchema.parse(input)),
  );

  ipcMain.handle(channels.runtimeState, () => runtime.getState());
  ipcMain.handle(channels.runtimeEnsure, () => runtime.ensureInstalled());
  ipcMain.handle(channels.runtimeCheckUpdate, () => runtime.checkForUpdate());
  ipcMain.handle(channels.runtimeUpdate, () => runtime.update());
  ipcMain.handle(channels.runtimeRollback, () => runtime.rollback());

  ipcMain.handle(channels.tasksList, () => tasks.list());
  ipcMain.handle(channels.tasksEnqueue, async (_event, input) =>
    tasks.enqueue(enqueueRequestSchema.parse(input)),
  );
  ipcMain.handle(channels.tasksCancel, async (_event, input) =>
    tasks.cancel(idSchema.parse(input)),
  );
  ipcMain.handle(channels.tasksRetry, async (_event, input) => tasks.retry(idSchema.parse(input)));
  ipcMain.handle(channels.tasksRemove, async (_event, input) =>
    tasks.remove(idSchema.parse(input)),
  );
  ipcMain.handle(channels.tasksClearHistory, () => tasks.clearHistory());

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

  runtime.on("changed", (state) => broadcast(channels.runtimeChanged, state));
  tasks.on("changed", (records) => broadcast(channels.tasksChanged, records));
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}
