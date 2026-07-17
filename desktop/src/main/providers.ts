import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProviderModelsResult, ProviderProfile, ProviderTestResult } from "../shared/types";
import { CredentialStore } from "./credentials";
import { JsonStore } from "./store";

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;
const PROVIDER_TIMEOUT_MS = 15_000;
const BRIDGE_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_BRIDGE_REQUEST_BYTES = 2_000_000;

const DEFAULT_URLS: Record<ProviderProfile["provider"], string> = {
  siliconflowfree: "",
  openai: "https://api.openai.com/v1",
  aliyundashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  deepseek: "https://api.deepseek.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  openaicompatible: "",
  anthropic: "https://api.anthropic.com",
};

export interface ProviderProtocolBridge {
  baseUrl: string;
  apiKey: string;
  close(): Promise<void>;
}

export type AnthropicMessagesBridge = ProviderProtocolBridge;
export type OpenAICompatibleBridge = ProviderProtocolBridge;

export class ProviderRepository {
  constructor(
    private readonly store: JsonStore,
    private readonly credentials: CredentialStore,
  ) {}

  list(): ProviderProfile[] {
    return this.store.getProviders().map((profile) => this.sanitize(profile));
  }

  async save(input: ProviderProfile): Promise<ProviderProfile> {
    const profiles = this.store.getProviders();
    const existing = profiles.find((profile) => profile.id === input.id);
    const now = new Date().toISOString();
    const profile: ProviderProfile = {
      ...input,
      baseUrl: normalizeProviderBaseUrl(
        input.provider,
        input.baseUrl || DEFAULT_URLS[input.provider],
      ),
      apiKey: undefined,
      hasApiKey:
        input.provider === "siliconflowfree" ? false : Boolean(input.apiKey || existing?.hasApiKey),
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    if (input.apiKey !== undefined) await this.credentials.set(profile.id, input.apiKey);
    profile.hasApiKey = this.credentials.has(profile.id);
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    await this.store.setProviders(profiles);
    return this.sanitize(profile);
  }

  async remove(id: string): Promise<void> {
    await this.store.setProviders(this.store.getProviders().filter((profile) => profile.id !== id));
    await this.credentials.remove(id);
  }

  resolve(id: string): ProviderProfile & { apiKey: string } {
    const profile = this.store.getProviders().find((item) => item.id === id);
    if (!profile) throw new Error("翻译服务配置不存在");
    const apiKey = this.credentials.get(id);
    if (profile.provider !== "siliconflowfree" && !apiKey)
      throw new Error("该配置尚未保存 API Key");
    return {
      ...profile,
      baseUrl: normalizeProviderBaseUrl(profile.provider, profile.baseUrl),
      apiKey,
    };
  }

  async test(input: ProviderProfile): Promise<ProviderTestResult> {
    if (input.provider === "siliconflowfree") {
      return { ok: true, message: "该服务无需 API Key，运行时将在翻译时验证可用性" };
    }
    const apiKey = input.apiKey || this.credentials.get(input.id);
    if (!apiKey) return { ok: false, message: "请先填写 API Key" };
    const baseUrl = normalizeProviderBaseUrl(
      input.provider,
      input.baseUrl || DEFAULT_URLS[input.provider],
    );
    if (!baseUrl) return { ok: false, message: "请填写 API Base URL" };
    const started = Date.now();
    try {
      const isAnthropic = input.provider === "anthropic";
      if (isAnthropic && !input.model.trim()) {
        return { ok: false, message: "请先填写模型名称" };
      }
      const response = await fetch(
        providerEndpoint(input.provider, baseUrl, isAnthropic ? "messages" : "models"),
        isAnthropic
          ? {
              method: "POST",
              headers: {
                ...providerHeaders(input.provider, apiKey),
                "content-type": "application/json",
              },
              body: JSON.stringify({
                model: input.model.trim(),
                max_tokens: 1,
                messages: [{ role: "user", content: "Reply with OK." }],
              }),
              signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
            }
          : {
              headers: providerHeaders(input.provider, apiKey),
              signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
            },
      );
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return {
          ok: false,
          message: await providerErrorMessage(response, "服务返回", apiKey),
          latencyMs,
        };
      }
      return { ok: true, message: "连接成功，API Key 可用", latencyMs };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? redactSecret(error.message, apiKey) : "连接失败",
        latencyMs: Date.now() - started,
      };
    }
  }

  async listModels(input: ProviderProfile): Promise<ProviderModelsResult> {
    if (input.provider === "siliconflowfree") {
      return { ok: false, message: "该免费服务不提供模型列表", models: [] };
    }
    const apiKey = input.apiKey || this.credentials.get(input.id);
    if (!apiKey) return { ok: false, message: "请先填写 API Key", models: [] };
    const baseUrl = normalizeProviderBaseUrl(
      input.provider,
      input.baseUrl || DEFAULT_URLS[input.provider],
    );
    if (!baseUrl) return { ok: false, message: "请填写 API Base URL", models: [] };

    let endpoint: string;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, message: "API Base URL 仅支持 HTTP 或 HTTPS", models: [] };
      }
      endpoint = providerEndpoint(input.provider, baseUrl, "models");
    } catch {
      return { ok: false, message: "API Base URL 格式无效", models: [] };
    }

    try {
      const response = await fetch(endpoint, {
        headers: providerHeaders(input.provider, apiKey),
        signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          ok: false,
          message: await providerErrorMessage(response, "获取模型失败", apiKey),
          models: [],
        };
      }
      const body = await response.text();
      if (body.length > MAX_RESPONSE_BYTES) {
        return { ok: false, message: "模型列表响应过大", models: [] };
      }
      const models = extractModelIds(JSON.parse(body));
      if (!models.length) {
        return { ok: false, message: "接口未返回可用模型", models: [] };
      }
      return { ok: true, message: `已获取 ${models.length} 个模型`, models };
    } catch (error) {
      return {
        ok: false,
        message:
          error instanceof Error
            ? `获取模型失败：${redactSecret(error.message, apiKey)}`
            : "获取模型失败",
        models: [],
      };
    }
  }

  private sanitize(profile: ProviderProfile): ProviderProfile {
    return { ...profile, apiKey: undefined, hasApiKey: this.credentials.has(profile.id) };
  }
}

