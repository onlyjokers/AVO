import { defineConfig } from "@playwright/test";

const apiPort = process.env.AVO_E2E_API_PORT ?? "4310";
const webPort = process.env.AVO_E2E_WEB_PORT ?? "4311";
const dataDir = process.env.AVO_E2E_DATA_DIR ?? "./tmp/e2e-data";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    channel: "chrome",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: `AVO_API_PORT=${apiPort} AVO_DATA_DIR=${JSON.stringify(dataDir)} AVO_PROVIDER_MODE=fake AVO_78CODE_API_KEY=e2e-placeholder pnpm --filter @avo/api dev`,
      url: `http://127.0.0.1:${apiPort}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `AVO_WEB_API_PORT=${apiPort} pnpm --filter @avo/web exec vite --host 127.0.0.1 --port ${webPort}`,
      url: `http://127.0.0.1:${webPort}`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
