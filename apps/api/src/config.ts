import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const booleanFromString = z.preprocess((value) => value === "true" || value === true, z.boolean());

const envSchema = z.object({
  AVO_HOST: z.literal("127.0.0.1").default("127.0.0.1"),
  AVO_API_PORT: z.coerce.number().int().min(1).max(65_535).default(4310),
  AVO_DATA_DIR: z.string().default("./data"),
  AVO_PROVIDER_MODE: z.enum(["fake", "live"]).default("fake"),
  AVO_CODEX_BIN: z.string().default("codex"),
  AVO_CODEX_MODEL: z.string().default("qwen3.8-flash"),
  AVO_CODEX_MODEL_CATALOG: z.string().optional(),
  AVO_CODEX_PROVIDER_BASE_URL: z.string().url().optional(),
  AVO_CODEX_PROVIDER_API_KEY: z.string().optional(),
  AVO_CODEX_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).default("high"),
  AVO_CODEX_TURN_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(5_400_000).default(600_000),
  AVO_IMAGE_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  AVO_IMAGE_MODEL: z.string().default("gpt-image-2"),
  AVO_IMAGE_PROVIDER_REVISION: z.string().optional(),
  AVO_IMAGE_TASK_TIMEOUT_MS: z.coerce.number().int().min(30_000).max(5_400_000).default(1_200_000),
  OPENAI_API_KEY: z.string().optional(),
  QWEN_BASE_URL: z.string().url().optional(),
  QWEN_API_KEY: z.string().optional(),
  QWEN_MODEL: z.string().default("qwen3.8-flash"),
  QWEN_PROVIDER_REVISION: z.string().optional(),
  AVO_RUN_LIVE_PROBES: booleanFromString.default(false),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export const loadConfig = (input: NodeJS.ProcessEnv = process.env) => {
  const parsed = envSchema.parse(input);
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  return {
    ...parsed,
    AVO_CODEX_PROVIDER_BASE_URL: parsed.AVO_CODEX_PROVIDER_BASE_URL ?? parsed.QWEN_BASE_URL,
    AVO_CODEX_PROVIDER_API_KEY: parsed.AVO_CODEX_PROVIDER_API_KEY ?? parsed.QWEN_API_KEY,
    AVO_DATA_DIR: isAbsolute(parsed.AVO_DATA_DIR) ? parsed.AVO_DATA_DIR : resolve(root, parsed.AVO_DATA_DIR),
    AVO_ROOT: root,
  };
};
