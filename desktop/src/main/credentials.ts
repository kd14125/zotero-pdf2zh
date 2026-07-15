import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export class CredentialStore {
  private readonly filePath: string;
  private encrypted: Record<string, string> = {};

  constructor(filePath = join(app.getPath("userData"), "secrets.json")) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    try {
      this.encrypted = JSON.parse(await readFile(this.filePath, "utf8")) as Record<string, string>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.encrypted = {};
    }
  }

  async set(id: string, value: string): Promise<void> {
    if (!value) {
      delete this.encrypted[id];
    } else {
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("Windows 凭据加密当前不可用，API Key 未保存");
      }
      this.encrypted[id] = safeStorage.encryptString(value).toString("base64");
    }
    await this.flush();
  }

  get(id: string): string {
    const value = this.encrypted[id];
    if (!value) return "";
    if (!safeStorage.isEncryptionAvailable()) return "";
    try {
      return safeStorage.decryptString(Buffer.from(value, "base64"));
    } catch {
      return "";
    }
  }

  has(id: string): boolean {
    return Boolean(this.encrypted[id]);
  }

  async remove(id: string): Promise<void> {
    delete this.encrypted[id];
    await this.flush();
  }

  private async flush(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(this.encrypted, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
  }
}
