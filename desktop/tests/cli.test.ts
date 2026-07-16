import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderProfile, TranslationOptions } from "../src/shared/types";
import {
  buildCliArgs,
  buildProviderConfig,
  extractRuntimeFailure,
  uniqueDestination,
} from "../src/main/task-manager";

const options: TranslationOptions = {
  sourceLanguage: "en",
  targetLanguage: "zh-CN",
  outputMono: true,
  outputDual: true,
  dualMode: "LR",
  noWatermark: true,
  ocrWorkaround: false,
  autoOcr: true,
  saveGlossary: false,
  disableGlossary: false,
  translateFirst: true,
  qps: 8,
  poolSize: 12,
};

describe("CLI mapping", () => {
  it("surfaces an insufficient provider balance even when the runtime exits with code zero", () => {
    expect(
      extractRuntimeFailure([
        "openai.PermissionDeniedError: Error code: 403 - Sorry, your account balance is insufficient",
      ]),
    ).toBe("API 账户余额不足（HTTP 403），请充值或切换翻译配置");
  });

  it("maps paths and translation options to discrete arguments", () => {
    const args = buildCliArgs(
      "I:/论文/a b.pdf",
      "I:/输出",
      "I:/临时/config.toml",
      "deepseek",
      options,
    );
    expect(args[0]).toBe("I:/论文/a b.pdf");
    expect(args).toContain("--deepseek");
    expect(args).toContain("--auto-enable-ocr-workaround");
    expect(args).toContain("--pool-max-workers");
    expect(args).not.toContain("--no-mono");
  });

  it("disables rich text translation for SiliconFlow Free", () => {
    const args = buildCliArgs(
      "I:/论文/paper.pdf",
      "I:/输出",
      "I:/临时/config.toml",
      "siliconflowfree",
      options,
    );

    expect(args).toContain("--disable-rich-text-translate");
  });

  it("builds the correct OpenAI-compatible TOML shape", () => {
    const now = new Date().toISOString();
    const profile: ProviderProfile & { apiKey: string } = {
      id: "p1",
      name: "自定义",
      provider: "openaicompatible",
      baseUrl: "https://example.test/v1",
      model: "model-a",
      apiKey: "secret",
      hasApiKey: true,
      extra: { openai_compatible_timeout: 120 },
      createdAt: now,
      updatedAt: now,
    };
    expect(buildProviderConfig(profile)).toEqual({
      openaicompatible_detail: expect.objectContaining({
        translate_engine_type: "OpenAICompatible",
        openai_compatible_api_key: "secret",
        openai_compatible_timeout: 120,
      }),
    });
  });

  it("never overwrites an existing result", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdf2zh-destination-"));
    await writeFile(join(directory, "paper.zh-CN.mono.pdf"), "existing");
    expect(await uniqueDestination(directory, "paper.zh-CN.mono.pdf")).toBe(
      join(directory, "paper.zh-CN.mono (2).pdf"),
    );
  });
});
