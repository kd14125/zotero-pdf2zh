import { contextBridge, ipcRenderer, webUtils } from "electron";
import { channels } from "../shared/channels";
import type { AppUpdateState, DesktopApi, RuntimeState, TaskRecord } from "../shared/types";

const api: DesktopApi = {
  app: {
    getVersion: () => ipcRenderer.invoke(channels.appVersion),
    getSettings: () => ipcRenderer.invoke(channels.settingsGet),
    saveSettings: (settings) => ipcRenderer.invoke(channels.settingsSave, settings),
    openSource: () => ipcRenderer.invoke(channels.appOpenSource),
    openLicense: () => ipcRenderer.invoke(channels.appOpenLicense),
  },
  updates: {
    getState: () => ipcRenderer.invoke(channels.updateState),
    check: () => ipcRenderer.invoke(channels.updateCheck),
    download: () => ipcRenderer.invoke(channels.updateDownload),
    install: () => ipcRenderer.invoke(channels.updateInstall),
    onState: (listener) => subscribe<AppUpdateState>(channels.updateChanged, listener),
  },
  mcp: {
    getState: () => ipcRenderer.invoke(channels.mcpState),
    registerCodex: () => ipcRenderer.invoke(channels.mcpRegister),
    removeCodex: () => ipcRenderer.invoke(channels.mcpRemove),
    copyManualConfig: () => ipcRenderer.invoke(channels.mcpCopyConfig),
  },
  dialog: {
    pickPdfs: () => ipcRenderer.invoke(channels.dialogPdfs),
    pickOutputDirectory: () => ipcRenderer.invoke(channels.dialogOutput),
  },
  providers: {
    list: () => ipcRenderer.invoke(channels.providersList),
    save: (profile) => ipcRenderer.invoke(channels.providersSave, profile),
    remove: (id) => ipcRenderer.invoke(channels.providersRemove, id),
    test: (profile) => ipcRenderer.invoke(channels.providersTest, profile),
    listModels: (profile) => ipcRenderer.invoke(channels.providersModels, profile),
  },
  mineru: {
    getConfig: () => ipcRenderer.invoke(channels.mineruGet),
    saveConfig: (config) => ipcRenderer.invoke(channels.mineruSave, config),
    test: (config) => ipcRenderer.invoke(channels.mineruTest, config),
  },
  runtime: {
    getState: () => ipcRenderer.invoke(channels.runtimeState),
    ensure: () => ipcRenderer.invoke(channels.runtimeEnsure),
    checkUpdate: () => ipcRenderer.invoke(channels.runtimeCheckUpdate),
    update: () => ipcRenderer.invoke(channels.runtimeUpdate),
    rollback: () => ipcRenderer.invoke(channels.runtimeRollback),
    onState: (listener) => subscribe<RuntimeState>(channels.runtimeChanged, listener),
  },
  tasks: {
    list: () => ipcRenderer.invoke(channels.tasksList),
    enqueue: (request) => ipcRenderer.invoke(channels.tasksEnqueue, request),
    cancel: (id) => ipcRenderer.invoke(channels.tasksCancel, id),
    retry: (id) => ipcRenderer.invoke(channels.tasksRetry, id),
    optimizeFormulas: (id) => ipcRenderer.invoke(channels.tasksOptimizeFormulas, id),
    remove: (id) => ipcRenderer.invoke(channels.tasksRemove, id),
    clearHistory: () => ipcRenderer.invoke(channels.tasksClearHistory),
    onChanged: (listener) => subscribe<TaskRecord[]>(channels.tasksChanged, listener),
  },
  files: {
    pathsFromDrop: (files) => files.map((file) => webUtils.getPathForFile(file)).filter(Boolean),
    open: (path) => ipcRenderer.invoke(channels.fileOpen, path),
    reveal: (path) => ipcRenderer.invoke(channels.fileReveal, path),
    preview: (path) => ipcRenderer.invoke(channels.filePreview, path),
  },
};

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("pdf2zh", api);
