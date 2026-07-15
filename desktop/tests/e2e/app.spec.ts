import { _electron as electron, expect, test } from "@playwright/test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("desktop shell renders all primary work views", async () => {
  const userData = await mkdtemp(join(tmpdir(), "pdf2zh-e2e-"));
  const application = await electron.launch({
    args: [resolve("."), `--user-data-dir=${userData}`, "--force-device-scale-factor=1.25"],
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
    await expect(page.getByRole("button", { name: "仅安装版支持" })).toBeDisabled();

    const profileItems = page.locator(".profile-list > button");
    await expect(profileItems).toHaveCount(1);
    await page.getByRole("button", { name: "新增配置" }).click();
    await page.getByLabel("服务类型").selectOption("deepseek");
    await page.getByLabel("配置名称").fill("DeepSeek A");
    await expect(page.getByRole("button", { name: "获取模型" })).toBeVisible();
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
    await page.getByRole("button", { name: "翻译", exact: true }).click();
    await expect(page.getByLabel("翻译服务").locator("option:checked")).toHaveText("DeepSeek A");

    await page.getByRole("button", { name: "运行时" }).click();
    await expect(page.getByRole("heading", { name: "PDF2ZH 运行时" })).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: "test-results/desktop-1280x720.png", fullPage: true });
  } finally {
    await application.close();
  }
});
