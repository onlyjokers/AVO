import { expect, test } from "@playwright/test";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3gQ3WQAAAABJRU5ErkJggg==", "base64");

test("creates a task and completes the fake AVO loop", async ({ page }) => {
  const title = `Playwright AVO ${Date.now()}`;
  await page.goto("/tasks/new");
  await page.getByLabel("任务名称").fill(title);
  await page.getByLabel("甲方编辑要求").fill("把背景改为纯蓝色，同时保持人物、脸部和原始构图不变。 ");
  await page.getByLabel("原图").setInputFiles({ name: "source.png", mimeType: "image/png", buffer: pixel });
  await page.getByRole("button", { name: "创建任务" }).click();

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByRole("button", { name: /AVO 多轮闭环/ }).click();
  await expect(page.getByText("AVO", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("verifier_passed")).toBeVisible();
  await expect(page.getByText("3 / 24")).toBeVisible();
  await expect(page.getByText("PASS", { exact: true }).first()).toBeVisible();
});
