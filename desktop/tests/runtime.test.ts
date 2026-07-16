import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findReusableRuntime,
  resolveRuntimeRoot,
  resolveRuntimeRoots,
  sha256File,
} from "../src/main/file-utils";

describe("runtime integrity", () => {
  it("keeps large runtime assets in LocalAppData on Windows", () => {
    expect(
      resolveRuntimeRoot(
        "C:/Users/test/AppData/Local",
        "C:/Users/test/AppData/Roaming/PDF2ZH Desktop",
      ),
    ).toBe(join("C:/Users/test/AppData/Local", "PDF2ZH Desktop", "runtime"));
  });

  it("derives a stable LocalAppData path when an update process changes the environment", () => {
    expect(
      resolveRuntimeRoot(
        "H:/temporary-update-environment",
        "C:/Users/test/AppData/Roaming/pdf2zh-desktop",
      ),
    ).toBe(join("C:/Users/test/AppData/Local", "PDF2ZH Desktop", "runtime"));
  });

  it("includes legacy and package-name runtime locations as reuse candidates", () => {
    expect(
      resolveRuntimeRoots(
        "C:/Users/test/AppData/Local",
        "C:/Users/test/AppData/Roaming/pdf2zh-desktop",
      ),
    ).toEqual([
      join("C:/Users/test/AppData/Local", "PDF2ZH Desktop", "runtime"),
      join("C:/Users/test/AppData/Roaming/pdf2zh-desktop", "runtime"),
      join("C:/Users/test/AppData/Local", "pdf2zh-desktop", "runtime"),
    ]);
  });

  it("recovers a complete runtime when current.json is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdf2zh-runtime-reuse-"));
    const root = join(directory, "runtime");
    const versionDirectory = join(root, "2.9.0");
    const binary = join(versionDirectory, "pdf2zh", "pdf2zh.exe");
    await mkdir(join(versionDirectory, "pdf2zh"), { recursive: true });
    await writeFile(binary, "binary");
    await writeFile(
      join(versionDirectory, "installed.json"),
      JSON.stringify({ binary: "pdf2zh/pdf2zh.exe" }),
    );

    await expect(findReusableRuntime([root], "2.9.0")).resolves.toEqual({
      root,
      version: "2.9.0",
      versionDirectory,
      binaryPath: binary,
    });
  });

  it("calculates a deterministic SHA-256 digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdf2zh-hash-"));
    const path = join(directory, "asset.zip");
    await writeFile(path, "pdf2zh");
    expect(await sha256File(path)).toBe(
      "d31f5e20aba684712f231b549562f82039b3c225a482f755eb19ea62441048ef",
    );
  });
});
