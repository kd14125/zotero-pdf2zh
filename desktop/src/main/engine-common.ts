import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface EngineIdentity {
  pipeName: string;
  tokenPath: string;
}

export function resolveEngineIdentity(userDataPath: string): EngineIdentity {
  const digest = createHash("sha256")
    .update(userDataPath.replaceAll("\\", "/").toLowerCase())
    .digest("hex")
    .slice(0, 20);
  return {
    pipeName: `\\\\.\\pipe\\pdf2zh-desktop-engine-${digest}`,
    tokenPath: join(userDataPath, "engine-token"),
  };
}

export async function ensureEngineToken(userDataPath: string): Promise<string> {
  const { tokenPath } = resolveEngineIdentity(userDataPath);
  try {
    const token = (await readFile(tokenPath, "utf8")).trim();
    if (/^[a-f0-9]{64}$/.test(token)) return token;
  } catch {
    // Create a new token below.
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(userDataPath, { recursive: true });
  await writeFile(tokenPath, token, { encoding: "utf8", mode: 0o600 });
  return token;
}

export async function readEngineToken(userDataPath: string): Promise<string | undefined> {
  try {
    const token = (await readFile(resolveEngineIdentity(userDataPath).tokenPath, "utf8")).trim();
    return /^[a-f0-9]{64}$/.test(token) ? token : undefined;
  } catch {
    return undefined;
  }
}
