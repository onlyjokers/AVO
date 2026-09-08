import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  ArtifactStore,
  AvoRunner,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
  SealedEvaluationStore,
  createId,
} from "@avo/core";
import { taskManifestSchema, experimentalFeaturesSchema } from "@avo/contracts";
import { createApp } from "../src/app.ts";
import { BenchmarkRunner } from "../src/benchmark.ts";
import { CodexAppServerAgentProvider } from "../src/codex-provider.ts";
import { prepareCodexRuntime } from "../src/codex-runtime.ts";
import { loadConfig, roleConfig } from "../src/config.ts";
import { AgentToolBroker } from "../src/tool-broker.ts";
import { createCodexProxyConfig } from "../src/codex-proxy.ts";
import sharp from "sharp";
import { SvgEditor } from "../src/svg-editor.ts";

loadEnv({ path: fileURLToPath(new URL("../../../.env.local", import.meta.url)), quiet: true });
loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const pixel = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 130, b: 180 } } }).png().toBuffer();
const dataDir = resolve(process.env.AVO_CODEX_SMOKE_DATA_DIR ?? `../../tmp/codex-mcp-smoke-${Date.now()}`);
const port = Number(process.env.AVO_CODEX_SMOKE_PORT ?? 4397);
const runtime = await prepareCodexRuntime(roleConfig(loadConfig({ ...process.env, AVO_DATA_DIR: dataDir, AVO_PROVIDER_MODE: "live", AVO_API_PORT: String(port), AVO_CODEX_TURN_TIMEOUT_MS: "300000" }), "main"));
const config = runtime.config;
const features = process.env.AVO_CODEX_SMOKE_FEATURES ? experimentalFeaturesSchema.parse(JSON.parse(process.env.AVO_CODEX_SMOKE_FEATURES)) : undefined;
const store = new FileStateStore(dataDir);
const artifacts = new ArtifactStore(dataDir);
const sealed = new SealedEvaluationStore(dataDir);
const broker = new AgentToolBroker({ previewMaxEdge: config.AVO_AGENT_PREVIEW_MAX_EDGE,
  ...(features?.svg_editing ? { svg: new SvgEditor({ dataDir, command: resolve(config.AVO_ROOT, "tmp/svg-mcp-venv/bin/svg-mcp") }) } : {}),
});
const codexProxyToken = randomBytes(32).toString("hex");
const codexProxy = createCodexProxyConfig(config, codexProxyToken);
const agent = new CodexAppServerAgentProvider(config, broker, store, codexProxyToken);
const images = new FakeImageProvider();
const verifier = new FakeVerifierProvider(1);
const runner = new AvoRunner(store, artifacts, agent, images, verifier, sealed);
const benchmarks = new BenchmarkRunner(store, runner);
const app = await createApp({
  config,
  store,
  artifacts,
  sealed,
  runner,
  benchmarks,
  broker,
  providerHealth: async () => ({
    mode: "smoke",
    codex: { enabled: true, ok: true, message: "smoke" },
    generator: { enabled: false, ok: true, message: "fake" },
    verifier: { enabled: false, ok: true, message: "fake" },
    runnable: true,
  }),
  ...(codexProxy ? { codexProxy } : {}),
});

try {
  await app.listen({ host: "127.0.0.1", port });
  const source = await artifacts.put({ bytes: pixel, mimeType: "image/png", originalName: "source.png" });
  const task = taskManifestSchema.parse({
    schema_version: 2,
    id: createId("task"),
    title: "Codex MCP smoke",
    user_brief: features?.photo_adjustments
      ? "Use the deterministic photo adjustment tools to raise exposure by 0.25 EV, without regenerating or changing geometry. Preview, finalize the exact same recipe from Source, inspect and evaluate it, and submit if the Verifier recommends commit. This is a tool connectivity smoke test, not an image-quality experiment."
      : features?.svg_editing
      ? "Use the deterministic SVG tools to add a small white square at x=8 y=8 width=10 height=10 on this image. Finalize the SVG as a candidate, inspect and evaluate it, and submit if the Verifier recommends commit. This is a tool connectivity smoke test, not an image-quality experiment."
      : "Keep this source image unchanged. Use the AVO tools to produce and submit one candidate.",
    source_artifact_id: source.id,
    references: [],
    preservation_contract: {},
    has_hidden_evaluation: false,
    created_at: new Date().toISOString(),
  });
  await store.saveTask(task);
  const run = await runner.createRun(task.id, { mode: "avo", main_model: config.AVO_CODEX_MODEL, max_generations: 1, ...(features ? { experimental_features: features, max_variation_steps: 1, max_wall_time_ms: 600_000 } : {}) });
  const completed = await runner.start(run.id);
  const validSvgDecision = completed.drafts.some((draft) => draft.creation_method === "svg_edit" && draft.viewed_at
    && completed.evaluations.some((evaluation) => evaluation.draft_id === draft.id))
    && completed.variation_attempts.some((attempt) => attempt.status === "submitted" || attempt.status === "abandoned");
  const validPhotoDecision = completed.drafts.some((draft) => draft.creation_method === "photo_adjustment" && draft.viewed_at
    && completed.evaluations.some((evaluation) => evaluation.draft_id === draft.id))
    && completed.variation_attempts.some((attempt) => attempt.status === "submitted" || attempt.status === "abandoned");
  if (completed.status !== "budget_exhausted" || (features?.photo_adjustments ? !validPhotoDecision : features?.svg_editing ? !validSvgDecision : completed.lineage_attempt_ids.length < 1)) {
    throw new Error(`codex_mcp_smoke_failed:${completed.status}:${completed.terminal_reason ?? "unknown"}`);
  }
  if (features?.svg_editing && !completed.drafts.some((draft) => draft.creation_method === "svg_edit")) throw new Error("codex_svg_smoke_did_not_use_svg");
  if (features?.photo_adjustments && !completed.drafts.some((draft) => draft.creation_method === "photo_adjustment")) throw new Error("codex_photo_smoke_did_not_use_photo");
  process.stdout.write(`${JSON.stringify({ ok: true, model: config.AVO_CODEX_MODEL, status: completed.status, generations: completed.generation_count, attempts: completed.attempts.length, features, data_dir: dataDir })}\n`);
} finally {
  await app.close();
  if (process.env.AVO_CODEX_SMOKE_KEEP_DATA !== "1") {
    await rm(dataDir, { recursive: true, force: true });
  }
}
