import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import extract from "extract-zip";
import type { LatexState, MineruConfig, MineruTestResult } from "../shared/types";
import { CredentialStore } from "./credentials";
import { JsonStore } from "./store";

const MINERU_CREDENTIAL_ID = "__mineru_api_token__";
const REQUEST_TIMEOUT_MS = 30_000;
const PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
const POLL_INTERVAL_MS = 3_000;
const MAX_INPUT_BYTES = 200 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const MAX_FORMULAS = 2_000;
const MATHJAX_EX_TO_PT = 4.30554;
const LATEX_INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const UNSAFE_LATEX =
  /\\(?:input|include|write18|openin|openout|read|usepackage|documentclass|catcode|newread|newwrite|special)\b/i;

export interface MineruFormulaAsset {
  id: string;
  page: number;
  kind: string;
  bbox: [number, number, number, number];
  pageSize: [number, number];
  latex: string;
  display: boolean;
  svgPath?: string;
  width?: number;
  height?: number;
  depth?: number;
  renderError?: string;
}

let mathJaxPromise: Promise<any> | undefined;

export class MineruManager {
  private latexInstalling = false;

  constructor(
    private readonly store: JsonStore,
    private readonly credentials: CredentialStore,
  ) {}

  getConfig(): MineruConfig {
    return {
      ...this.store.getMineruConfig(),
      hasApiKey: this.credentials.has(MINERU_CREDENTIAL_ID),
    };
  }

  async saveConfig(input: MineruConfig): Promise<MineruConfig> {
    const config = {
      baseUrl: normalizeBaseUrl(input.baseUrl),
      modelVersion: input.modelVersion,
      formulaRenderer: input.formulaRenderer,
    };
    await this.store.setMineruConfig(config);
    if (input.apiKey !== undefined) await this.credentials.set(MINERU_CREDENTIAL_ID, input.apiKey);
    return this.getConfig();
  }

  async test(input: MineruConfig): Promise<MineruTestResult> {
    const token = input.apiKey || this.credentials.get(MINERU_CREDENTIAL_ID);
    if (!token) return { ok: false, message: "请先填写 MinerU API Token" };
    const started = Date.now();
    try {
      const response = await fetch(
        `${normalizeBaseUrl(input.baseUrl)}/extract-results/batch/pdf2zh-connection-test`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      const latencyMs = Date.now() - started;
      if (response.status === 401 || response.status === 403) {
        return { ok: false, message: "MinerU API Token 无效或无权限", latencyMs };
      }
      return { ok: true, message: "MinerU API 连接成功", latencyMs };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? redact(error.message, token) : "MinerU 连接失败",
        latencyMs: Date.now() - started,
      };
    }
  }

