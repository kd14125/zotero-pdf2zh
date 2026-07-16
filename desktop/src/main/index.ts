import { app, BrowserWindow, net, protocol } from "electron";
import updaterPackage from "electron-updater";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CodexIntegration } from "./codex-integration";
import { EngineClient } from "./engine-client";
import { EngineServer } from "./engine-server";
import { registerIpc } from "./ipc";
import { UpdateManager } from "./update-manager";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "pdf2zh-file",
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

const engineMode = process.argv.includes("--engine");
const { autoUpdater } = updaterPackage;
let mainWindow: BrowserWindow | undefined;
let engineClient: EngineClient | undefined;
let engineServer: EngineServer | undefined;

async function bootstrapDesktop(): Promise<void> {
  const previewFiles = new Map<string, string>();
  const userDataPath = app.getPath("userData");
  const userDataArgument = `--user-data-dir=${userDataPath}`;
  const spawnArgs = process.defaultApp
    ? [app.getAppPath(), "--engine", userDataArgument]
    : ["--engine", userDataArgument];
  engineClient = new EngineClient({
    userDataPath,
    spawnCommand: process.execPath,
    spawnArgs,
  });
  await engineClient.connect();
  const updates = new UpdateManager(
    autoUpdater,
    app.isPackaged && process.platform === "win32",
    app.getVersion(),
  );
  const mcpDirectory = app.isPackaged
    ? join(process.resourcesPath, "mcp")
    : join(app.getAppPath(), "build", "mcp");
  const codex = new CodexIntegration(mcpDirectory, app.getPath("home"));
  registerIpc({ engine: engineClient, codex, updates, previewFiles });

  protocol.handle("pdf2zh-file", (request) => {
    const url = new URL(request.url);
    const token = url.pathname.replace(/^\//, "");
    if (url.hostname !== "preview" || !previewFiles.has(token)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(previewFiles.get(token)!).toString());
  });

  createWindow();
}

async function bootstrapEngine(): Promise<void> {
  engineServer = new EngineServer();
  try {
    await engineServer.start();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    app.quit();
  }
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
    if (url.startsWith("https://")) {
      void import("electron").then(({ shell }) => shell.openExternal(url));
    }
    return { action: "deny" };
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

if (engineMode) {
  app.whenReady().then(() => {
    app.setAppUserModelId("com.kd14125.pdf2zh.desktop.engine");
    void bootstrapEngine();
  });
} else {
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
      void bootstrapDesktop();
    });
  }
}

app.on("window-all-closed", () => {
  if (!engineMode) app.quit();
});
app.on("before-quit", () => {
  engineClient?.close();
  engineServer?.stop();
});
