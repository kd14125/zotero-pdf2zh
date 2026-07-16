import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { engineRequestSchema } from "../src/shared/engine-protocol";
import { ensureEngineToken, resolveEngineIdentity } from "../src/main/engine-common";

describe("engine identity", () => {
  it("creates a stable per-user pipe name and a private handshake token", async () => {
    const userData = await mkdtemp(join(tmpdir(), "pdf2zh-engine-"));
    const first = resolveEngineIdentity(userData);
    const second = resolveEngineIdentity(userData.replaceAll("/", "\\").toUpperCase());
    expect(first.pipeName).toBe(second.pipeName);
    expect(first.pipeName).toMatch(/^\\\\\.\\pipe\\pdf2zh-desktop-engine-[a-f0-9]{20}$/);

    const token = await ensureEngineToken(userData);
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    await expect(readFile(first.tokenPath, "utf8")).resolves.toBe(token);
    await expect(ensureEngineToken(userData)).resolves.toBe(token);
  });

  it("rejects requests with malformed authentication data", () => {
    expect(() =>
      engineRequestSchema.parse({
        version: 1,
        id: "request-1",
        token: "not-a-token",
        method: "tasks.list",
      }),
    ).toThrow();
  });
});
