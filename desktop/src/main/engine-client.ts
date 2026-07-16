import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import {
  ENGINE_PROTOCOL_VERSION,
  engineEventSchema,
  engineResponseSchema,
  type EngineEventName,
  type EngineMethod,
} from "../shared/engine-protocol";
import { readEngineToken, resolveEngineIdentity } from "./engine-common";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface EngineClientOptions {
  userDataPath: string;
  spawnCommand: string;
  spawnArgs: string[];
}

export class EngineClient extends EventEmitter {
  private socket?: Socket;
  private connecting?: Promise<void>;
  private buffer = "";
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly options: EngineClientOptions) {
    super();
  }

  async connect(): Promise<void> {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectWithRetry().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  async request<T>(method: EngineMethod, params?: unknown): Promise<T> {
    await this.connect();
    const token = await readEngineToken(this.options.userDataPath);
    if (!token || !this.socket || this.socket.destroyed) throw new Error("翻译引擎连接不可用");
    const id = randomUUID();
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
    this.socket.write(
      `${JSON.stringify({ version: ENGINE_PROTOCOL_VERSION, id, token, method, params })}\n`,
    );
    return response;
  }

  close(): void {
    this.socket?.end();
    this.socket = undefined;
    this.rejectPending(new Error("翻译引擎连接已关闭"));
  }

  onEvent(event: EngineEventName, listener: (payload: unknown) => void): () => void {
    this.on(event, listener);
    return () => this.off(event, listener);
  }

  private async connectWithRetry(): Promise<void> {
    let spawned = false;
    let lastError: unknown;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const token = await readEngineToken(this.options.userDataPath);
      if (token) {
        try {
          this.socket = await openSocket(resolveEngineIdentity(this.options.userDataPath).pipeName);
          this.bindSocket(this.socket);
          return;
        } catch (error) {
          lastError = error;
        }
      }
      if (!spawned) {
        spawned = true;
        const child = spawn(this.options.spawnCommand, this.options.spawnArgs, {
          detached: true,
          windowsHide: true,
          stdio: "ignore",
        });
        child.unref();
      }
      await delay(250);
    }
    throw new Error(
      `无法启动 PDF2ZH 翻译引擎：${lastError instanceof Error ? lastError.message : "连接超时"}`,
    );
  }

  private bindSocket(socket: Socket): void {
    this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      while (true) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
    socket.on("close", () => {
      if (this.socket === socket) this.socket = undefined;
      this.rejectPending(new Error("翻译引擎连接中断"));
    });
    socket.on("error", () => {
      // The close handler rejects pending calls and the next request reconnects.
    });
  }

  private handleLine(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const response = engineResponseSchema.safeParse(value);
    if (response.success) {
      const pending = this.pending.get(response.data.id);
      if (!pending) return;
      this.pending.delete(response.data.id);
      if (response.data.ok) pending.resolve(response.data.result);
      else pending.reject(new Error(response.data.error || "翻译引擎请求失败"));
      return;
    }
    const event = engineEventSchema.safeParse(value);
    if (event.success) this.emit(event.data.event, event.data.payload);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

function openSocket(pipeName: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(pipeName);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
