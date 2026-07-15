import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { join } from "node:path";

export function resolveRuntimeRoot(localAppData: string | undefined, userData: string): string {
  return localAppData ? join(localAppData, "PDF2ZH Desktop", "runtime") : join(userData, "runtime");
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", resolve)
      .on("error", reject);
  });
  return hash.digest("hex");
}
