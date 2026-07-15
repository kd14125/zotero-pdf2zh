import { app, BrowserWindow, net, protocol } from "electron";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CredentialStore } from "./credentials";
import { registerIpc } from "./ipc";
import { ProviderRepository } from "./providers";
import { RuntimeManager } from "./runtime-manager";
import { JsonStore } from "./store";
import { TaskManager } from "./task-manager";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pdf2zh-file",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

let mainWindow: BrowserWindow | undefined;
let taskManager: TaskManager | undefined;

async function bootstrap(): Promise<void> {
  const previewFiles = new Map<string, string>();
  const store = new JsonStore();
  const credentials = new CredentialStore();
  await Promise.all([store.load(), credentials.load()]);
  const providers = new ProviderRepository(store, credentials);
  const runtime = new RuntimeManager(() => store.getSettings());
  await runtime.initialize();
  await rm(join(app.getPath("temp"), "pdf2zh-desktop"), { recursive: true, force: true });
  taskManager = new TaskManager(store, providers, runtime);
  registerIpc({ store, providers, runtime, tasks: taskManager, previewFiles });

  protocol.handle("pdf2zh-file", (request) => {
    const url = new URL(request.url);
    const token = url.pathname.replace(/^\//, "");
    if (url.hostname !== "preview" || !previewFiles.has(token))
      return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(previewFiles.get(token)!).toString());
  });

  createWindow();
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#f5f6f8",
    title: "PDF2ZH Desktop",
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://"))
      void import("electron").then(({ shell }) => shell.openExternal(url));
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();
else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    app.setAppUserModelId("com.kd14125.pdf2zh.desktop");
    void bootstrap();
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => taskManager?.shutdown());