  async prepareFormulaHints(
    inputPath: string,
    workDirectory: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const config = this.getConfig();
    const token = this.credentials.get(MINERU_CREDENTIAL_ID);
    if (!token || !config.hasApiKey) throw new Error("尚未配置 MinerU API Token");
    const file = await stat(inputPath);
    if (file.size <= 0 || file.size > MAX_INPUT_BYTES) {
      throw new Error("MinerU 仅支持 200 MB 以内的 PDF 文件");
    }

    const dataId = createHash("sha256")
      .update(`${inputPath}:${file.size}:${file.mtimeMs}`)
      .digest("hex")
      .slice(0, 32);
    const baseUrl = normalizeBaseUrl(config.baseUrl);
    const createResponse = await mineruFetch(`${baseUrl}/file-urls/batch`, token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        files: [{ name: basename(inputPath), data_id: dataId }],
        model_version: config.modelVersion,
      }),
      signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
    });
    const createPayload = asRecord(await createResponse.json());
    const createData = asRecord(createPayload?.data);
    const batchId = stringValue(createData?.batch_id ?? createPayload?.batch_id);
    const uploadUrl = extractUploadUrl(createData?.file_urls ?? createPayload?.file_urls);
    if (!batchId || !uploadUrl) throw new Error("MinerU 未返回有效的上传地址");

    const upload = await fetch(uploadUrl, {
      method: "PUT",
      body: await readFile(inputPath),
      signal: withTimeout(signal, 5 * 60 * 1000),
    });
    if (!upload.ok) throw new Error(`MinerU 文件上传失败（HTTP ${upload.status}）`);

    const deadline = Date.now() + PROCESS_TIMEOUT_MS;
    let zipUrl = "";
    while (Date.now() < deadline) {
      const response = await mineruFetch(`${baseUrl}/extract-results/batch/${batchId}`, token, {
        signal: withTimeout(signal, REQUEST_TIMEOUT_MS),
      });
      const payload = asRecord(await response.json());
      const data = asRecord(payload?.data);
      const records = arrayValue(data?.extract_result ?? data?.extract_results ?? payload?.data);
      const record = asRecord(records[0]) ?? data;
      const state = stringValue(record?.state ?? record?.status).toLowerCase();
      if (["failed", "error"].includes(state)) {
        throw new Error(stringValue(record?.err_msg ?? record?.message) || "MinerU 解析失败");
      }
      zipUrl = stringValue(record?.full_zip_url ?? record?.zip_url ?? record?.result_url);
      if (zipUrl || ["done", "completed", "success"].includes(state)) break;
      await delay(POLL_INTERVAL_MS, signal);
    }
    if (!zipUrl) throw new Error("MinerU 解析超时或未返回结果压缩包");

    const archiveResponse = await fetch(zipUrl, {
      signal: withTimeout(signal, 5 * 60 * 1000),
    });
    if (!archiveResponse.ok) {
      throw new Error(`MinerU 结果下载失败（HTTP ${archiveResponse.status}）`);
    }
    const declaredLength = Number(archiveResponse.headers.get("content-length") || 0);
    if (declaredLength > MAX_DOWNLOAD_BYTES) throw new Error("MinerU 结果压缩包超过 500 MB");
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    if (archive.length > MAX_DOWNLOAD_BYTES) throw new Error("MinerU 结果压缩包超过 500 MB");
    const archivePath = join(workDirectory, `mineru-${randomUUID()}.zip`);
    const extractedDirectory = join(workDirectory, "mineru-result");
    await writeFile(archivePath, archive, { mode: 0o600 });
    await extract(archivePath, { dir: extractedDirectory });
    const layoutPath = await findNamedFile(extractedDirectory, "layout.json");
    if (!layoutPath) {
      throw new Error("MinerU 结果中缺少 layout.json，当前无法进行公式坐标增强");
    }
    return layoutPath;
  }

  async prepareFormulaAssets(layoutPath: string, workDirectory: string): Promise<string> {
    const layout = JSON.parse(await readFile(layoutPath, "utf8")) as unknown;
    const formulas = collectMineruFormulas(layout);
    const assetDirectory = join(workDirectory, "formula-assets");
    await mkdir(assetDirectory, { recursive: true });
    const renderer = this.getConfig().formulaRenderer;
    let latexCommand: string | undefined;
    if (renderer === "latex") {
      const latex = await this.getLatexState();
      if (latex.status !== "ready" || !latex.executable) {
        throw new Error("尚未安装 LaTeX 组件，请在设置中安装或改用内置 MathJax");
      }
      latexCommand = latex.executable;
    }

    const rendered: MineruFormulaAsset[] = [];
    for (const formula of formulas) {
      if (renderer !== "mathjax") {
        rendered.push(formula);
        continue;
      }
      try {
        const svg = await renderMathJaxSvg(formula.latex, formula.display);
        const svgPath = join(assetDirectory, `${formula.id}.svg`);
        await writeFile(svgPath, svg.svg, "utf8");
        rendered.push({
          ...formula,
          svgPath,
          width: svg.width,
          height: svg.height,
          depth: svg.depth,
        });
      } catch (error) {
        rendered.push({
          ...formula,
          renderError: error instanceof Error ? error.message.slice(0, 500) : "MathJax 渲染失败",
        });
      }
    }

    if (renderer === "mathjax") {
      const latex = await this.getLatexState();
      if (latex.status === "ready") latexCommand = latex.executable;
    }
    const manifestPath = join(assetDirectory, "manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ version: 1, renderer, latexCommand, formulas: rendered }, null, 2),
      "utf8",
    );
    return manifestPath;
  }

  async getLatexState(): Promise<LatexState> {
    if (this.latexInstalling) {
      return { status: "installing", message: "正在通过 winget 安装 MiKTeX" };
    }
    const executable = await findPdfLatex();
    if (!executable) {
      return {
        status: "missing",
        message: "未检测到 LaTeX；内置 MathJax 可直接使用",
      };
    }
    try {
      const result = await runExecutable(executable, ["--version"], 20_000);
      const firstLine =
        `${result.stdout}\n${result.stderr}`.split(/\r?\n/).find(Boolean) || "pdflatex";
      return {
        status: "ready",
        engine: /miktex/i.test(firstLine) ? "miktex" : "pdflatex",
        executable,
        version: firstLine.trim().slice(0, 200),
        message: `已检测到 ${firstLine.trim().slice(0, 100)}`,
      };
    } catch (error) {
      return {
        status: "error",
        executable,
        message: error instanceof Error ? error.message : "LaTeX 检测失败",
      };
    }
  }

  async installLatex(): Promise<LatexState> {
    const existing = await this.getLatexState();
    if (existing.status === "ready") return existing;
    if (process.platform !== "win32") {
      return { status: "error", message: "自动安装 LaTeX 目前仅支持 Windows" };
    }
    this.latexInstalling = true;
    try {
      await runExecutable(
        "winget",
        [
          "install",
          "--id",
          "MiKTeX.MiKTeX",
          "--exact",
          "--silent",
          "--accept-package-agreements",
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
        LATEX_INSTALL_TIMEOUT_MS,
      );
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? `MiKTeX 安装失败：${error.message}` : "MiKTeX 安装失败",
      };
    } finally {
      this.latexInstalling = false;
    }
    const state = await this.getLatexState();
    return state.status === "ready"
      ? state
      : { status: "error", message: "MiKTeX 已安装，但需要重启应用后才能检测到" };
  }
}

