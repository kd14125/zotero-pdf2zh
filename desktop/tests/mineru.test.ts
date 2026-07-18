import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialStore } from "../src/main/credentials";
import { MineruManager } from "../src/main/mineru";
import type { JsonStore } from "../src/main/store";
import type { MineruConfig } from "../src/shared/types";

function createManager(options: { token?: string } = {}) {
  let config = { baseUrl: "https://mineru.net/api/v4", modelVersion: "vlm" as const };
  let token = options.token || "";
  const store = {
    getMineruConfig: () => structuredClone(config),
    setMineruConfig: async (value: typeof config) => {
      config = structuredClone(value);
    },
  } as unknown as JsonStore;
  const credentials = {
    has: () => Boolean(token),
    get: () => token,
    set: async (_id: string, value: string) => {
      token = value;
    },
  } as unknown as CredentialStore;
  return new MineruManager(store, credentials);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MineruManager", () => {
  it("saves configuration while keeping the token out of returned data", async () => {
    const manager = createManager();
    const input: MineruConfig = {
      baseUrl: "https://mineru.net/api/v4/",
      modelVersion: "pipeline",
      hasApiKey: false,
      apiKey: "secret-token",
    };

    const saved = await manager.saveConfig(input);

    expect(saved).toEqual({
      baseUrl: "https://mineru.net/api/v4",
      modelVersion: "pipeline",
      hasApiKey: true,
    });
    expect(saved.apiKey).toBeUndefined();
  });

  it("accepts a non-authentication response as a successful connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const manager = createManager({ token: "saved-token" });

    const result = await manager.test(manager.getConfig());

    expect(result.ok).toBe(true);
    expect(result.message).toContain("连接成功");
  });

  it("reports authentication failures without exposing the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    const manager = createManager({ token: "saved-token" });

    const result = await manager.test(manager.getConfig());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("无效");
    expect(result.message).not.toContain("saved-token");
  });
});
