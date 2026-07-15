import { describe, expect, it } from "vitest";
import {
  enqueueRequestSchema,
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
      }),
    ).toThrow("至少选择一种输出文件");
  });

  it("rejects unsupported providers and empty task lists", () => {
    expect(() => providerProfileSchema.parse({ provider: "google" })).toThrow();
    expect(() => enqueueRequestSchema.parse({ inputPaths: [] })).toThrow();
  });
});
