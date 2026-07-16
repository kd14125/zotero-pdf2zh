import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENGINE_PROTOCOL_VERSION } from "../src/shared/engine-protocol";
import { resolveEngineIdentity } from "../src/main/engine-common";
import { defaultOptions } from "../src/main/store";

const execFileAsync = promisify(execFile);

describe("stdio MCP server", () => {
  let mockServer: Server;
  let client: Client;
  let userData: string;
  let lastEnqueue: unknown;
  const token = "a".repeat(64);
  const profile = {
    id: "profile-1",
    name: "SiliconFlow Test",
    provider: "siliconflow",
    baseUrl: "https://private.example/v1",
    model: "test/model",
    hasApiKey: true,
    apiKey: "must-not-leak",
    extra: { secret_field: "must-not-leak" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  beforeAll(async () => {
    await execFileAsync(process.execPath, [resolve("scripts/build-mcp.mjs")], {
      cwd: resolve("."),
      windowsHide: true,
    });
    userData = await mkdtemp(join(tmpdir(), "pdf2zh-mcp-test-"));
    await writeFile(resolveEngineIdentity(userData).tokenPath, token, "utf8");
    mockServer = createServer((socket) => bindMockSocket(socket));
    await new Promise<void>((resolveListen, rejectListen) => {
      mockServer.once("error", rejectListen);
      mockServer.listen(resolveEngineIdentity(userData).pipeName, resolveListen);
    });
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => Boolean(entry[1])),
    );
    const transport = new StdioClientTransport({
      command: resolve("build/mcp/pdf2zh-mcp.exe"),
      args: [resolve("build/mcp/server.cjs")],
      env: {
        ...env,
        PDF2ZH_USER_DATA: userData,
        PDF2ZH_DESKTOP_EXE: resolve("missing-desktop.exe"),
      },
    });
    client = new Client({ name: "pdf2zh-test", version: "1.0.0" });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await new Promise<void>((resolveClose) => mockServer?.close(() => resolveClose()));
  });

  it("exposes the fixed nine-tool surface", async () => {
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "pdf2zh_cancel_task",
        "pdf2zh_get_status",
        "pdf2zh_get_task",
        "pdf2zh_list_profiles",
        "pdf2zh_list_tasks",
        "pdf2zh_prepare_runtime",
        "pdf2zh_retry_task",
        "pdf2zh_translate_pdfs",
        "pdf2zh_wait_task",
      ].sort(),
    );
  });

  it("never exposes provider secrets", async () => {
    const result = await client.callTool({ name: "pdf2zh_list_profiles", arguments: {} });
    const text = JSON.stringify(result);
    expect(text).toContain("SiliconFlow Test");
    expect(text).not.toContain("must-not-leak");
    expect(text).not.toContain("private.example");
  });

  it("maps saved defaults into a queued translation request", async () => {
    const result = await client.callTool({
      name: "pdf2zh_translate_pdfs",
      arguments: { inputPaths: ["C:/papers/test.pdf"], options: { outputDual: false } },
    });
    expect(result.isError).not.toBe(true);
    expect(lastEnqueue).toMatchObject({
      inputPaths: ["C:/papers/test.pdf"],
      profileId: "profile-1",
      options: { sourceLanguage: "en", targetLanguage: "zh-CN", outputDual: false },
    });
  });

  function bindMockSocket(socket: Socket): void {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newline = buffer.indexOf("\n");
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const request = JSON.parse(line) as {
          id: string;
          token: string;
          method: string;
          params?: unknown;
        };
        if (request.token !== token) {
          respond(socket, request.id, undefined, "bad token");
          continue;
        }
        if (request.method === "settings.get") {
          respond(socket, request.id, {
            activeProfileId: profile.id,
            runtimeMirrorUrl: "",
            lastOptions: defaultOptions,
          });
        } else if (request.method === "providers.list") {
          respond(socket, request.id, [profile]);
        } else if (request.method === "engine.status") {
          respond(socket, request.id, {
            connected: true,
            version: "0.3.0",
            pid: 1,
            activeTaskCount: 0,
            runtime: {
              status: "ready",
              version: "2.9.0",
              installedVersion: "2.9.0",
              progress: 100,
              downloadedBytes: 1,
              totalBytes: 1,
              binaryPath: "C:/private/pdf2zh.exe",
            },
          });
        } else if (request.method === "tasks.enqueue") {
          lastEnqueue = request.params;
          const params = request.params as {
            inputPaths: string[];
            profileId: string;
            options: unknown;
          };
          respond(socket, request.id, [
            {
              id: "task-1",
              inputPath: params.inputPaths[0],
              fileName: "test.pdf",
              profileId: params.profileId,
              provider: "siliconflow",
              options: params.options,
              status: "queued",
              progress: { percent: 0, stage: "排队中", message: "等待开始" },
              outputFiles: [],
              logs: [],
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          ]);
        } else {
          respond(socket, request.id, []);
        }
      }
    });
  }
});

function respond(socket: Socket, id: string, result?: unknown, error?: string): void {
  socket.write(
    `${JSON.stringify({
      version: ENGINE_PROTOCOL_VERSION,
      id,
      ok: !error,
      result,
      error,
    })}\n`,
  );
}
