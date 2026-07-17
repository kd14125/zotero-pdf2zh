import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/shared/types";
import {
  normalizeProviderBaseUrl,
  ProviderRepository,
  startAnthropicMessagesBridge,
  startOpenAICompatibleBridge,
} from "../src/main/providers";
import type { CredentialStore } from "../src/main/credentials";
import type { JsonStore } from "../src/main/store";

function profile(
  id: string,
  name: string,
  apiKey?: string,
  provider: ProviderProfile["provider"] = "siliconflow",
): ProviderProfile {
  const now = new Date().toISOString();
  return {
    id,
    name,
    provider,
    baseUrl:
      provider === "anthropic" ? "https://api.example.test" : "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen2.5-7B-Instruct",
    hasApiKey: Boolean(apiKey),
    apiKey,
    extra: {},
    createdAt: now,
    updatedAt: now,
  };
}

function repositoryHarness() {
  let profiles: ProviderProfile[] = [];
  const keys = new Map<string, string>();
  const store = {
    getProviders: () => structuredClone(profiles),
    setProviders: async (next: ProviderProfile[]) => {
      profiles = structuredClone(next);
    },
  } as unknown as JsonStore;
  const credentials = {
    set: async (id: string, value: string) => {
      if (value) keys.set(id, value);
      else keys.delete(id);
    },
    get: (id: string) => keys.get(id) || "",
    has: (id: string) => keys.has(id),
    remove: async (id: string) => {
      keys.delete(id);
    },
  } as unknown as CredentialStore;
  return { repository: new ProviderRepository(store, credentials), keys };
}

