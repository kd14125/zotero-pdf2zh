import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/shared/types";
import { ProviderRepository } from "../src/main/providers";
import type { CredentialStore } from "../src/main/credentials";
import type { JsonStore } from "../src/main/store";

function profile(id: string, name: string, apiKey?: string): ProviderProfile {
  const now = new Date().toISOString();
  return {
    id,
    name,
    provider: "siliconflow",
    baseUrl: "https://api.siliconflow.cn/v1",
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
});
