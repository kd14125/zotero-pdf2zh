import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 45_000,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: { trace: "retain-on-failure" },
});
