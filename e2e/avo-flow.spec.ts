import { expect, test } from "@playwright/test";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAfUlEQVR4nO2SAQkAURSDltM4l8mAF2M8/sAAOhY+T5O6AQuwviK7kHdJ3YAFWF+RXci7pG7AAqyvyC7kXVI3YAHWV2QX8i6pG7AA6yuyC3mX1A1YgPUV2YW8S+oGLMD6iuxC3iV1AxZgfUV2Ie+SugELsL4iu5B3Sd2AxwN+ze/BD3ZBLncAAAAASUVORK5CYII=", "base64");

for (const verifier of ["qwen", "78code"] as const) {
test(`creates a task and completes the fake AVO loop with ${verifier} verifier`, async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const title = `Playwright AVO ${Date.now()}`;
  await page.goto("/tasks/new");
  await page.getByLabel("任务名称").fill(title);
  await page.getByLabel("用户 Brief").fill("把背景改为纯蓝色，同时保持人物、脸部和原始构图不变。 ");
  await page.getByLabel("原图").setInputFiles({ name: "source.png", mimeType: "image/png", buffer: pixel });
  await page.getByRole("button", { name: "创建任务" }).click();

  await expect(page.getByRole("heading", { name: title })).toBeVisible();
  await page.getByLabel("main model").selectOption("78code");
  await page.getByLabel("verifier model").selectOption(verifier);
  await page.getByLabel("supervisor model").selectOption("78code");
  await page.reload();
  await expect(page.getByLabel("main model")).toHaveValue("78code");
  await expect(page.getByLabel("verifier model")).toHaveValue(verifier);
  await expect(page.getByLabel("supervisor model")).toHaveValue("78code");
  await page.screenshot({ path: testInfo.outputPath("models-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel("main model")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("models-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.route("**/api/runs", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const payload = route.request().postDataJSON() as { task_id: string; config: Record<string, unknown> };
    await route.continue({ postData: JSON.stringify({ ...payload, config: { ...payload.config, max_generations: 4 } }) });
  });
  await page.getByRole("button", { name: /AVO 自主闭环/ }).click();
  await expect(page.getByText("AVO", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/已使用完整生成预算/)).toBeVisible({ timeout: 55_000 });
  await expect(page.getByText("4/4", { exact: true }).first()).toBeVisible();
  const snapshot = await page.request.get(`/api/runs/${page.url().split("/").at(-1)}`).then((response) => response.json());
  expect(snapshot.run.config.role_profiles).toEqual({ main: "78code", verifier, supervisor: "78code" });
  expect(snapshot.run.config.main_model).toBe("gpt-6-astra");
  expect(snapshot.run.config.verifier_model).toBe(verifier === "78code" ? "gpt-6-astra" : "qwen3.8-flash");
  expect(snapshot.run.config.supervisor_model).toBe("gpt-6-astra");
  await expect(page.getByText("Official Lineage", { exact: true })).toBeVisible();
  await expect(page.getByText(/x0 → x4 · 4 Attempts · 4 Drafts/)).toBeVisible();

  await page.getByRole("button", { name: /Attempt 1 Draft/ }).click();
  await expect(page.getByText("Parent 与 References", { exact: true })).toBeVisible();
  await expect(page.getByText("Candidate vs Incumbent", { exact: true })).toBeVisible();
  await expect(page.getByText(/Evaluation Frame r1/)).toBeVisible();
  await expect(page.getByText("Memory Diff", { exact: true })).toBeVisible();
  await expect(page.getByText(/Variation 1 was viewed and evaluated/)).toBeVisible();

  await page.getByRole("button", { name: /运行日志/ }).click();
  await expect(page.getByText("运行日志", { exact: true }).last()).toBeVisible();
  await expect(page.getByText("Variation Attempt 完成").first()).toBeVisible();
});
}
