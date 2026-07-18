import { _electron as electron, expect, test } from "@playwright/test";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("desktop shell renders all primary work views", async () => {
  const availableModels = Array.from(
    { length: 91 },
    (_, index) => `test/model-${String(index + 1).padStart(3, "0")}`,
  );
  const modelServer = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: availableModels.map((id) => ({ id })) }));
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolveListen) => modelServer.listen(0, "127.0.0.1", resolveListen));
  const modelServerAddress = modelServer.address() as AddressInfo;
  const userData = await mkdtemp(join(tmpdir(), "pdf2zh-e2e-"));
  const application = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`, "--force-device-scale-factor=1.25"],
    env: {
      ...process.env,
      PDF2ZH_ENGINE_IDLE_TIMEOUT_MS: "1000",
      PDF2ZH_E2E_HIDE_WINDOW: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    application.process().stdout?.on("data", (data) => console.log(`[electron] ${data}`));
    application.process().stderr?.on("data", (data) => console.error(`[electron] ${data}`));
    page.on("console", (message) => console.log(`[renderer:${message.type()}] ${message.text()}`));
    page.on("pageerror", (error) => console.error(`[renderer:error] ${error.message}`));
    await page.waitForLoadState("domcontentloaded");
    await page.screenshot({ path: "test-results/desktop-startup.png", fullPage: true });
    await expect(page.getByRole("heading", { name: "PDF 翻译" })).toBeVisible();
    await expect(page.getByRole("combobox").first()).toHaveValue(/.+/);
    await page.screenshot({ path: "test-results/desktop-1440x900.png", fullPage: true });

    await page.getByRole("button", { name: "任务" }).click();
    await expect(page.getByRole("heading", { name: "任务队列" })).toBeVisible();
    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    await expect(page.getByText("API Key 已使用 Windows DPAPI 加密保存在本机。")).toBeVisible();
    await expect(page.getByText("Codex MCP", { exact: true })).toBeVisible();
    await expect(page.getByText("MinerU 公式漏检增强", { exact: true })).toBeVisible();
    await expect(page.getByLabel("API 地址", { exact: true })).toHaveValue(
      "https://mineru.net/api/v4",
    );
    await expect(page.getByRole("button", { name: "保存 MinerU" })).toBeVisible();
    await expect(page.getByLabel("服务类型").locator('option[value="anthropic"]')).toHaveText(
      "Anthropic Messages",
    );
    await expect(page.getByText("测试连接会发送最小请求，可能产生少量费用")).toBeVisible();
    await expect(page.getByRole("button", { name: "仅安装版支持" })).toBeDisabled();

    const profileItems = page.locator(".profile-list > button");
    await expect(profileItems).toHaveCount(1);
    await page.getByRole("button", { name: "新增配置" }).click();
    await page.getByLabel("服务类型").selectOption("anthropic");
    await expect(page.getByLabel("API Base URL")).toHaveValue("https://api.anthropic.com");
    await page.getByLabel("服务类型").selectOption("deepseek");
    await page.getByLabel("配置名称").fill("DeepSeek A");
    await page.getByLabel("API Base URL").fill(`http://127.0.0.1:${modelServerAddress.port}/v1`);
    await page.getByLabel("API Key").fill("test-key");
    await expect(page.getByRole("button", { name: "获取模型" })).toBeVisible();
    await page.getByRole("button", { name: "获取模型" }).click();
    const modelSelect = page.getByLabel("可用模型列表", { exact: true });
    await expect(modelSelect).toBeVisible();
    await expect(modelSelect.locator("option")).toHaveCount(92);
    await page.screenshot({ path: "test-results/settings-model-list.png", fullPage: true });
    await modelSelect.selectOption("test/model-091");
    await expect(page.getByLabel("模型", { exact: true })).toHaveValue("test/model-091");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(profileItems).toHaveCount(2);

    await page.getByRole("button", { name: "新增配置" }).click();
    await page.getByLabel("服务类型").selectOption("openai");
    await page.getByLabel("配置名称").fill("OpenAI B");
    await page.getByRole("button", { name: "保存配置" }).click();
    await expect(profileItems).toHaveCount(3);
    await expect(profileItems.filter({ hasText: "DeepSeek A" })).toHaveCount(1);
    await expect(profileItems.filter({ hasText: "OpenAI B" })).toHaveCount(1);

    await profileItems.filter({ hasText: "DeepSeek A" }).click();
    await page.screenshot({ path: "test-results/settings-multi-profile.png", fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: "test-results/settings-mineru-1280x720.png", fullPage: true });
    await page.getByRole("button", { name: "翻译", exact: true }).click();
    await expect(page.getByLabel("翻译服务").locator("option:checked")).toHaveText("DeepSeek A");
    await expect(page.getByText("MinerU 公式漏检增强", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "了解 MinerU 公式漏检增强" }).click();
    const mineruHelp = page.getByRole("dialog", { name: "MinerU 公式漏检增强" });
    await expect(mineruHelp).toBeVisible();
    await expect(mineruHelp.getByText("MinerU 不会重新绘制公式")).toBeVisible();
    await expect(mineruHelp.getByRole("link", { name: "获取 MinerU Token" })).toHaveAttribute(
      "href",
      "https://mineru.net/apiManage/token",
    );
    await page.screenshot({ path: "test-results/mineru-help-1280x720.png", fullPage: true });
    await mineruHelp.getByRole("button", { name: "关闭帮助" }).click();
    await expect(mineruHelp).toBeHidden();

    await page.getByRole("button", { name: "运行时" }).click();
    await expect(page.getByRole("heading", { name: "PDF2ZH 运行时" })).toBeVisible();

    await page.screenshot({ path: "test-results/desktop-1280x720.png", fullPage: true });
  } finally {
    await application.close();
    await new Promise<void>((resolveClose, rejectClose) =>
      modelServer.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
  }
});

