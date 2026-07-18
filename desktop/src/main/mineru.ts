import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import extract from "extract-zip";
import type { MineruConfig, MineruTestResult } from "../shared/types";
import { CredentialStore } from "./credentials";
import { JsonStore } from "./store";

const MINERU_CREDENTIAL_ID = "__mineru_api_token__";
const REQUEST_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 3_000;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;

export class MineruManager {
  constructor(
    private readonly store: JsonStore,
    private readonly credentials: CredentialStore,
  ) {}

  getConfig(): MineruConfig {
    return {
      ...this.store.getMineruConfig(),
      hasApiKey: this.credentials.has(MINERU_CREDENTIAL_ID),
    };
  }

  async saveConfig(input: MineruConfig): Promise<MineruConfig> {
    const config = {
      baseUrl: normalizeBaseUrl(input.baseUrl),
      modelVersion: input.modelVersion,
    };
    await this.store.setMineruConfig(config);
    if (input.apiKey !== undefined) await this.credentials.set(MINERU_CREDENTIAL_ID, input.apiKey);
    return this.getConfig();
  }

  async test(input: MineruConfig): Promise<MineruTestResult> {
    const token = input.apiKey || this.credentials.get(MINERU_CREDENTIAL_ID);
    if (!token) return { ok: false, message: "请先填写 MinerU API Token" };
    const started = Date.now();
    try {
      const response = await fetch(
        `${normalizeBaseUrl(input.baseUrl)}/extract-results/batch/pdf2zh-connection-test`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      const latencyMs = Date.now() - started;
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: "MinerU API Token 无效或无权限", latencyMs };
      }
      return { ok: true, message: "MinerU API 连接成功", latencyMs };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? redact(error.message, token) : "MinerU 连接失败",
        latencyMs: Date.now() - started,
      };
    }
  }

  async prepareFormulaHints(
    inputPath: string,
    workDirectory: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const config = this.getConfig();
    const token = this.credentials.get(MINERU_CREDENTIAL_ID);
    if (!token || !config.hasApiKey) throw new Error("尚未配置 MinerU API Token");
    const file = await stat(inputPath);
    if (file.size <= 0 || file.size > MAX_INPUT_BYTES) {
      throw new Error("MinerU 仅支持 200 MB 以内的 PDF 文件");
    }

    const dataId = createHash("sha256")
      .update(`${inputPath}:${file.size}:${file.mtimeMs}`)
      .digest("hex")
      .slice(0, 32);
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const createResponse = await mineruFetch(`${baseUrl}/file-urls/batch`, token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ name: basename(inputPath), data_id: dataId }],
        model_version: config.modelVersion,
      }),
      signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
    });
    const createPayload = asRecord(await createResponse.json());
    const createData = asRecord(createPayload?.data);
    const batchId = stringValue(createData?.batch_id ?? createPayload?.batch_id);
    const uploadUrl = extractUploadUrl(createData?.file_urls ?? createPayload?.file_urls);
    if (!batchId || !uploadUrl) throw new Error("MinerU 未返回有效的上传地址");

    const upload = await fetch(uploadUrl, {
      method: "PUT",
      body: await readFile(inputPath),
      signal: withTimeout(signal, 5 * 60 * 1000),
    });
    if (!upload.ok) throw new Error(`MinerU 文件上传失败（HTTP ${upload.status}）`);

    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    let zipUrl = "";
    while (Date.now() < deadline) {
      const response = await mineruFetch(`${baseUrl}/extract-results/batch/${batchId}`, token, {
        signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
      });
      const payload = asRecord(await response.json());
      const data = asRecord(payload?.data);
      const records = arrayValue(data?.extract_result ?? data?.extract_results ?? payload?.data);
      const record = asRecord(records[0]) ?? data;
      const state = stringValue(record?.state ?? record?.status).toLowerCase();
      if (["failed", "error"].includes(state)) {
        throw new Error(stringValue(record?.err_msg ?? record?.message) || "MinerU 解析失败");
      }
      zipUrl = stringValue(record?.full_zip_url ?? record?.zip_url ?? record?.result_url);
      if (zipUrl || ["done", "completed", "success"].includes(state)) break;
      await delay(POLL_INTERVAL_MS, signal);
    }
    if (!zipUrl) throw new Error("MinerU 解析超时或未返回结果压缩包");

    const archiveResponse = await fetch(zipUrl, {
      signal: withTimeout(signal, 5 * 60 * 1000),
    });
    if (!archiveResponse.ok) {
      throw new Error(`MinerU 结果下载失败（HTTP ${archiveResponse.status}）`);
    }
    const declaredLength = Number(archiveResponse.headers.get("content-length") || 0);
    if (declaredLength > MAX_DOWNLOAD_BYTES) throw new Error("MinerU 结果压缩包超过 500 MB");
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    if (archive.length > MAX_DOWNLOAD_BYTES) throw new Error("MinerU 结果压缩包超过 500 MB");
    const archivePath = join(workDirectory, `mineru-${randomUUID()}.zip`);
    const extractedDirectory = join(workDirectory, "mineru-result");
    await writeFile(archivePath, archive, { mode: 0o600 });
    await extract(archivePath, { dir: extractedDirectory });
    const layoutPath = await findNamedFile(extractedDirectory, "layout.json");
    if (!layoutPath) {
      throw new Error("MinerU 结果中缺少 layout.json，当前无法进行公式坐标增强");
    }
    return layoutPath;
  }
}

async function mineruFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
    signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = redact((await response.text()).slice(0, 500), token);
    throw new Error(`MinerU API 返回 HTTP ${response.status}${body ? `：${body}` : ""}`);
  }
  return response;
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("MinerU API 地址仅支持 HTTP 或 HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function extractUploadUrl(value: unknown): string {
  const entries = arrayValue(value);
  const first = entries[0];
  if (typeof first === "string") return first;
  const record = asRecord(first);
  return stringValue(record?.url ?? record?.file_url ?? record?.upload_url);
}

async function findNamedFile(root: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const nested = await findNamedFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function redact(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "<redacted>") : value;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason || new Error("MinerU 请求已取消"));
      },
      { once: true },
    );
  });
}

function withTimeout(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}
