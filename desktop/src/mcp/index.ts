import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type {
  AppSettings,
  EngineStatus,
  ProviderProfile,
  RuntimeState,
  TaskRecord,
  TranslationOptions,
} from "../shared/types";
import { EngineClient } from "../main/engine-client";

const VERSION = "0.3.0";
const userDataPath =
  process.env.PDF2ZH_USER_DATA ||
  join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "pdf2zh-desktop");
const desktopExecutable =
  process.env.PDF2ZH_DESKTOP_EXE ||
  resolve(dirname(process.execPath), "..", "..", "PDF2ZH Desktop.exe");
const client = new EngineClient({
  userDataPath,
  spawnCommand: desktopExecutable,
  spawnArgs: ["--engine", `--user-data-dir=${userDataPath}`],
});

const server = new McpServer({ name: "pdf2zh-desktop", version: VERSION });

const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const action = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
};

const translationPatchSchema = z
  .object({
    sourceLanguage: z.string().min(2).max(20).optional(),
    targetLanguage: z.string().min(2).max(20).optional(),
    outputMono: z.boolean().optional(),
    outputDual: z.boolean().optional(),
    dualMode: z.enum(["LR", "TB"]).optional(),
    noWatermark: z.boolean().optional(),
    ocrWorkaround: z.boolean().optional(),
    autoOcr: z.boolean().optional(),
    saveGlossary: z.boolean().optional(),
    disableGlossary: z.boolean().optional(),
    translateFirst: z.boolean().optional(),
    qps: z.number().int().min(1).max(10000).optional(),
    poolSize: z.number().int().min(0).max(10000).optional(),
    outputDirectory: z.string().max(1000).optional(),
  })
  .strict();

server.registerTool(
  "pdf2zh_get_status",
  {
    title: "获取 PDF2ZH 状态",
    description: "查看本地翻译引擎、运行时版本和活动任务数量。",
    inputSchema: z.object({}),
    annotations: readOnly,
  },
  async () => toolCall(async () => sanitizeStatus(await client.request("engine.status"))),
);

server.registerTool(
  "pdf2zh_list_profiles",
  {
    title: "列出翻译配置",
    description: "列出本机已保存的翻译配置，不返回 API Key 或 API 地址。",
    inputSchema: z.object({}),
    annotations: readOnly,
  },
  async () =>
    toolCall(async () => {
      const [settings, profiles] = await Promise.all([
        client.request<AppSettings>("settings.get"),
        client.request<ProviderProfile[]>("providers.list"),
      ]);
      return profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        provider: profile.provider,
        model: profile.model,
        hasApiKey: profile.hasApiKey,
        active: profile.id === settings.activeProfileId,
      }));
    }),
);

server.registerTool(
  "pdf2zh_prepare_runtime",
  {
    title: "准备 PDF2ZH 运行时",
    description: "检查并按需下载、校验和安装固定版本的 PDF2ZH 运行时。",
    inputSchema: z.object({}),
    annotations: action,
  },
  async () => toolCall(async () => sanitizeRuntime(await client.request("runtime.ensure"))),
);

server.registerTool(
  "pdf2zh_translate_pdfs",
  {
    title: "翻译 PDF",
    description: "将一个或多个本地 PDF 加入翻译队列。翻译会调用所选第三方服务，可能产生 API 费用。",
    inputSchema: z.object({
      inputPaths: z.array(z.string().min(1).max(4000)).min(1).max(200),
      profileId: z.string().min(1).max(100).optional(),
      options: translationPatchSchema.optional(),
    }),
    annotations: action,
  },
  async ({ inputPaths, profileId, options }) =>
    toolCall(async () => {
      const [settings, profiles] = await Promise.all([
        client.request<AppSettings>("settings.get"),
        client.request<ProviderProfile[]>("providers.list"),
      ]);
      const selectedId = profileId || settings.activeProfileId;
      if (!selectedId) throw new Error("尚未选择翻译配置，请先在桌面端设置当前配置");
      const profile = profiles.find((candidate) => candidate.id === selectedId);
      if (!profile) throw new Error("指定的翻译配置不存在");
      const merged = { ...settings.lastOptions, ...options } as TranslationOptions;
      if (!merged.outputMono && !merged.outputDual) throw new Error("至少选择一种输出文件");
      const tasks = await client.request<TaskRecord[]>("tasks.enqueue", {
        inputPaths,
        profileId: selectedId,
        options: merged,
      });
      return tasks.map((task) => sanitizeTask(task, false));
    }),
);

