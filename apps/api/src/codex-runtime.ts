import { execFile } from "node:child_process";
import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AppConfig } from "./config.ts";

const executeFile = promisify(execFile);

export const prepareCodexRuntime = async (input: AppConfig) => {
  if (input.AVO_PROVIDER_MODE !== "live") return { config: input, codexRevision: "fake" };

  const version = await executeFile(input.AVO_CODEX_BIN, ["--version"]);
  const codexRevision = version.stdout.trim() || "codex-unknown";
  const protocolDirectory = join(input.AVO_DATA_DIR, "protocol", codexRevision.replaceAll(/[^a-zA-Z0-9._-]/g, "-"));
  await mkdir(protocolDirectory, { recursive: true });
  await executeFile(input.AVO_CODEX_BIN, ["app-server", "generate-json-schema", "--out", protocolDirectory]);

  if (input.AVO_CODEX_MODEL_CATALOG) return { config: input, codexRevision };

  const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const cache = JSON.parse(await readFile(join(codexHome, "models_cache.json"), "utf8")) as {
    models?: Array<Record<string, unknown>>;
  };
  const cachedModel = cache.models?.find((item) => item.slug === input.AVO_CODEX_MODEL);
  const template = cachedModel ?? cache.models?.[0];
  if (!template) throw new Error("codex_model_catalog_empty");
  const model = {
    ...template,
    slug: input.AVO_CODEX_MODEL,
    display_name: input.AVO_CODEX_MODEL,
    description: `${input.AVO_CODEX_MODEL} via AVO custom Responses provider`,
    input_modalities: ["text", "image"],
    supports_parallel_tool_calls: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none",
    supports_image_detail_original: false,
    supports_search_tool: false,
    use_responses_lite: false,
    tool_mode: "default",
  };
  const catalogPath = join(protocolDirectory, "avo-model-catalog.json");
  const temporary = `${catalogPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({
    models: [{
      ...model,
    }],
  }, null, 2)}\n`);
  await rename(temporary, catalogPath);
  return {
    config: { ...input, AVO_CODEX_MODEL_CATALOG: catalogPath },
    codexRevision,
  };
};
