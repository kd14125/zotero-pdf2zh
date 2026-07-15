import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppSettings, ProviderProfile, TaskRecord } from "../shared/types";

interface PersistedData {
  settings: AppSettings;
  providers: ProviderProfile[];
  tasks: TaskRecord[];
}

export const defaultOptions = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  outputMono: true,
  outputDual: true,
  dualMode: "LR" as const,
  noWatermark: true,
  ocrWorkaround: false,
  autoOcr: true,
  saveGlossary: false,
  disableGlossary: false,
  translateFirst: true,
  qps: 10,
  poolSize: 0,
};

const initialData: PersistedData = {
  settings: {
    runtimeMirrorUrl: "",
    lastOptions: defaultOptions,
  },
  providers: [],
  tasks: [],
};

export class JsonStore {
  private data: PersistedData = structuredClone(initialData);
  private readonly filePath: string;

  constructor(filePath = join(app.getPath("userData"), "desktop-data.json")) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<PersistedData>;
      this.data = {
        settings: {
          ...initialData.settings,
          ...parsed.settings,
          lastOptions: {
            ...defaultOptions,
            ...parsed.settings?.lastOptions,
          },
        },
        providers: Array.isArray(parsed.providers) ? parsed.providers : [],
        tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      };
      for (const task of this.data.tasks) {
        if (task.status === "running" || task.status === "queued") {
          task.status = "failed";
          task.error = "应用上次退出时任务尚未完成";
          task.finishedAt = new Date().toISOString();
        }
      }
      await this.flush();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await this.flush();
    }
  }

  getSettings(): AppSettings {
    return structuredClone(this.data.settings);
  }

  async setSettings(settings: AppSettings): Promise<AppSettings> {
    this.data.settings = structuredClone(settings);
    await this.flush();
    return this.getSettings();
  }

  getProviders(): ProviderProfile[] {
    return structuredClone(this.data.providers);
  }

  async setProviders(providers: ProviderProfile[]): Promise<void> {
    this.data.providers = structuredClone(providers);
    await this.flush();
  }

  getTasks(): TaskRecord[] {
    return structuredClone(this.data.tasks);
  }

  async setTasks(tasks: TaskRecord[]): Promise<void> {
    this.data.tasks = structuredClone(tasks).slice(0, 500);
    await this.flush();
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.data, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}
