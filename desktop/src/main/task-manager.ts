import { app } from "electron";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn as spawnProcess } from "node:child_process";
import { access, copyFile, mkdir, readdir, rename, rm, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, parse } from "node:path";
import * as pty from "node-pty";
import { stringify } from "smol-toml";
import type {
  EnqueueRequest,
  ProviderProfile,
  TaskRecord,
  TranslationOptions,
} from "../shared/types";
import { parseProgress, redactLog } from "./progress";
import { ProviderRepository } from "./providers";
import { RuntimeManager } from "./runtime-manager";
import { JsonStore } from "./store";

export class TaskManager extends EventEmitter {
  private tasks: TaskRecord[] = [];
  private runningId?: string;
  private terminal?: pty.IPty;

  constructor(
    private readonly store: JsonStore,
    private readonly providers: ProviderRepository,
    private readonly runtime: RuntimeManager,
  ) {
    super();
    this.tasks = store.getTasks();
  }

  list(): TaskRecord[] {
    return structuredClone(this.tasks);
  }

  async enqueue(request: EnqueueRequest): Promise<TaskRecord[]> {
    const profile = this.providers.resolve(request.profileId);
    const created = await Promise.all(
      request.inputPaths.map(async (inputPath) => {
        await validatePdf(inputPath);
        const now = new Date().toISOString();
        return {
          id: randomUUID(),
          inputPath,
          fileName: basename(inputPath),
          profileId: profile.id,
          provider: profile.provider,
          options: structuredClone(request.options),
          status: "queued" as const,
          progress: { percent: 0, stage: "排队中", message: "等待开始" },
          outputFiles: [],
          logs: [],
          createdAt: now,
        };
      }),
    );
    this.tasks.unshift(...created);
    await this.persistAndEmit();
    void this.pump();
    return structuredClone(created);
  }