describe("ProviderRepository", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("adds v1 to a root OpenAI-compatible gateway URL", () => {
    expect(normalizeProviderBaseUrl("openaicompatible", "https://api.mhapi.cn")).toBe(
      "https://api.mhapi.cn/v1",
    );
    expect(normalizeProviderBaseUrl("openaicompatible", "https://example.test/v1")).toBe(
      "https://example.test/v1",
    );
    expect(normalizeProviderBaseUrl("openaicompatible", "https://example.test/custom/openai")).toBe(
      "https://example.test/custom/openai",
    );
  });

  it("uses the normalized URL for saved OpenAI-compatible profiles", async () => {
    const { repository } = repositoryHarness();
    const input = profile("gateway-a", "Gateway A", "saved-key", "openaicompatible");
    input.baseUrl = "https://api.mhapi.cn";

    const saved = await repository.save(input);

    expect(saved.baseUrl).toBe("https://api.mhapi.cn/v1");
    expect(repository.resolve(saved.id).baseUrl).toBe("https://api.mhapi.cn/v1");
  });

  it("strips OpenAI Python SDK headers before forwarding compatible requests", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody: Record<string, unknown> = {};
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        receivedHeaders = request.headers;
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "chatcmpl-test",
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content: "OK" } }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("mock server failed");
    const bridge = await startOpenAICompatibleBridge({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "upstream-secret",
    });
    try {
      const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridge.apiKey}`,
          "content-type": "application/json",
          "user-agent": "OpenAI/Python 2.40.0",
          "x-stainless-lang": "python",
        },
        body: JSON.stringify({
          model: "gpt-test",
          messages: [{ role: "user", content: "Hello" }],
        }),
      });
      const payload = (await response.json()) as { choices: unknown[] };

      expect(response.status).toBe(200);
      expect(payload.choices).toHaveLength(1);
      expect(receivedHeaders.authorization).toBe("Bearer upstream-secret");
      expect(receivedHeaders["x-stainless-lang"]).toBeUndefined();
      expect(receivedHeaders["user-agent"]).not.toBe("OpenAI/Python 2.40.0");
      expect(receivedBody).toEqual({
        model: "gpt-test",
        messages: [{ role: "user", content: "Hello" }],
      });
    } finally {
      await bridge.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("stores API keys independently for multiple profiles", async () => {
    const { repository } = repositoryHarness();

    await repository.save(profile("profile-a", "SiliconFlow A", "key-a"));
    await repository.save(profile("profile-b", "SiliconFlow B", "key-b"));

    expect(repository.list().map(({ id }) => id)).toEqual(["profile-a", "profile-b"]);
    expect(repository.resolve("profile-a").apiKey).toBe("key-a");
    expect(repository.resolve("profile-b").apiKey).toBe("key-b");
  });

  it("loads and deduplicates models with the selected profile credential", async () => {
    const { repository } = repositoryHarness();
    const saved = await repository.save(profile("profile-a", "SiliconFlow A", "saved-key"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "Qwen/Qwen2.5-7B-Instruct" },
            { id: "deepseek-ai/DeepSeek-V3" },
            { id: "Qwen/Qwen2.5-7B-Instruct" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await repository.listModels(saved);

    expect(result).toEqual({
      ok: true,
      message: "已获取 2 个模型",
      models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-7B-Instruct"],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.siliconflow.cn/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer saved-key" } }),
    );
  });

  it("uses Anthropic headers and the v1 models endpoint", async () => {
    const { repository } = repositoryHarness();
    const saved = await repository.save(
      profile("anthropic-a", "Anthropic A", "saved-key", "anthropic"),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await repository.listModels(saved);

    expect(result.models).toEqual(["claude-sonnet-4-5"]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "anthropic-version": "2023-06-01",
          "x-api-key": "saved-key",
        }),
      }),
    );
  });

  it("tests Anthropic Messages with a minimal request and redacts echoed credentials", async () => {
    const { repository } = repositoryHarness();
    const saved = await repository.save(
      profile("anthropic-a", "Anthropic A", "saved-key", "anthropic"),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "invalid saved-key" } }), { status: 403 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await repository.test(saved);

    expect(result.ok).toBe(false);
    expect(result.message).toContain("HTTP 403");
    expect(result.message).toContain("<redacted>");
    expect(result.message).not.toContain("saved-key");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("redacts credentials from Anthropic transport errors", async () => {
    const { repository } = repositoryHarness();
    const saved = await repository.save(
      profile("anthropic-a", "Anthropic A", "saved-key", "anthropic"),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("request failed for saved-key")));

    const result = await repository.listModels(saved);

    expect(result.message).toContain("<redacted>");
    expect(result.message).not.toContain("saved-key");
  });

  it("bridges OpenAI chat completions to Anthropic Messages", async () => {
    let receivedHeaders: Record<string, string | string[] | undefined> = {};
    let receivedBody: Record<string, unknown> = {};
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      request.on("end", () => {
        receivedHeaders = request.headers;
        receivedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "msg_test",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "翻译完成" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 12, output_tokens: 4 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("mock server failed");
    const bridge = await startAnthropicMessagesBridge({
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "upstream-secret",
    });
    try {
      expect(bridge.apiKey).not.toBe("upstream-secret");
      const unauthorized = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridge.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-5",
          messages: [
            { role: "system", content: "Translate accurately." },
            { role: "user", content: "Hello" },
          ],
        }),
      });
      const payload = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
        usage: { total_tokens: number };
      };

      expect(response.status).toBe(200);
      expect(receivedHeaders["x-api-key"]).toBe("upstream-secret");
      expect(receivedHeaders["anthropic-version"]).toBe("2023-06-01");
      expect(receivedBody).toEqual(
        expect.objectContaining({
          model: "claude-sonnet-4-5",
          system: "Translate accurately.",
          messages: [{ role: "user", content: "Hello" }],
        }),
      );
      expect(payload.choices[0].message.content).toBe("翻译完成");
      expect(payload.usage.total_tokens).toBe(16);
    } finally {
      await bridge.close();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it.skipIf(!process.env.PDF2ZH_TEST_ANTHROPIC_API_KEY)(
    "translates a real OpenAI-style request through an Anthropic Messages gateway",
    async () => {
      const apiKey = process.env.PDF2ZH_TEST_ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("missing integration API key");
      const bridge = await startAnthropicMessagesBridge({
        baseUrl: process.env.PDF2ZH_TEST_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
        apiKey,
      });
      try {
        const response = await fetch(`${bridge.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bridge.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: process.env.PDF2ZH_TEST_ANTHROPIC_MODEL || "claude-sonnet-4-6",
            messages: [
              { role: "system", content: "Translate accurately." },
              { role: "user", content: "Translate 'Hello' to Simplified Chinese." },
            ],
          }),
        });
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };

        expect(response.status).toBe(200);
        expect(payload.choices?.[0]?.message?.content?.trim().length).toBeGreaterThan(0);
      } finally {
        await bridge.close();
      }
    },
  );
});
