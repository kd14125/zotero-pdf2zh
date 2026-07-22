import { z } from "zod";

export const ENGINE_PROTOCOL_VERSION = 1;

export const ENGINE_METHODS = [
  "engine.status",
  "engine.shutdown",
  "settings.get",
  "settings.save",
  "providers.list",
  "providers.save",
  "providers.remove",
  "providers.test",
  "providers.models",
  "mineru.get",
  "mineru.save",
  "mineru.test",
  "mineru.latex-state",
  "mineru.latex-install",
  "runtime.state",
  "runtime.ensure",
  "runtime.check-update",
  "runtime.update",
  "runtime.rollback",
  "tasks.list",
  "tasks.enqueue",
  "tasks.cancel",
  "tasks.retry",
  "tasks.optimize-formulas",
  "tasks.remove",
  "tasks.clear-history",
] as const;

export type EngineMethod = (typeof ENGINE_METHODS)[number];
export type EngineEventName = "runtime.changed" | "tasks.changed";

export const engineRequestSchema = z.object({
  version: z.literal(ENGINE_PROTOCOL_VERSION),
  id: z.string().min(1).max(100),
  token: z.string().regex(/^[a-f0-9]{64}$/),
  method: z.enum(ENGINE_METHODS),
  params: z.unknown().optional(),
});

export const engineResponseSchema = z.object({
  version: z.literal(ENGINE_PROTOCOL_VERSION),
  id: z.string().min(1).max(100),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(4000).optional(),
});

export const engineEventSchema = z.object({
  version: z.literal(ENGINE_PROTOCOL_VERSION),
  event: z.enum(["runtime.changed", "tasks.changed"]),
  payload: z.unknown(),
});

export type EngineRequest = z.infer<typeof engineRequestSchema>;
export type EngineResponse = z.infer<typeof engineResponseSchema>;
export type EngineEvent = z.infer<typeof engineEventSchema>;