  async cancel(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (task.status === "queued") {
      task.status = "cancelled";
      task.progress = { percent: task.progress.percent, stage: "已取消", message: "任务已取消" };
      task.finishedAt = new Date().toISOString();
      await this.persistAndEmit();
      return;
    }
    if (task.status !== "running" || this.runningId !== id || !this.terminal) return;
    task.status = "cancelled";
    task.progress.stage = "正在取消";
    task.progress.message = "正在终止翻译进程";
    await this.persistAndEmit();
    if (process.platform === "win32") {
      spawnProcess("taskkill", ["/PID", String(this.terminal.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
    try {
      this.terminal.kill();
    } catch {
      // Process may have already exited.
    }
  }

  async retry(id: string): Promise<TaskRecord> {
    const source = this.requireTask(id);
    const [task] = await this.enqueue({
      inputPaths: [source.inputPath],
      profileId: source.profileId,
      options: source.options,
    });
    return task;
  }

  async remove(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (task.status === "running") throw new Error("运行中的任务不能移除，请先取消");
    this.tasks = this.tasks.filter((item) => item.id !== id);
    await this.persistAndEmit();
  }

  async clearHistory(): Promise<void> {
    this.tasks = this.tasks.filter((task) => task.status === "running" || task.status === "queued");
    await this.persistAndEmit();
  }

  shutdown(): void {
    if (!this.terminal) return;
    if (process.platform === "win32") {
      spawnProcess("taskkill", ["/PID", String(this.terminal.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    }
    try {
      this.terminal.kill();
    } catch {
      // The child process may already be exiting with the app.
    }
  }

  private async pump(): Promise<void> {
    if (this.runningId) return;
    const next = [...this.tasks].reverse().find((task) => task.status === "queued");
    if (!next) return;
    this.runningId = next.id;
    try {
      await this.run(next);
    } finally {
      this.runningId = undefined;
      this.terminal = undefined;
      void this.pump();
    }
  }

  private async run(task: TaskRecord): Promise<void> {
    const temporaryRoot = join(app.getPath("temp"), "pdf2zh-desktop", task.id);
    const stagingOutput = join(temporaryRoot, "output");
    const configPath = join(temporaryRoot, "task-config.toml");
    task.status = "running";
    task.startedAt = new Date().toISOString();
    task.progress = { percent: 0, stage: "准备运行时", message: "检查运行环境" };
    await this.persistAndEmit();
    try {
      const profile = this.providers.resolve(task.profileId);
      const binary = this.runtime.getBinaryPath();
      await mkdir(stagingOutput, { recursive: true });
      const config = buildProviderConfig(profile);
      await writeFile(configPath, stringify(config), { encoding: "utf8", mode: 0o600 });
      const args = buildCliArgs(
        task.inputPath,
        stagingOutput,
        configPath,
        profile.provider,
        task.options,
      );
      task.progress = { percent: 1, stage: "启动翻译", message: "正在加载模型与文档" };
      await this.persistAndEmit();
      const exitCode = await this.spawn(binary, args, task);
      if (this.currentStatus(task.id) === "cancelled") throw new CancelledError();
      if (exitCode !== 0) throw new Error(`PDF2ZH 进程退出，代码 ${exitCode}`);
      const generated = await collectPdfs(stagingOutput);
      if (!generated.length) throw new Error("翻译进程未生成 PDF 文件");
      const outputRoot =
        task.options.outputDirectory || join(dirname(task.inputPath), "PDF2ZH-翻译结果");
      await mkdir(outputRoot, { recursive: true });
      task.progress = { percent: 99, stage: "整理结果", message: "正在保存输出文件" };
      await this.persistAndEmit();
      for (const source of generated) {
        const destination = await uniqueDestination(outputRoot, basename(source));
        await copyAtomically(source, destination);
        task.outputFiles.push(destination);
      }
      task.status = "completed";
      task.progress = {
        percent: 100,
        stage: "已完成",
        message: `生成 ${task.outputFiles.length} 个文件`,
      };
    } catch (error) {
      if (error instanceof CancelledError || this.currentStatus(task.id) === "cancelled") {
        task.status = "cancelled";
        task.progress = { percent: task.progress.percent, stage: "已取消", message: "任务已取消" };
      } else {
        task.status = "failed";
        task.error = redactLog(
          error instanceof Error ? error.message : String(error),
          app.getPath("home"),
        );
        task.progress = { percent: task.progress.percent, stage: "失败", message: task.error };
      }
    } finally {
      task.finishedAt = new Date().toISOString();
      await rm(temporaryRoot, { recursive: true, force: true });
      await this.persistAndEmit();
    }
  }

  private spawn(binary: string, args: string[], task: TaskRecord): Promise<number> {
    return new Promise((resolve, reject) => {
      try {
        const env = {
          ...process.env,
          COLUMNS: "200",
          FORCE_COLOR: "1",
          FORCE_TERMINAL: "1",
          TERM: "xterm-256color",
        } as Record<string, string>;
        delete env.NO_COLOR;
        const terminal = pty.spawn(binary, args, {
          name: "xterm-256color",
          cols: 200,
          rows: 40,
          cwd: dirname(binary),
          env,
          useConpty: process.platform === "win32",
        });
        this.terminal = terminal;
        terminal.onData((chunk) => {
          const redacted = redactLog(chunk, app.getPath("home"));
          if (redacted)
            task.logs = [...task.logs, ...redacted.split("\n").filter(Boolean)].slice(-200);
          const progress = parseProgress(chunk);
          task.progress = {
            percent: progress.percent ?? task.progress.percent,
            stage: progress.stage ?? task.progress.stage,
            message: progress.message ?? task.progress.message,
          };
          void this.persistAndEmit();
        });
        terminal.onExit(({ exitCode }) => resolve(exitCode));
      } catch (error) {
        reject(error);
      }
    });
  }

  private requireTask(id: string): TaskRecord {
    const task = this.tasks.find((item) => item.id === id);
    if (!task) throw new Error("任务不存在");
    return task;
  }

  private currentStatus(id: string): TaskRecord["status"] | undefined {
    return this.tasks.find((item) => item.id === id)?.status;
  }

  private async persistAndEmit(): Promise<void> {
    await this.store.setTasks(this.tasks);
    this.emit("changed", this.list());
  }
}

class CancelledError extends Error {}

export function buildCliArgs(
  inputPath: string,
  outputPath: string,
  configPath: string,
  provider: ProviderProfile["provider"],
  options: TranslationOptions,
): string[] {
  const args = [
    inputPath,
    `--${provider}`,
    "--qps",
    String(options.qps),
    "--output",
    outputPath,
    "--lang-in",
    options.sourceLanguage,
    "--lang-out",
    options.targetLanguage,
    "--config-file",
    configPath,
    "--watermark-output-mode",
    options.noWatermark ? "no_watermark" : "watermarked",
  ];
  if (!options.outputMono) args.push("--no-mono");
  if (!options.outputDual) args.push("--no-dual");
  if (provider === "siliconflowfree") args.push("--disable-rich-text-translate");
  if (options.translateFirst) args.push("--dual-translate-first");
  if (options.dualMode === "TB") args.push("--use-alternating-pages-dual");
  if (options.ocrWorkaround) args.push("--ocr-workaround");
  if (options.autoOcr) args.push("--auto-enable-ocr-workaround");
  if (options.saveGlossary) args.push("--save-auto-extracted-glossary");
  if (options.disableGlossary) args.push("--no-auto-extract-glossary");
  if (options.poolSize > 1) args.push("--pool-max-workers", String(options.poolSize));
  return args;
}

export function buildProviderConfig(
  profile: ProviderProfile & { apiKey: string },
): Record<string, unknown> {
  const common = {
    translate_engine_type: providerDisplayName(profile.provider),
    support_llm: "yes",
  };
  let section: Record<string, unknown>;
  switch (profile.provider) {
    case "siliconflowfree":
      section = { translate_engine_type: "SiliconFlowFree" };
      break;
    case "openai":
      section = {
        ...common,
        openai_model: profile.model,
        openai_base_url: profile.baseUrl,
        openai_api_key: profile.apiKey,
      };
      break;
    case "aliyundashscope":
      section = {
        ...common,
        aliyun_dashscope_model: profile.model,
        aliyun_dashscope_base_url: profile.baseUrl,
        aliyun_dashscope_api_key: profile.apiKey,
      };
      break;
    case "deepseek":
      section = { ...common, deepseek_model: profile.model, deepseek_api_key: profile.apiKey };
      break;
    case "siliconflow":
      section = {
        ...common,
        siliconflow_model: profile.model,
        siliconflow_base_url: profile.baseUrl,
        siliconflow_api_key: profile.apiKey,
      };
      break;
    case "zhipu":
      section = { ...common, zhipu_model: profile.model, zhipu_api_key: profile.apiKey };
      break;
    case "openaicompatible":
      section = {
        ...common,
        openai_compatible_model: profile.model,
        openai_compatible_base_url: profile.baseUrl,
        openai_compatible_api_key: profile.apiKey,
      };
      break;
  }
  return { [`${profile.provider}_detail`]: { ...section, ...profile.extra } };
}

function providerDisplayName(provider: ProviderProfile["provider"]): string {
  const names: Record<ProviderProfile["provider"], string> = {
    siliconflowfree: "SiliconFlowFree",
    openai: "OpenAI",
    aliyundashscope: "AliyunDashScope",
    deepseek: "DeepSeek",
    siliconflow: "SiliconFlow",
    zhipu: "Zhipu",
    openaicompatible: "OpenAICompatible",
  };
  return names[provider];
}

async function validatePdf(path: string): Promise<void> {
  if (extname(path).toLowerCase() !== ".pdf") throw new Error(`${basename(path)} 不是 PDF 文件`);
  await access(path);
}

async function collectPdfs(root: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...(await collectPdfs(path)));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".pdf") result.push(path);
  }
  return result;
}

export async function uniqueDestination(directory: string, fileName: string): Promise<string> {
  const parts = parse(fileName);
  let index = 1;
  let candidate = join(directory, fileName);
  while (await exists(candidate)) {
    index += 1;
    candidate = join(directory, `${parts.name} (${index})${parts.ext}`);
  }
  return candidate;
}

async function copyAtomically(source: string, destination: string): Promise<void> {
  const partial = `${destination}.${randomUUID()}.partial`;
  try {
    await copyFile(source, partial);
    await rename(partial, destination);
  } finally {
    await unlink(partial).catch(() => undefined);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