export async function startAnthropicMessagesBridge(input: {
  baseUrl: string;
  apiKey: string;
}): Promise<AnthropicMessagesBridge> {
  const upstreamUrl = providerEndpoint("anthropic", input.baseUrl, "messages");
  const localApiKey = randomUUID();
  const abortController = new AbortController();
  const server = createServer((request, response) => {
    void handleAnthropicBridgeRequest(request, response, {
      upstreamUrl,
      upstreamApiKey: input.apiKey,
      localApiKey,
      signal: abortController.signal,
    }).catch((error) => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: {
            type: "anthropic_bridge_error",
            message:
              error instanceof Error
                ? redactSecret(error.message, input.apiKey)
                : "Anthropic 协议转换失败",
          },
        });
      } else {
        response.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new Error("无法启动 Anthropic 本地协议适配器");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: localApiKey,
    close: () =>
      new Promise<void>((resolve, reject) => {
        abortController.abort();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export async function startOpenAICompatibleBridge(input: {
  baseUrl: string;
  apiKey: string;
}): Promise<OpenAICompatibleBridge> {
  const upstreamUrl = providerEndpoint("openaicompatible", input.baseUrl, "chat/completions");
  const localApiKey = randomUUID();
  const abortController = new AbortController();
  const server = createServer((request, response) => {
    void handleOpenAICompatibleBridgeRequest(request, response, {
      upstreamUrl,
      upstreamApiKey: input.apiKey,
      localApiKey,
      signal: abortController.signal,
    }).catch((error) => {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: {
            type: "openai_compatible_bridge_error",
            message:
              error instanceof Error
                ? redactSecret(error.message, input.apiKey)
                : "OpenAI Compatible 协议转发失败",
          },
        });
      } else {
        response.end();
      }
    });
  });
  await listenOnLoopback(server);
  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new Error("无法启动 OpenAI Compatible 本地适配器");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey: localApiKey,
    close: () => closeBridgeServer(server, abortController),
  };
}

