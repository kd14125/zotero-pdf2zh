import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sha256File } from "../src/main/file-utils";

describe("runtime integrity", () => {
  it("calculates a deterministic SHA-256 digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pdf2zh-hash-"));
    const path = join(directory, "asset.zip");
    await writeFile(path, "pdf2zh");
    expect(await sha256File(path)).toBe(
      "d31f5e20aba684712f231b549562f82039b3c225a482f755eb19ea62441048ef",
    );
  });
});
