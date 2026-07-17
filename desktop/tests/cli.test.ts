import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "smol-toml";
import { describe, expect, it } from "vitest";
import type { ProviderProfile, TranslationOptions } from "../src/shared/types";
import {
  buildCliArgs,
  buildProviderConfig,
  extractRuntimeFailure,
  uniqueDestination,
} from "../src/main/task-manager";
import { startOpenAICompatibleBridge } from "../src/main/providers";

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

  it("maps Anthropic Messages through the local OpenAI-compatible bridge", () => {
    const now = new Date().toISOString();
    const profile: ProviderProfile & { apiKey: string } = {
      id: "anthropic-1",
      name: "Anthropic Messages",
      provider: "anthropic",
      baseUrl: "http://127.0.0.1:43123/v1",
      model: "claude-sonnet-4-5",
      apiKey: "local-bridge-key",
      hasApiKey: true,
      extra: {},
      createdAt: now,
      updatedAt: now,
    };

    expect(buildCliArgs("paper.pdf", "output", "config.toml", "anthropic", options)).toContain(
      "--openaicompatible",
    );
    expect(buildProviderConfig(profile)).toEqual({
      openaicompatible_detail: expect.objectContaining({
        translate_engine_type: "OpenAICompatible",
        openai_compatible_base_url: "http://127.0.0.1:43123/v1",
        openai_compatible_api_key: "local-bridge-key",
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

  it.skipIf(
    !process.env.PDF2ZH_TEST_OPENAI_API_KEY ||
      !process.env.PDF2ZH_TEST_RUNTIME ||
      !process.env.PDF2ZH_TEST_PDF ||
      !process.env.PDF2ZH_TEST_WORK_ROOT,
  )(
    "translates a real PDF page through an OpenAI-compatible gateway",
    async () => {
      const apiKey = process.env.PDF2ZH_TEST_OPENAI_API_KEY;
      const runtime = process.env.PDF2ZH_TEST_RUNTIME;
      const inputPdf = process.env.PDF2ZH_TEST_PDF;
      const workRoot = process.env.PDF2ZH_TEST_WORK_ROOT;
      if (!apiKey || !runtime || !inputPdf || !workRoot) {
        throw new Error("missing OpenAI-compatible integration settings");
      }
      await mkdir(workRoot, { recursive: true });
      const runRoot = await mkdtemp(join(workRoot, "run-"));
      const outputRoot = join(runRoot, "output");
      const configPath = join(runRoot, "task-config.toml");
      const logPath = join(runRoot, "pdf2zh.log");
      await mkdir(outputRoot, { recursive: true });
      const now = new Date().toISOString();
      const profile: ProviderProfile & { apiKey: string } = {
        id: "mhapi-gpt-test",
        name: "MHAPI GPT",
        provider: "openaicompatible",
        baseUrl: process.env.PDF2ZH_TEST_OPENAI_BASE_URL || "https://api.mhapi.cn/v1",
        model: process.env.PDF2ZH_TEST_OPENAI_MODEL || "gpt-5.5",
        apiKey,
        hasApiKey: true,
        extra: {},
        createdAt: now,
        updatedAt: now,
      };
      const bridge = await startOpenAICompatibleBridge({
        baseUrl: profile.baseUrl,
        apiKey: profile.apiKey,
      });
      const runtimeProfile = {
        ...profile,
        baseUrl: bridge.baseUrl,
        apiKey: bridge.apiKey,
      };
      await writeFile(configPath, stringify(buildProviderConfig(runtimeProfile)), {
        encoding: "utf8",
        mode: 0o600,
      });
      const args = buildCliArgs(inputPdf, outputRoot, configPath, profile.provider, {
        ...options,
        outputDual: false,
        qps: 1,
        poolSize: 0,
      });
      args.push("--pages", "1");
      let result: { exitCode: number; output: string };
      try {
        result = await runRuntime(runtime, args, apiKey);
      } finally {
        await rm(configPath, { force: true });
        await bridge.close().catch(() => undefined);
      }
      await writeFile(logPath, result.output, "utf8");
      const outputs = (await readdir(outputRoot)).filter((name) => name.endsWith(".pdf"));

      expect(result.exitCode, result.output.slice(-4000)).toBe(0);
      expect(outputs.length).toBeGreaterThan(0);
    },
    600_000,
  );
});

function runRuntime(
  runtime: string,
  args: string[],
  apiKey: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(runtime, args, {
      cwd: dirname(runtime),
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
    });
    let output = "";
    const append = (chunk: Buffer) => {
      output = `${output}${chunk.toString("utf8")}`.replaceAll(apiKey, "<redacted>");
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timeout = setTimeout(() => {
      if (process.platform === "win32") {
        spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGKILL");
      }
    }, 540_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ exitCode: code ?? -1, output });
    });
  });
}