server.registerTool(
  "pdf2zh_list_tasks",
  {
    title: "列出翻译任务",
    description: "按状态筛选并列出本地翻译任务。",
    inputSchema: z.object({
      status: z.enum(["queued", "running", "completed", "failed", "cancelled"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    annotations: readOnly,
  },
  async ({ status, limit }) =>
    toolCall(async () => {
      const tasks = await client.request<TaskRecord[]>("tasks.list");
      return tasks
        .filter((task) => !status || task.status === status)
        .slice(0, limit)
        .map((task) => sanitizeTask(task, false));
    }),
);

server.registerTool(
  "pdf2zh_get_task",
  {
    title: "获取翻译任务",
    description: "读取指定任务的进度、结果路径和可选的末尾脱敏日志。",
    inputSchema: z.object({
      taskId: z.string().min(1).max(100),
      includeLogs: z.boolean().default(false),
    }),
    annotations: readOnly,
  },
  async ({ taskId, includeLogs }) =>
    toolCall(async () => sanitizeTask(await findTask(taskId), includeLogs)),
);

server.registerTool(
  "pdf2zh_wait_task",
  {
    title: "等待翻译任务",
    description: "等待任务状态变化或达到最长等待时间，便于轮询长时间翻译。",
    inputSchema: z.object({
      taskId: z.string().min(1).max(100),
      timeoutSeconds: z.number().int().min(1).max(30).default(20),
    }),
    annotations: readOnly,
  },
  async ({ taskId, timeoutSeconds }) =>
    toolCall(async () => {
      const initial = await findTask(taskId);
      const initialSignature = taskSignature(initial);
      const deadline = Date.now() + timeoutSeconds * 1000;
      let current = initial;
      while (Date.now() < deadline && !isTerminal(current.status)) {
        await delay(500);
        current = await findTask(taskId);
        if (taskSignature(current) !== initialSignature) break;
      }
      return sanitizeTask(current, false);
    }),
);

server.registerTool(
  "pdf2zh_cancel_task",
  {
    title: "取消翻译任务",
    description: "取消排队或运行中的翻译任务，并终止完整 PDF2ZH 子进程树。",
    inputSchema: z.object({ taskId: z.string().min(1).max(100) }),
    annotations: { ...action, openWorldHint: false },
  },
  async ({ taskId }) =>
    toolCall(async () => {
      await client.request("tasks.cancel", taskId);
      return sanitizeTask(await findTask(taskId), false);
    }),
);

server.registerTool(
  "pdf2zh_retry_task",
  {
    title: "重试翻译任务",
    description: "使用原 PDF、原翻译配置和原参数重新创建翻译任务。",
    inputSchema: z.object({ taskId: z.string().min(1).max(100) }),
    annotations: action,
  },
  async ({ taskId }) =>
    toolCall(async () => sanitizeTask(await client.request("tasks.retry", taskId), false)),
);

async function findTask(taskId: string): Promise<TaskRecord> {
  const tasks = await client.request<TaskRecord[]>("tasks.list");
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task) throw new Error("任务不存在");
  return task;
}

function sanitizeStatus(status: EngineStatus): Record<string, unknown> {
  return {
    connected: status.connected,
    version: status.version,
    activeTaskCount: status.activeTaskCount,
    runtime: sanitizeRuntime(status.runtime),
  };
}

function sanitizeRuntime(runtime: RuntimeState): Omit<RuntimeState, "binaryPath"> {
  const safe = { ...runtime };
  delete safe.binaryPath;
  return safe;
}

function sanitizeTask(task: TaskRecord, includeLogs: boolean): Record<string, unknown> {
  return {
    id: task.id,
    inputPath: task.inputPath,
    fileName: task.fileName,
    profileId: task.profileId,
    provider: task.provider,
    options: task.options,
    status: task.status,
    progress: task.progress,
    outputFiles: task.outputFiles,
    error: task.error,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    ...(includeLogs ? { logs: task.logs.slice(-50) } : {}),
  };
}

async function toolCall(operation: () => Promise<unknown>) {
  try {
    const value = await operation();
    return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: error instanceof Error ? error.message : "PDF2ZH MCP 调用失败",
        },
      ],
    };
  }
}

function taskSignature(task: TaskRecord): string {
  return `${task.status}:${task.progress.percent}:${task.progress.stage}:${task.progress.message}`;
}

function isTerminal(status: TaskRecord["status"]): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function main(): Promise<void> {
  await client.connect();
  await server.connect(new StdioServerTransport());
}

process.once("SIGINT", () => {
  client.close();
  process.exit(0);
});
process.once("SIGTERM", () => {
  client.close();
  process.exit(0);
});

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
