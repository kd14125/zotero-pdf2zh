import type { ProviderModelsResult, ProviderProfile, ProviderTestResult } from "../shared/types";
import { CredentialStore } from "./credentials";
import { JsonStore } from "./store";

const DEFAULT_URLS: Record<ProviderProfile["provider"], string> = {
  siliconflowfree: "",
  openai: "https://api.openai.com/v1",
  aliyundashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  deepseek: "https://api.deepseek.com/v1",
  siliconflow: "https://api.siliconflow.cn/v1",
  zhipu: "https://open.bigmodel.cn/api/paas/v4",
  openaicompatible: "",
};

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
      baseUrl: input.baseUrl || DEFAULT_URLS[input.provider],
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
    return { ...profile, apiKey };
  }

  async test(input: ProviderProfile): Promise<ProviderTestResult> {
    if (input.provider === "siliconflowfree") {
      return { ok: true, message: "该服务无需 API Key，运行时将在翻译时验证可用性" };
    }
    const apiKey = input.apiKey || this.credentials.get(input.id);
    if (!apiKey) return { ok: false, message: "请先填写 API Key" };
    const baseUrl = (input.baseUrl || DEFAULT_URLS[input.provider]).replace(/\/$/, "");
    if (!baseUrl) return { ok: false, message: "请填写 API Base URL" };
    const started = Date.now();
    try {
      const response = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      const latencyMs = Date.now() - started;
      if (!response.ok) {
        return { ok: false, message: `服务返回 HTTP ${response.status}`, latencyMs };
      }
      return { ok: true, message: "连接成功，API Key 可用", latencyMs };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "连接失败",
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
    const baseUrl = (input.baseUrl || DEFAULT_URLS[input.provider]).trim().replace(/\/+$/, "");
    if (!baseUrl) return { ok: false, message: "请填写 API Base URL", models: [] };

    let endpoint: string;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { ok: false, message: "API Base URL 仅支持 HTTP 或 HTTPS", models: [] };
      }
      endpoint = baseUrl.endsWith("/models") ? baseUrl : `${baseUrl}/models`;
    } catch {
      return { ok: false, message: "API Base URL 格式无效", models: [] };
    }

    try {
      const response = await fetch(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        return { ok: false, message: `获取模型失败：HTTP ${response.status}`, models: [] };
      }
      const body = await response.text();
      if (body.length > 2_000_000) {
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
        message: error instanceof Error ? `获取模型失败：${error.message}` : "获取模型失败",
        models: [],
      };
    }
  }

  private sanitize(profile: ProviderProfile): ProviderProfile {
    return { ...profile, apiKey: undefined, hasApiKey: this.credentials.has(profile.id) };
  }
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
