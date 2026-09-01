import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ArtifactStore,
  AvoRunner,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
  createId,
} from "@avo/core";
import { taskManifestSchema } from "@avo/contracts";
import { createApp } from "../src/app.ts";
import { BenchmarkRunner } from "../src/benchmark.ts";
import { CodexAppServerAgentProvider } from "../src/codex-provider.ts";
import { prepareCodexRuntime } from "../src/codex-runtime.ts";
import { loadConfig } from "../src/config.ts";
import { AgentToolBroker } from "../src/tool-broker.ts";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3gQ3WQAAAABJRU5ErkJggg==", "base64");
const dataDir = resolve(process.env.AVO_CODEX_SMOKE_DATA_DIR ?? `../../tmp/codex-mcp-smoke-${Date.now()}`);
const runtime = await prepareCodexRuntime(loadConfig({ ...process.env, AVO_DATA_DIR: dataDir, AVO_PROVIDER_MODE: "live", AVO_API_PORT: "4310", AVO_CODEX_TURN_TIMEOUT_MS: "180000" }));
const config = runtime.config;
const store = new FileStateStore(dataDir);
const artifacts = new ArtifactStore(dataDir);
const broker = new AgentToolBroker();
const agent = new CodexAppServerAgentProvider(config, broker, store);
const images = new FakeImageProvider();
const verifier = new FakeVerifierProvider(1);
const runner = new AvoRunner(store, artifacts, agent, images, verifier);
const benchmarks = new BenchmarkRunner(store, runner);
const app = await createApp({
  config,
  store,
  artifacts,
  runner,
  benchmarks,
  broker,
  providerHealth: async () => ({ runnable: true }),
});

try {
  await app.listen({ host: "127.0.0.1", port: 4310 });
  const source = await artifacts.put({ bytes: pixel, mimeType: "image/png", originalName: "source.png" });
  const task = taskManifestSchema.parse({
    schema_version: 1,
    id: createId("task"),
    title: "Codex MCP smoke",
    request: "Keep this source image unchanged. Use the AVO tools to produce and submit one candidate.",
    source_artifact_id: source.id,
    references: [],
    created_at: new Date().toISOString(),
  });
  await store.saveTask(task);
  const run = await runner.createRun(task.id, { mode: "avo", max_generations: 1, max_generations_per_round: 1 });
  const completed = await runner.start(run.id);
  if (completed.status !== "completed" || completed.lineage_attempt_ids.length !== 1) {
    throw new Error(`codex_mcp_smoke_failed:${completed.status}:${completed.terminal_reason ?? "unknown"}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, status: completed.status, generations: completed.generation_count, attempts: completed.attempts.length })}\n`);
} finally {
  await app.close();
  await rm(dataDir, { recursive: true, force: true });
}