async function handleOpenAICompatibleBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    upstreamUrl: string;
    upstreamApiKey: string;
    localApiKey: string;
    signal: AbortSignal;
  },
): Promise<void> {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (request.method !== "POST" || !["/v1/chat/completions", "/chat/completions"].includes(path)) {
    writeJson(response, 404, { error: { type: "not_found", message: "Not found" } });
    return;
  }
  if (request.headers.authorization !== `Bearer ${options.localApiKey}`) {
    writeJson(response, 401, { error: { type: "authentication_error", message: "Unauthorized" } });
    return;
  }
  const requestBody = await readJsonBody(request);
  const upstream = await fetch(options.upstreamUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${options.upstreamApiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(BRIDGE_TIMEOUT_MS)]),
  });
  let upstreamBody = await upstream.text();
  if (upstreamBody.length > MAX_RESPONSE_BYTES) {
    throw new Error("OpenAI Compatible 响应过大");
  }
  if (!upstream.ok) upstreamBody = redactSecret(upstreamBody, options.upstreamApiKey);
  response.writeHead(upstream.status, {
    "content-type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
  });
  response.end(upstreamBody);
}

function listenOnLoopback(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeBridgeServer(
  server: ReturnType<typeof createServer>,
  abortController: AbortController,
): Promise<void> {
  return new Promise((resolve, reject) => {
    abortController.abort();
    server.closeAllConnections();
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function handleAnthropicBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    upstreamUrl: string;
    upstreamApiKey: string;
    localApiKey: string;
    signal: AbortSignal;
  },
): Promise<void> {
  const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
  if (request.method !== "POST" || !["/v1/chat/completions", "/chat/completions"].includes(path)) {
    writeJson(response, 404, { error: { type: "not_found", message: "Not found" } });
    return;
  }
  if (request.headers.authorization !== `Bearer ${options.localApiKey}`) {
    writeJson(response, 401, { error: { type: "authentication_error", message: "Unauthorized" } });
    return;
  }
  const openAiRequest = await readJsonBody(request);
  const anthropicRequest = toAnthropicRequest(openAiRequest);
  const upstream = await fetch(options.upstreamUrl, {
    method: "POST",
    headers: {
      ...providerHeaders("anthropic", options.upstreamApiKey),
      "content-type": "application/json",
    },
    body: JSON.stringify(anthropicRequest),
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(BRIDGE_TIMEOUT_MS)]),
  });
  const upstreamBody = await upstream.text();
  if (upstreamBody.length > MAX_RESPONSE_BYTES) {
    throw new Error("Anthropic 响应过大");
  }
  if (!upstream.ok) {
    writeJson(response, upstream.status, {
      error: {
        type: "anthropic_api_error",
        message:
          redactSecret(extractErrorMessage(upstreamBody), options.upstreamApiKey) ||
          `Anthropic API 返回 HTTP ${upstream.status}`,
      },
    });
    return;
  }
  const payload = JSON.parse(upstreamBody) as unknown;
  writeJson(response, 200, toOpenAiResponse(payload, String(openAiRequest.model || "")));
}

function toAnthropicRequest(input: Record<string, unknown>): Record<string, unknown> {
  if (input.stream === true) throw new Error("Anthropic 适配器暂不支持流式请求");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model) throw new Error("Anthropic 请求缺少模型名称");
  if (!Array.isArray(input.messages)) throw new Error("Anthropic 请求缺少消息列表");

  const system: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of input.messages) {
    const message = asRecord(item);
    const role = message?.role;
    const content = contentAsText(message?.content);
    if (!content) continue;
    if (role === "system" || role === "developer") {
      system.push(content);
    } else if (role === "user" || role === "assistant") {
      const previous = messages.at(-1);
      if (previous?.role === role) previous.content += `\n\n${content}`;
      else messages.push({ role, content });
    }
  }
  if (!messages.length) throw new Error("Anthropic 请求没有可发送的用户消息");

  const maxTokens = numericValue(input.max_tokens ?? input.max_completion_tokens);
  const result: Record<string, unknown> = {
    model,
    max_tokens: maxTokens || ANTHROPIC_DEFAULT_MAX_TOKENS,
    messages,
  };
  if (system.length) result.system = system.join("\n\n");
  if (typeof input.temperature === "number") result.temperature = input.temperature;
  if (typeof input.top_p === "number") result.top_p = input.top_p;
  if (typeof input.stop === "string") result.stop_sequences = [input.stop];
  else if (Array.isArray(input.stop)) {
    result.stop_sequences = input.stop.filter(
      (value): value is string => typeof value === "string",
    );
  }
  return result;
}

