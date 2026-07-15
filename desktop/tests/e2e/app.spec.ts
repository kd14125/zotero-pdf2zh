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
    await page.getByRole("button", { name: "运行时" }).click();
    await expect(page.getByRole("heading", { name: "PDF2ZH 运行时" })).toBeVisible();

    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: "test-results/desktop-1280x720.png", fullPage: true });
  } finally {
    await application.close();
  }
});
