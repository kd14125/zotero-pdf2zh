import { describe, expect, it } from "vitest";
import {
  enqueueRequestSchema,
  mineruConfigSchema,
  providerProfileSchema,
  translationOptionsSchema,
} from "../src/shared/schemas";

describe("IPC schemas", () => {
  it("rejects a translation without any output", () => {
    expect(() =>
      translationOptionsSchema.parse({
        sourceLanguage: "en",
        targetLanguage: "zh-CN",
        outputMono: false,
        outputDual: false,
        dualMode: "LR",
        noWatermark: true,
        ocrWorkaround: false,
        autoOcr: true,
        saveGlossary: false,
        disableGlossary: false,
        translateFirst: true,
        qps: 10,
        poolSize: 0,
        mineruFormulaEnhancement: false,
      }),
    ).toThrow("至少选择一种输出文件");
  });

  it("rejects unsupported providers and empty task lists", () => {
    expect(() => providerProfileSchema.parse({ provider: "google" })).toThrow();
    expect(() => enqueueRequestSchema.parse({ inputPaths: [] })).toThrow();
  });

  it("accepts the official MinerU API configuration", () => {
    expect(
      mineruConfigSchema.parse({
        baseUrl: "https://mineru.net/api/v4",
        modelVersion: "vlm",
        formulaRenderer: "mathjax",
        hasApiKey: true,
      }),
    ).toMatchObject({ modelVersion: "vlm", formulaRenderer: "mathjax" });
  });
});
