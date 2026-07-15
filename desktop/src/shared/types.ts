export const PROVIDER_IDS = [
  "siliconflowfree",
  "openai",
  "aliyundashscope",
  "deepseek",
  "siliconflow",
  "zhipu",
  "openaicompatible",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface ProviderProfile {
  id: string;
  name: string;
  provider: ProviderId;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  apiKey?: string;
  extra: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export interface TranslationOptions {
  sourceLanguage: string;
  targetLanguage: string;
  outputMono: boolean;
  outputDual: boolean;
  dualMode: "LR" | "TB";
  noWatermark: boolean;
  ocrWorkaround: boolean;
  autoOcr: boolean;
  saveGlossary: boolean;
  disableGlossary: boolean;
  translateFirst: boolean;
  qps: number;
  poolSize: number;
  outputDirectory?: string;
}

export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TaskProgress {
  percent: number;
  stage: string;
  message: string;
}

export interface TaskRecord {
  id: string;
  inputPath: string;
  fileName: string;
  profileId: string;
  provider: ProviderId;
  options: TranslationOptions;
  status: TaskStatus;
  progress: TaskProgress;
  outputFiles: string[];
  logs: string[];
  error?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface RuntimeManifest {
  version: string;
  babeldocVersion: string;
  fileName: string;
  url: string;
  size: number;
  sha256: string;
  sourceUrl: string;
}

export type RuntimeStatus =
  "missing" | "downloading" | "verifying" | "extracting" | "ready" | "error";

export interface RuntimeState {
  status: RuntimeStatus;
  version: string;
  installedVersion?: string;
  progress: number;
  downloadedBytes: number;
  totalBytes: number;
  binaryPath?: string;
  error?: string;
  updateAvailable?: boolean;
  previousVersion?: string;
}

export interface AppSettings {
  activeProfileId?: string;
  runtimeMirrorUrl: string;
  lastOptions: TranslationOptions;
}

export type AppUpdateStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  availableVersion?: string;
  progress: number;
  message: string;
  error?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface ProviderModelsResult {
  ok: boolean;
  message: string;
  models: string[];
}

export interface EnqueueRequest {
  inputPaths: string[];
  profileId: string;
  options: TranslationOptions;
}

export interface PreviewResult {
  url: string;
  name: string;
}

export interface DesktopApi {
  app: {
    getVersion(): Promise<string>;
    getSettings(): Promise<AppSettings>;
    saveSettings(settings: AppSettings): Promise<AppSettings>;
    openSource(): Promise<void>;
    openLicense(): Promise<string>;
  };
  updates: {
    getState(): Promise<AppUpdateState>;
    check(): Promise<AppUpdateState>;
    download(): Promise<AppUpdateState>;
    install(): Promise<AppUpdateState>;
    onState(listener: (state: AppUpdateState) => void): () => void;
  };
  dialog: {
    pickPdfs(): Promise<string[]>;
    pickOutputDirectory(): Promise<string | undefined>;
  };
  providers: {
    list(): Promise<ProviderProfile[]>;
    save(profile: ProviderProfile): Promise<ProviderProfile>;
    remove(id: string): Promise<void>;
    test(profile: ProviderProfile): Promise<ProviderTestResult>;
    listModels(profile: ProviderProfile): Promise<ProviderModelsResult>;
  };
  runtime: {
    getState(): Promise<RuntimeState>;
    ensure(): Promise<RuntimeState>;
    checkUpdate(): Promise<RuntimeState>;
    update(): Promise<RuntimeState>;
    rollback(): Promise<RuntimeState>;
    onState(listener: (state: RuntimeState) => void): () => void;
  };
  tasks: {
    list(): Promise<TaskRecord[]>;
    enqueue(request: EnqueueRequest): Promise<TaskRecord[]>;
    cancel(id: string): Promise<void>;
    retry(id: string): Promise<TaskRecord>;
    remove(id: string): Promise<void>;
    clearHistory(): Promise<void>;
    onChanged(listener: (tasks: TaskRecord[]) => void): () => void;
  };
  files: {
    pathsFromDrop(files: File[]): string[];
    open(path: string): Promise<string>;
    reveal(path: string): Promise<void>;
    preview(path: string): Promise<PreviewResult>;
  };
}
