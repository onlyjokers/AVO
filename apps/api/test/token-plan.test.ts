import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, roleConfig } from "../src/config.ts";
import { createCodexProxyConfig } from "../src/codex-proxy.ts";

const planBase = "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const staleSettings = {
  QWEN_BILLING_MODE: "token_plan", QWEN_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  QWEN_API_KEY: "sk-ws-test-only", AVO_CODEX_PROVIDER_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  AVO_CODEX_PROVIDER_API_KEY: "sk-ws-other-test-only",
};

test("Token Plan overrides both stale pay-as-you-go routes for all Qwen roles", () => {
  const config = loadConfig({ ...staleSettings, QWEN_TOKEN_PLAN_API_KEY: "sk-sp-test-only" });
  for (const role of ["main", "verifier", "supervisor"] as const) {
    const resolved = roleConfig(config, role);
    assert.equal(resolved.QWEN_BASE_URL, planBase);
    assert.equal(resolved.AVO_CODEX_PROVIDER_BASE_URL, planBase);
    assert.equal(resolved.QWEN_API_KEY, "sk-sp-test-only");
    assert.equal(resolved.AVO_CODEX_PROVIDER_API_KEY, "sk-sp-test-only");
  }
  const proxy = createCodexProxyConfig(config, "local-test");
  assert.equal(proxy?.upstreamBaseUrl, planBase);
  assert.equal(proxy?.upstreamApiKey, "sk-sp-test-only");
});

test("missing Token Plan key cannot fall back to a general API key", () => {
  const config = loadConfig(staleSettings);
  assert.equal(config.QWEN_API_KEY, undefined);
  assert.equal(config.AVO_CODEX_PROVIDER_API_KEY, undefined);
  assert.equal(createCodexProxyConfig(config, "local-test"), undefined);
});

test("general keys are rejected in the dedicated field without revealing credentials", () => {
  assert.throws(() => loadConfig({ ...staleSettings, QWEN_TOKEN_PLAN_API_KEY: "sk-ws-do-not-log" }),
    { message: "token_plan_requires_dedicated_api_key" });
});

test("an existing dedicated QWEN_API_KEY is accepted but explicit plan key takes priority", () => {
  assert.equal(loadConfig({ ...staleSettings, QWEN_API_KEY: "sk-sp-existing-test" }).QWEN_API_KEY, "sk-sp-existing-test");
  assert.equal(loadConfig({ ...staleSettings, QWEN_API_KEY: "sk-sp-existing-test", QWEN_TOKEN_PLAN_API_KEY: "sk-sp-new-test" }).QWEN_API_KEY, "sk-sp-new-test");
});
