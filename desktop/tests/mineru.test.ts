import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialStore } from "../src/main/credentials";
import { collectMineruFormulas, MineruManager, normalizeMathJaxSvg } from "../src/main/mineru";
import type { JsonStore } from "../src/main/store";
import type { MineruConfig } from "../src/shared/types";

function createManager(options: { token?: string } = {}) {
  let config = {
    baseUrl: "https://mineru.net/api/v4",
    modelVersion: "vlm" as const,
    formulaRenderer: "mathjax" as const,
  };
  let token = options.token || "";
  const store = {
    getMineruConfig: () => structuredClone(config),
    setMineruConfig: async (value: typeof config) => {
      config = structuredClone(value);
    },
  } as unknown as JsonStore;
  const credentials = {
    has: () => Boolean(token),
    get: () => token,
    set: async (_id: string, value: string) => {
      token = value;
    },
  } as unknown as CredentialStore;
  return new MineruManager(store, credentials);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("MineruManager", () => {
  it("extracts and deduplicates MinerU formulas while rejecting unsafe LaTeX", () => {
    const formula = {
      type: "inline_equation",
      bbox: [44, 547, 147, 563],
      content: String.raw`\operatorname{erfc}(z)=\frac{2}{\sqrt{\pi}}\int_z^\infty e^{-t^2}\,dt`,
    };
    const result = collectMineruFormulas({
      pdf_info: [
        {
          page_size: [612, 792],
          para_blocks: [
            formula,
            { ...formula },
            { ...formula, content: String.raw`\input{secret}` },
          ],
        },
      ],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ page: 0, display: true, pageSize: [612, 792] });
  });

  it("normalizes MathJax ex dimensions to PDF points", () => {
    const result = normalizeMathJaxSvg(
      '<svg style="vertical-align: -2.308ex" width="19.375ex" height="5.476ex"></svg>',
    );

    expect(result.width).toBeCloseTo(83.42, 2);
    expect(result.height).toBeCloseTo(23.58, 2);
    expect(result.depth).toBeCloseTo(9.94, 2);
    expect(result.svg).toContain('width="83.420pt"');
  });

  it("renders a MinerU formula manifest with built-in MathJax", async () => {
    const root = await mkdtemp(join(tmpdir(), "pdf2zh-mathjax-"));
    const layoutPath = join(root, "layout.json");
    await writeFile(
      layoutPath,
      JSON.stringify({
        pdf_info: [
          {
            page_size: [612, 792],
            para_blocks: [
              {
                type: "inline_equation",
                bbox: [44, 547, 147, 563],
                content: String.raw`z=\frac{2}{\sqrt{\pi}}\int_z^\infty e^{-t^2}\,dt`,
              },
            ],
          },
        ],
      }),
      "utf8",
    );
    try {
      const manager = createManager();
      const manifestPath = await manager.prepareFormulaAssets(layoutPath, root);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));

      expect(manifest.renderer).toBe("mathjax");
      expect(manifest.formulas).toHaveLength(1);
      expect(manifest.formulas[0].width).toBeGreaterThan(80);
      expect(await readFile(manifest.formulas[0].svgPath, "utf8")).toContain("<svg");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.skipIf(!process.env.PDF2ZH_TEST_MINERU_LAYOUT || !process.env.PDF2ZH_TEST_FORMULA_WORK)(
    "renders every formula from a real MinerU layout",
    async () => {
      const layoutPath = process.env.PDF2ZH_TEST_MINERU_LAYOUT;
      const workRoot = process.env.PDF2ZH_TEST_FORMULA_WORK;
      if (!layoutPath || !workRoot) throw new Error("missing MinerU integration paths");
      const manifestPath = await createManager().prepareFormulaAssets(layoutPath, workRoot);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      const successful = manifest.formulas.filter(
        (formula: { svgPath?: string }) => formula.svgPath,
      );

      expect(manifest.formulas.length).toBeGreaterThan(0);
      expect(successful.length).toBe(manifest.formulas.length);
      expect(manifestPath).toContain("formula-assets");
    },
    120_000,
  );

  it("saves configuration while keeping the token out of returned data", async () => {
    const manager = createManager();
    const input: MineruConfig = {
      baseUrl: "https://mineru.net/api/v4/",
      modelVersion: "pipeline",
      formulaRenderer: "latex",
      hasApiKey: false,
      apiKey: "secret-token",
    };

    const saved = await manager.saveConfig(input);

    expect(saved).toEqual({
      baseUrl: "https://mineru.net/api/v4",
      modelVersion: "pipeline",
      formulaRenderer: "latex",
      hasApiKey: true,
    });
    expect(saved.apiKey).toBeUndefined();
  });

  it("accepts a non-authentication response as a successful connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not found", { status: 404 })));
    const manager = createManager({ token: "saved-token" });

    const result = await manager.test(manager.getConfig());

    expect(result.ok).toBe(true);
    expect(result.message).toContain("连接成功");
  });

  it("reports authentication failures without exposing the token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    const manager = createManager({ token: "saved-token" });

    const result = await manager.test(manager.getConfig());

    expect(result.ok).toBe(false);
    expect(result.message).toContain("无效");
    expect(result.message).not.toContain("saved-token");
  });
});
