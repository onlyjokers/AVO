import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: "http://127.0.0.1:4311",
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "AVO_DATA_DIR=./tmp/e2e-data AVO_PROVIDER_MODE=fake pnpm --filter @avo/api dev",
      url: "http://127.0.0.1:4310/health",
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: "pnpm --filter @avo/web dev",
      url: "http://127.0.0.1:4311",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