function toOpenAiResponse(payload: unknown, fallbackModel: string): Record<string, unknown> {
  const root = asRecord(payload);
  if (!root) throw new Error("Anthropic 返回了无效响应");
  const content = Array.isArray(root.content)
    ? root.content
        .map((item) => asRecord(item))
        .filter((item) => item?.type === "text" && typeof item.text === "string")
        .map((item) => item?.text as string)
        .join("")
    : "";
  if (!content) throw new Error("Anthropic 响应中没有文本内容");
  const usage = asRecord(root.usage);
  const promptTokens = numericValue(usage?.input_tokens);
  const completionTokens = numericValue(usage?.output_tokens);
  return {
    id: typeof root.id === "string" ? root.id : `chatcmpl-${randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof root.model === "string" ? root.model : fallbackModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: root.stop_reason === "max_tokens" ? "length" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function providerHeaders(
  provider: ProviderProfile["provider"],
  apiKey: string,
): Record<string, string> {
  if (provider === "anthropic") {
    return {
      Authorization: `Bearer ${apiKey}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "x-api-key": apiKey,
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}

function providerEndpoint(
  provider: ProviderProfile["provider"],
  baseUrl: string,
  resource: "models" | "messages" | "chat/completions",
): string {
  if (provider !== "anthropic") {
    const normalized = normalizeProviderBaseUrl(provider, baseUrl);
    return normalized.endsWith(`/${resource}`) ? normalized : `${normalized}/${resource}`;
  }
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("API Base URL 仅支持 HTTP 或 HTTPS");
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  path = path.replace(/\/v1\/(models|messages)$/i, "/v1");
  parsed.pathname = path.endsWith("/v1") ? `${path}/${resource}` : `${path}/v1/${resource}`;
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeProviderBaseUrl(
  provider: ProviderProfile["provider"],
  baseUrl: string,
): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (provider !== "openaicompatible" || !trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return trimmed;
    let path = parsed.pathname.replace(/\/+$/, "");
    path = path.replace(/\/(chat\/completions|models)$/i, "");
    if (!path) path = "/v1";
    parsed.pathname = path;
    parsed.hash = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

async function providerErrorMessage(
  response: Response,
  prefix: string,
  apiKey: string,
): Promise<string> {
  const body = await response.text();
  const detail = redactSecret(extractErrorMessage(body), apiKey);
  return detail
    ? `${prefix}：${detail}（HTTP ${response.status}）`
    : `${prefix} HTTP ${response.status}`;
}

function redactSecret(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "<redacted>") : value;
}

function extractErrorMessage(body: string): string {
  try {
    const root = asRecord(JSON.parse(body));
    const error = asRecord(root?.error);
    const value =
      error?.message ?? root?.message ?? (typeof root?.error === "string" ? root.error : "");
    return typeof value === "string" ? value.slice(0, 500) : "";
  } catch {
    return "";
  }
}

function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk) => {
      const buffer = Buffer.from(chunk);
      size += buffer.length;
      if (size <= MAX_BRIDGE_REQUEST_BYTES) chunks.push(buffer);
    });
    request.on("error", reject);
    request.on("end", () => {
      if (size > MAX_BRIDGE_REQUEST_BYTES) {
        reject(new Error("OpenAI 请求过大"));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const record = asRecord(parsed);
        if (!record) throw new Error("请求正文必须是 JSON 对象");
        resolve(record);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function contentAsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((item) => asRecord(item))
    .filter((item) => item && ["text", "input_text"].includes(String(item.type)))
    .map((item) => (typeof item?.text === "string" ? item.text : ""))
    .filter(Boolean)
    .join("\n");
}

function numericValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function extractModelIds(payload: unknown): string[] {
  const root = asRecord(payload);
  const result = asRecord(root?.result);
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : Array.isArray(result?.data)
          ? result.data
          : [];
  const ids = candidates
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      const value = record?.id ?? record?.name ?? record?.model;
      return typeof value === "string" ? value : "";
    })
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= 200);
  return [...new Set(ids)].sort((left, right) =>
    left.localeCompare(right, "en", { sensitivity: "base" }),
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