export function collectMineruFormulas(layout: unknown): MineruFormulaAsset[] {
  const root = asRecord(layout);
  const pages = arrayValue(root?.pdf_info);
  const formulas: MineruFormulaAsset[] = [];
  const seen = new Set<string>();
  pages.forEach((pageValue, pageIndex) => {
    if (formulas.length >= MAX_FORMULAS) return;
    const page = asRecord(pageValue);
    const size = numericArray(page?.page_size, 2);
    if (!page || !size) return;
    for (const item of walkObjects(page.para_blocks)) {
      const kind = stringValue(item.type).toLowerCase();
      if (!kind.includes("equation")) continue;
      const bbox = numericArray(item.bbox, 4);
      const latex = cleanLatex(stringValue(item.content ?? item.latex));
      if (!bbox || !latex || UNSAFE_LATEX.test(latex)) continue;
      if (!kind.includes("inline") || !isComplexFormula(latex)) continue;
      const key = `${pageIndex}:${bbox.join(",")}:${latex}`;
      if (seen.has(key)) continue;
      seen.add(key);
      formulas.push({
        id: `p${pageIndex + 1}-f${formulas.length + 1}`,
        page: pageIndex,
        kind,
        bbox: bbox as [number, number, number, number],
        pageSize: size as [number, number],
        latex,
        display: kind.includes("interline") || isComplexFormula(latex),
      });
      if (formulas.length >= MAX_FORMULAS) break;
    }
  });
  return formulas;
}

export function normalizeMathJaxSvg(svg: string): {
  svg: string;
  width: number;
  height: number;
  depth: number;
} {
  const widthMatch = svg.match(/\bwidth="([0-9.]+)(ex|em|pt|px)"/);
  const heightMatch = svg.match(/\bheight="([0-9.]+)(ex|em|pt|px)"/);
  if (!widthMatch || !heightMatch) throw new Error("MathJax SVG 缺少有效尺寸");
  const width = svgLengthToPoints(Number(widthMatch[1]), widthMatch[2]);
  const height = svgLengthToPoints(Number(heightMatch[1]), heightMatch[2]);
  if (width <= 0 || height <= 0) throw new Error("MathJax SVG 尺寸无效");
  const vertical = svg.match(/vertical-align:\s*(-?[0-9.]+)(ex|em|pt|px)/);
  const depth = vertical
    ? Math.max(0, -svgLengthToPoints(Number(vertical[1]), vertical[2]))
    : Math.max(0, height - 10);
  const normalized = svg
    .replace(widthMatch[0], `width="${width.toFixed(3)}pt"`)
    .replace(heightMatch[0], `height="${height.toFixed(3)}pt"`);
  return { svg: normalized, width, height, depth };
}

async function mineruFetch(url: string, token: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...init.headers,
    },
    signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const body = redact((await response.text()).slice(0, 500), token);
    throw new Error(`MinerU API 返回 HTTP ${response.status}${body ? `：${body}` : ""}`);
  }
  return response;
}

function normalizeBaseUrl(value: string): string {
  const parsed = new URL(value.trim());
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("MinerU API 地址仅支持 HTTP 或 HTTPS");
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function extractUploadUrl(value: unknown): string {
  const entries = arrayValue(value);
  const first = entries[0];
  if (typeof first === "string") return first;
  const record = asRecord(first);
  return stringValue(record?.url ?? record?.file_url ?? record?.upload_url);
}

async function findNamedFile(root: string, name: string): Promise<string | undefined> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return path;
    if (entry.isDirectory()) {
      const nested = await findNamedFile(path, name);
      if (nested) return nested;
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function redact(value: string, secret: string): string {
  return secret ? value.replaceAll(secret, "<redacted>") : value;
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason || new Error("MinerU 请求已取消"));
      },
      { once: true },
    );
  });
}

