import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const booleanFromString = z.preprocess((value) => value === "true" || value === true, z.boolean());
const optionalPositiveInteger = z.preprocess(
  (value) => value === "" || value === undefined ? undefined : value,
  z.coerce.number().int().min(10_000).optional(),
);

const envSchema = z.object({
  AVO_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  AVO_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  AVO_DATA_DIR: z.string().default("./data"),
  AVO_PROVIDER_MODE: z.enum(["fake", "live"]).default("fake"),
  AVO_MAIN_PROVIDER: z.enum(["qwen", "78code"]).default("qwen"),
  AVO_VERIFIER_PROVIDER: z.enum(["qwen", "78code"]).default("qwen"),
  AVO_SUPERVISOR_PROVIDER: z.enum(["qwen", "78code"]).default("qwen"),
  AVO_78CODE_BASE_URL: z.string().url().default("https://www.78code.cc/v1"),
  AVO_78CODE_API_KEY: z.string().optional(),
  AVO_78CODE_PROXY_URL: z.string().url().optional(),
  AVO_78CODE_MODEL: z.string().default("gpt-6-astra"),
  AVO_VERIFIER_MODEL: z.string().optional(),
  AVO_SUPERVISOR_MODEL: z.string().optional(),
  AVO_VERIFIER_EFFORT: z.enum(["none", "low", "medium", "high", "xhigh"]).default("low"),
  AVO_VERIFIER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(360_000).default(360_000),
  AVO_SUPERVISOR_EFFORT: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
  AVO_CODEX_BIN: z.string().default("codex"),
  AVO_CODEX_MODEL: z.string().default("qwen3.8-flash"),
  AVO_CODEX_MODEL_CATALOG: z.string().optional(),
  AVO_CODEX_PROVIDER_BASE_URL: z.string().url().optional(),
  AVO_CODEX_PROVIDER_API_KEY: z.string().optional(),
  AVO_CODEX_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).default("high"),
  AVO_CODEX_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(131_072).default(8_192),
  AVO_CODEX_TURN_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(5_400_000).default(600_000),
  AVO_AGENT_TOKEN_WARNING: z.coerce.number().int().min(10_000).default(600_000),
  AVO_AGENT_TOKEN_LIMIT: optionalPositiveInteger,
  AVO_AGENT_STEP_TOKEN_LIMIT: optionalPositiveInteger,
  AVO_AGENT_STEP_SOFT_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(5_400_000).default(900_000),
  AVO_AGENT_STEP_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(5_400_000).default(1_200_000),
  AVO_AGENT_CONTEXT_WINDOW: z.coerce.number().int().min(10_000).default(1_000_000),
  AVO_AGENT_PREVIEW_MAX_EDGE: z.coerce.number().int().min(256).max(2_048).default(1_024),
  AVO_AGENT_TOOL_OUTPUT_MAX_CHARS: z.coerce.number().int().min(1_000).max(100_000).default(12_000),
  AVO_SVG_MCP_COMMAND: z.string().optional(),
  AVO_CODEX_INTERRUPT_GRACE_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  AVO_IMAGE_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AVO_IMAGE_MODEL: z.string().default("gpt-image-2"),
  AVO_IMAGE_PROVIDER_REVISION: z.string().optional(),
  AVO_IMAGE_TASK_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(5_400_000).default(1_200_000),
  AVO_IMAGE_ATTEMPT_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(120_000),
  AVO_IMAGE_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(5),
  AVO_BENCHMARK_CONCURRENCY: z.coerce.number().int().min(1).max(10).default(3),
  OPENAI_API_KEY: z.string().optional(),
  QWEN_BASE_URL: z.string().url().optional(),
  QWEN_API_KEY: z.string().optional(),
  QWEN_BILLING_MODE: z.enum(["pay_as_you_go", "token_plan"]).default("pay_as_you_go"),
  QWEN_TOKEN_PLAN_API_KEY: z.string().optional(),
  QWEN_MODEL: z.string().default("qwen3.8-flash"),
  QWEN_PROVIDER_REVISION: z.string().optional(),
  AVO_RUN_LIVE_PROBES: booleanFromString.default(false),
  AVO_PROVIDER_PROBE_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(300_000).default(180_000),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export const loadConfig = (input: NodeJS.ProcessEnv = process.env) => {
  const parsed = envSchema.parse(input);
  if (parsed.AVO_AGENT_STEP_SOFT_TIMEOUT_MS >= parsed.AVO_AGENT_STEP_TIMEOUT_MS) {
    throw new Error("AVO_AGENT_STEP_SOFT_TIMEOUT_MS must be lower than AVO_AGENT_STEP_TIMEOUT_MS");
  }
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  const tokenPlan = parsed.QWEN_BILLING_MODE === "token_plan";
  const planKey = parsed.QWEN_TOKEN_PLAN_API_KEY?.trim()
    || (parsed.QWEN_API_KEY?.startsWith("sk-sp-") ? parsed.QWEN_API_KEY : undefined);
  if (tokenPlan && planKey && !planKey.startsWith("sk-sp-")) throw new Error("token_plan_requires_dedicated_api_key");
  const qwenBase = tokenPlan ? "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" : parsed.QWEN_BASE_URL;
  const qwenKey = tokenPlan ? planKey : parsed.QWEN_API_KEY;
  return {
    ...parsed,
    QWEN_BASE_URL: qwenBase,
    QWEN_API_KEY: qwenKey,
    QWEN_PROVIDER_REVISION: tokenPlan ? `token-plan:${parsed.QWEN_MODEL}` : parsed.QWEN_PROVIDER_REVISION,
    AVO_CODEX_PROVIDER_BASE_URL: tokenPlan ? qwenBase : parsed.AVO_CODEX_PROVIDER_BASE_URL ?? parsed.QWEN_BASE_URL,
    AVO_CODEX_PROVIDER_API_KEY: tokenPlan ? qwenKey : parsed.AVO_CODEX_PROVIDER_API_KEY ?? parsed.QWEN_API_KEY,
    AVO_DATA_DIR: isAbsolute(parsed.AVO_DATA_DIR) ? parsed.AVO_DATA_DIR : resolve(root, parsed.AVO_DATA_DIR),
    AVO_ROOT: root,
  };
};

export const roleConfig = (config: AppConfig, role: "main" | "verifier" | "supervisor"): AppConfig => {
  const provider = role === "main" ? config.AVO_MAIN_PROVIDER : role === "verifier" ? config.AVO_VERIFIER_PROVIDER : config.AVO_SUPERVISOR_PROVIDER;
  const model = (role === "verifier" ? config.AVO_VERIFIER_MODEL : role === "supervisor" ? config.AVO_SUPERVISOR_MODEL : undefined)
    ?? (provider === "78code" ? config.AVO_78CODE_MODEL : role === "verifier" ? config.QWEN_MODEL : config.AVO_CODEX_MODEL);
  const base = provider === "78code" ? config.AVO_78CODE_BASE_URL : config.QWEN_BASE_URL;
  const key = provider === "78code" ? config.AVO_78CODE_API_KEY : config.QWEN_API_KEY;
  return {
    ...config,
    AVO_MAIN_PROVIDER: provider,
    AVO_CODEX_MODEL: model,
    AVO_CODEX_MODEL_CATALOG: provider === "78code" ? undefined : config.AVO_CODEX_MODEL_CATALOG,
    AVO_CODEX_PROVIDER_BASE_URL: provider === "78code" || role !== "main" ? base : config.AVO_CODEX_PROVIDER_BASE_URL,
    AVO_CODEX_PROVIDER_API_KEY: provider === "78code" || role !== "main" ? key : config.AVO_CODEX_PROVIDER_API_KEY,
    AVO_CODEX_EFFORT: role === "supervisor" ? config.AVO_SUPERVISOR_EFFORT : config.AVO_CODEX_EFFORT,
    QWEN_BASE_URL: base,
    QWEN_API_KEY: key,
    QWEN_MODEL: model,
    QWEN_PROVIDER_REVISION: provider === "78code" ? `78code:${model}` : config.QWEN_PROVIDER_REVISION,
  };
};

export const toolWaitTimeoutMs = (config: AppConfig) => Math.max(
  config.AVO_IMAGE_MAX_ATTEMPTS * (config.AVO_IMAGE_ATTEMPT_TIMEOUT_MS + 250) + 120_000,
  config.AVO_AGENT_STEP_TIMEOUT_MS + 120_000,
);