test("desktop update reuses a complete runtime from the legacy user-data directory", async () => {
  const testRoot = await mkdtemp(join(tmpdir(), "pdf2zh-runtime-upgrade-"));
  const userData = join(testRoot, "user-data");
  const localAppData = join(testRoot, "local-app-data");
  const preferredRuntime = join(localAppData, "PDF2ZH Desktop", "runtime");
  const legacyRuntime = join(userData, "runtime");
  const legacyVersion = join(legacyRuntime, "2.9.0");
  const legacyBinary = join(legacyVersion, "pdf2zh", "pdf2zh.exe");
  await mkdir(join(legacyVersion, "pdf2zh"), { recursive: true });
  await mkdir(preferredRuntime, { recursive: true });
  await writeFile(join(preferredRuntime, "current.json"), JSON.stringify({ version: "2.9.0" }));
  await writeFile(legacyBinary, "reusable runtime");
  await writeFile(
    join(legacyVersion, "installed.json"),
    JSON.stringify({ binary: "pdf2zh/pdf2zh.exe" }),
  );
  await writeFile(join(legacyRuntime, "current.json"), JSON.stringify({ version: "2.9.0" }));

  const packagedExecutable = process.env.PDF2ZH_E2E_EXECUTABLE;
  const application = await electron.launch({
    ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
    args: packagedExecutable
      ? [`--user-data-dir=${userData}`]
      : [resolve("."), `--user-data-dir=${userData}`],
    env: {
      ...process.env,
      LOCALAPPDATA: localAppData,
      PDF2ZH_ENGINE_IDLE_TIMEOUT_MS: "1000",
      PDF2ZH_E2E_HIDE_WINDOW: "1",
    },
  });
  try {
    const page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    const runtime = await page.evaluate(() => window.pdf2zh.runtime.getState());
    expect(runtime.status).toBe("ready");
    expect(runtime.installedVersion).toBe("2.9.0");
    expect(runtime.progress).toBe(100);
    expect(runtime.binaryPath).toBe(join(preferredRuntime, "2.9.0", "pdf2zh", "pdf2zh.exe"));
    await expect(
      readFile(join(preferredRuntime, "current.json"), "utf8").then(JSON.parse),
    ).resolves.toEqual({ version: "2.9.0" });
    await expect(access(runtime.binaryPath!)).resolves.toBeUndefined();
    await expect(access(legacyBinary)).rejects.toThrow();
  } finally {
    await application.close();
  }
});