function withTimeout(signal: AbortSignal | undefined, milliseconds: number): AbortSignal {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function renderMathJaxSvg(latex: string, display: boolean) {
  if (!mathJaxPromise) {
    mathJaxPromise = (async () => {
      const module = await import("mathjax");
      const entry = createRequire(import.meta.url).resolve("mathjax");
      const rootUrl = pathToFileURL(dirname(entry)).href;
      const runtime = await module.default.init({
        loader: {
          paths: { mathjax: rootUrl },
          load: ["input/tex", "output/svg"],
        },
        svg: { fontCache: "local" },
      });
      if (!runtime) throw new Error("MathJax 初始化失败");
      return runtime;
    })();
  }
  const mathJax = await mathJaxPromise;
  const node = await mathJax.tex2svgPromise(latex, { display });
  const xml = mathJax.startup.adaptor.serializeXML(node) as string;
  const svg = xml.match(/<svg[\s\S]*<\/svg>/)?.[0];
  if (!svg) throw new Error("MathJax 未返回 SVG");
  return normalizeMathJaxSvg(svg);
}

function cleanLatex(value: string): string {
  let cleaned = value
    .replace(/\\tag\s*\{[^{}]*\}/g, "")
    .replace(/\\label\s*\{[^{}]*\}/g, "")
    .replace(/\\dot\s*\{\s*d\s*t\s*\}/gi, String.raw`\,dt`)
    .replace(/\\operatorname\s*\{\s*(?:[a-z]\s*)+\}\s*\(\s*([a-z])\s*\)\s*=/i, "$1=")
    .replace(/^\s*(?:\$\$|\\\[|\$)/, "")
    .replace(/(?:\$\$|\\\]|\$)\s*$/, "")
    .trim()
    .slice(0, 20_000);
  const singleRowArray = cleaned.match(
    /^\\begin\s*\{array\}\s*\{[^{}]*\}([\s\S]*)\\end\s*\{array\}$/i,
  );
  if (singleRowArray && !singleRowArray[1].includes(String.raw`\\`)) {
    cleaned = unwrapOuterBraces(singleRowArray[1].trim());
  }
  return cleaned;
}

function unwrapOuterBraces(value: string): string {
  if (!value.startsWith("{") || !value.endsWith("}")) return value;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "{") depth += 1;
    if (value[index] === "}") depth -= 1;
    if (depth === 0 && index < value.length - 1) return value;
  }
  return depth === 0 ? value.slice(1, -1).trim() : value;
}

function isComplexFormula(latex: string): boolean {
  return /\\(?:frac|dfrac|tfrac|int|iint|iiint|sum|prod|sqrt|lim|begin|operatorname|overline|underline)\b/.test(
    latex,
  );
}

function* walkObjects(value: unknown): Generator<Record<string, unknown>> {
  const record = asRecord(value);
  if (record) {
    yield record;
    for (const nested of Object.values(record)) yield* walkObjects(nested);
    return;
  }
  if (Array.isArray(value)) {
    for (const nested of value) yield* walkObjects(nested);
  }
}

function numericArray(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  const result = value.map(Number);
  return result.every(Number.isFinite) ? result : undefined;
}

function svgLengthToPoints(value: number, unit: string): number {
  if (!Number.isFinite(value)) throw new Error("MathJax SVG 尺寸无效");
  if (unit === "ex") return value * MATHJAX_EX_TO_PT;
  if (unit === "em") return value * 10;
  if (unit === "px") return value * 0.75;
  return value;
}

async function findPdfLatex(): Promise<string | undefined> {
  const candidates = new Set<string>();
  try {
    const located = await runExecutable("where.exe", ["pdflatex.exe"], 10_000);
    for (const line of located.stdout.split(/\r?\n/)) {
      if (line.trim()) candidates.add(line.trim());
    }
  } catch {
    // Continue with standard installation paths.
  }
  const local = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles;
  const programFilesX86 = process.env["ProgramFiles(x86)"];
  for (const root of [local, programFiles, programFilesX86].filter(Boolean) as string[]) {
    candidates.add(join(root, "Programs", "MiKTeX", "miktex", "bin", "x64", "pdflatex.exe"));
    candidates.add(join(root, "MiKTeX", "miktex", "bin", "x64", "pdflatex.exe"));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  return undefined;
}

function runExecutable(
  executable: string,
  args: string[],
  timeout: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      { windowsHide: true, timeout, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = `${stderr || stdout || error.message}`.trim().slice(-2000);
          reject(new Error(detail || error.message));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
