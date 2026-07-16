import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ReusableRuntime {
  root: string;
  version: string;
  versionDirectory: string;
  binaryPath: string;
}

export function resolveRuntimeRoot(localAppData: string | undefined, userData: string): string {
  const stableLocalAppData = resolveLocalAppData(localAppData, userData);
  return stableLocalAppData
    ? join(stableLocalAppData, "PDF2ZH Desktop", "runtime")
    : join(userData, "runtime");
}

export function resolveRuntimeRoots(localAppData: string | undefined, userData: string): string[] {
  const stableLocalAppData = resolveLocalAppData(localAppData, userData);
  const roots = [resolveRuntimeRoot(localAppData, userData), join(userData, "runtime")];
  if (stableLocalAppData) roots.push(join(stableLocalAppData, "pdf2zh-desktop", "runtime"));
  return [...new Set(roots)];
}

function resolveLocalAppData(
  localAppData: string | undefined,
  userData: string,
): string | undefined {
  const appDataDirectory = dirname(userData);
  if (basename(appDataDirectory).toLowerCase() === "roaming") {
    return join(dirname(appDataDirectory), "Local");
  }
  return localAppData;
}

export async function findReusableRuntime(
  roots: string[],
  preferredVersion?: string,
): Promise<ReusableRuntime | undefined> {
  for (const root of roots) {
    const versions = await runtimeVersions(root, preferredVersion);
    for (const version of versions) {
      const versionDirectory = join(root, version);
      try {
        const installed = JSON.parse(
          await readFile(join(versionDirectory, "installed.json"), "utf8"),
        ) as { binary?: unknown };
        if (typeof installed.binary !== "string" || !installed.binary) continue;
        const binaryPath = resolve(versionDirectory, installed.binary);
        const relativeBinary = relative(versionDirectory, binaryPath);
        if (relativeBinary.startsWith("..") || isAbsolute(relativeBinary)) continue;
        await access(binaryPath);
        return { root, version, versionDirectory, binaryPath };
      } catch {
        // Continue scanning other installed versions and legacy roots.
      }
    }
  }
  return undefined;
}

async function runtimeVersions(root: string, preferredVersion?: string): Promise<string[]> {
  let currentVersion: string | undefined;
  try {
    const current = JSON.parse(await readFile(join(root, "current.json"), "utf8")) as {
      version?: unknown;
    };
    if (typeof current.version === "string") currentVersion = current.version;
  } catch {
    // Missing or damaged state files are recovered by scanning version directories.
  }
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const installedVersions = entries
      .filter((entry) => entry.isDirectory() && !entry.name.endsWith(".extracting"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return [
      ...new Set(
        [currentVersion, preferredVersion, ...installedVersions].filter(
          (version): version is string => Boolean(version),
        ),
      ),
    ];
  } catch {
    return [
      ...new Set(
        [currentVersion, preferredVersion].filter((version): version is string => Boolean(version)),
      ),
    ];
  }
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
