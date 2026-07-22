import { z } from "zod";
import { PROVIDER_IDS } from "./types";

export const providerIdSchema = z.enum(PROVIDER_IDS);

export const providerProfileSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  provider: providerIdSchema,
  baseUrl: z.string().trim().max(500),
  model: z.string().trim().max(200),
  hasApiKey: z.boolean(),
  apiKey: z.string().max(1000).optional(),
  extra: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const translationOptionsSchema = z
  .object({
    sourceLanguage: z.string().min(2).max(20),
    targetLanguage: z.string().min(2).max(20),
    outputMono: z.boolean(),
    outputDual: z.boolean(),
    dualMode: z.enum(["LR", "TB"]),
    noWatermark: z.boolean(),
    ocrWorkaround: z.boolean(),
    autoOcr: z.boolean(),
    saveGlossary: z.boolean(),
    disableGlossary: z.boolean(),
    translateFirst: z.boolean(),
    qps: z.number().int().min(1).max(10000),
    poolSize: z.number().int().min(0).max(10000),
    mineruFormulaEnhancement: z.boolean(),
    outputDirectory: z.string().max(1000).optional(),
  })
  .refine((value) => value.outputMono || value.outputDual, {
    message: "至少选择一种输出文件",
  });

export const enqueueRequestSchema = z.object({
  inputPaths: z.array(z.string().min(1)).min(1).max(200),
  profileId: z.string().min(1),
  options: translationOptionsSchema,
  formulaEnhancement: z.boolean().optional(),
  sourceTaskId: z.string().min(1).max(100).optional(),
});

export const mineruConfigSchema = z.object({
  baseUrl: z.string().trim().url().max(500),
  modelVersion: z.enum(["vlm", "pipeline"]),
  formulaRenderer: z.enum(["mathjax", "latex"]),
  hasApiKey: z.boolean(),
  apiKey: z.string().max(2000).optional(),
});

export const appSettingsSchema = z.object({
  activeProfileId: z.string().optional(),
  runtimeMirrorUrl: z.string().max(1000),
  lastOptions: translationOptionsSchema,
});

export const pathSchema = z.string().min(1).max(4000);
export const idSchema = z.string().min(1).max(100);
