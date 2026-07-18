import { app } from "electron";
import { rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  ENGINE_PROTOCOL_VERSION,
  engineRequestSchema,
  type EngineEventName,
  type EngineRequest,
} from "../shared/engine-protocol";
import {
  appSettingsSchema,
  enqueueRequestSchema,
  idSchema,
  mineruConfigSchema,
  providerProfileSchema,
} from "../shared/schemas";
import type { EngineStatus, TaskRecord } from "../shared/types";
import { CredentialStore } from "./credentials";
import { ensureEngineToken, resolveEngineIdentity } from "./engine-common";
import { ProviderRepository } from "./providers";
import { RuntimeManager } from "./runtime-manager";
import { JsonStore } from "./store";
import { TaskManager } from "./task-manager";
import { MineruManager } from "./mineru";

const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

export class EngineServer {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  private idleTimer?: NodeJS.Timeout;
  private token = "";
  private store!: JsonStore;
  private providers!: ProviderRepository;
  private runtime!: RuntimeManager;
  private mineru!: MineruManager;
  private tasks!: TaskManager;

  async start(): Promise<void> {
    const userDataPath = app.getPath("userData");
    this.token = await ensureEngineToken(userDataPath);
    this.store = new JsonStore();
    const credentials = new CredentialStore();
    await Promise.all([this.store.load(), credentials.load()]);
    this.providers = new ProviderRepository(this.store, credentials);
    this.runtime = new RuntimeManager(() => this.store.getSettings());
    this.mineru = new MineruManager(this.store, credentials);
    await this.runtime.initialize();
    await rm(join(app.getPath("temp"), "pdf2zh-desktop"), { recursive: true, force: true });
    this.tasks = new TaskManager(this.store, this.providers, this.runtime, this.mineru);
    this.runtime.on("changed", (state) => this.broadcast("runtime.changed", state));
    this.tasks.on("changed", (records) => {
      this.broadcast("tasks.changed", records);
      this.scheduleIdleShutdown();
    });

    this.server = createServer((socket) => this.accept(socket));
    await listen(this.server, resolveEngineIdentity(userDataPath).pipeName);
    this.scheduleIdleShutdown();
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.tasks?.shutdown();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.handleLine(socket, line);
      }
    });
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.scheduleIdleShutdown();
    });
    socket.on("error", () => {
      // Close handles cleanup.
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: EngineRequest | undefined;
    try {
      request = engineRequestSchema.parse(JSON.parse(line));
      if (request.token !== this.token) throw new Error("翻译引擎握手失败");
      const result = await this.dispatch(request);
      socket.write(
        `${JSON.stringify({ version: ENGINE_PROTOCOL_VERSION, id: request.id, ok: true, result })}\n`,
      );
      if (request.method === "engine.shutdown") setTimeout(() => app.quit(), 20);
    } catch (error) {
      const id = request?.id || "invalid";
      socket.write(
        `${JSON.stringify({
          version: ENGINE_PROTOCOL_VERSION,
          id,
          ok: false,
          error: error instanceof Error ? error.message : "翻译引擎请求失败",
        })}\n`,
      );
    }
  }

  private async dispatch(request: EngineRequest): Promise<unknown> {
    switch (request.method) {
      case "engine.status":
        return this.status();
      case "engine.shutdown":
        if (this.activeTasks().length) throw new Error("仍有翻译任务运行，暂时不能关闭引擎");
        return { ok: true };
      case "settings.get":
        return this.store.getSettings();
      case "settings.save":
        return this.store.setSettings(appSettingsSchema.parse(request.params));
      case "providers.list":
        return this.providers.list();
      case "providers.save":
        return this.providers.save(providerProfileSchema.parse(request.params));
      case "providers.remove":
        return this.providers.remove(idSchema.parse(request.params));
      case "providers.test":
        return this.providers.test(providerProfileSchema.parse(request.params));
      case "providers.models":
        return this.providers.listModels(providerProfileSchema.parse(request.params));
      case "mineru.get":
        return this.mineru.getConfig();
      case "mineru.save":
        return this.mineru.saveConfig(mineruConfigSchema.parse(request.params));
      case "mineru.test":
        return this.mineru.test(mineruConfigSchema.parse(request.params));
      case "runtime.state":
        return this.runtime.getState();
      case "runtime.ensure":
        return this.runtime.ensureInstalled();
      case "runtime.check-update":
        return this.runtime.checkForUpdate();
      case "runtime.update":
        return this.runtime.update();
      case "runtime.rollback":
        return this.runtime.rollback();
      case "tasks.list":
        return this.tasks.list();
      case "tasks.enqueue":
        return this.tasks.enqueue(enqueueRequestSchema.parse(request.params));
      case "tasks.cancel":
        return this.tasks.cancel(idSchema.parse(request.params));
      case "tasks.retry":
        return this.tasks.retry(idSchema.parse(request.params));
      case "tasks.optimize-formulas":
        return this.tasks.optimizeFormulas(idSchema.parse(request.params));
      case "tasks.remove":
        return this.tasks.remove(idSchema.parse(request.params));
      case "tasks.clear-history":
        return this.tasks.clearHistory();
    }
  }

  private status(): EngineStatus {
    return {
      connected: true,
      version: app.getVersion(),
      pid: process.pid,
      activeTaskCount: this.activeTasks().length,
      runtime: this.runtime.getState(),
    };
  }

  private activeTasks(): TaskRecord[] {
    return this.tasks
      .list()
      .filter((task) => task.status === "queued" || task.status === "running");
  }

  private broadcast(event: EngineEventName, payload: unknown): void {
    const line = `${JSON.stringify({ version: ENGINE_PROTOCOL_VERSION, event, payload })}\n`;
    for (const socket of this.sockets) {
      if (!socket.destroyed) socket.write(line);
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.sockets.size || this.activeTasks().length) return;
    const configured = Number(process.env.PDF2ZH_ENGINE_IDLE_TIMEOUT_MS);
    const timeout =
      Number.isFinite(configured) && configured >= 1000 ? configured : DEFAULT_IDLE_TIMEOUT_MS;
    this.idleTimer = setTimeout(() => app.quit(), timeout);
  }
}

function listen(server: Server, pipeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipeName, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
