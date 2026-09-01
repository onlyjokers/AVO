import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ArtifactStore,
  AvoRunner,
  FakeAgentProvider,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
} from "@avo/core";
import { createApp } from "../src/app.ts";
import { BenchmarkRunner } from "../src/benchmark.ts";
import { resolveAvoMcpElicitation } from "../src/codex-provider.ts";
import { prepareCodexRuntime } from "../src/codex-runtime.ts";
import { loadConfig } from "../src/config.ts";
import { AgentToolBroker } from "../src/tool-broker.ts";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3gQ3WQAAAABJRU5ErkJggg==", "base64");

const fixture = async (runnable = true) => {
  const directory = await mkdtemp(join(tmpdir(), "avo-api-"));
  const config = loadConfig({ AVO_DATA_DIR: directory, AVO_PROVIDER_MODE: "fake" });
  const store = new FileStateStore(directory);
  const artifacts = new ArtifactStore(directory);
  const runner = new AvoRunner(store, artifacts, new FakeAgentProvider(), new FakeImageProvider(), new FakeVerifierProvider(3));
  const runDefaults = {
    main_model: "fixture-codex",
    generator_model: "fixture-image",
    verifier_model: "fixture-qwen",
    provider_revisions: { codex: "fixture-cli", generator: "fixture-generator", verifier: "fixture-verifier" },
  };
  const benchmarks = new BenchmarkRunner(store, runner, runDefaults);
  const broker = new AgentToolBroker();
  const app = await createApp({
    config,
    store,
    artifacts,
    runner,
    benchmarks,
    broker,
    runDefaults,
    providerHealth: async () => ({
      mode: "fake",
      codex: { enabled: false, ok: runnable, message: runnable ? "fake" : "blocked" },
      generator: { enabled: false, ok: runnable, message: runnable ? "fake" : "blocked" },
      verifier: { enabled: false, ok: runnable, message: runnable ? "fake" : "blocked" },
      runnable,
    }),
  });
  const source = await artifacts.put({ bytes: pixel, mimeType: "image/png", originalName: "source.png" });
  return { directory, app, store, runner, source };
};

const createTask = async (context: Awaited<ReturnType<typeof fixture>>) => {
  const response = await context.app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      title: "API task",
      request: "Change the background and preserve the subject.",
      source_artifact_id: context.source.id,
      references: [],
    },
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json().task as { id: string };
};

const waitFor = async <T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("wait_timeout");
};

test("task and AVO run API complete a fake-provider loop", async () => {
  const context = await fixture();
  try {
    const task = await createTask(context);
    const response = await context.app.inject({ method: "POST", url: "/api/runs", payload: { task_id: task.id, config: { mode: "avo", max_generations: 5, main_model: "client-override" } } });
    assert.equal(response.statusCode, 202, response.body);
    const runId = response.json().run.id as string;
    const run = await waitFor(() => context.store.getRun(runId), (value) => value.status === "completed");
    assert.equal(run.generation_count, 3);
    assert.equal(run.lineage_attempt_ids.length, 1);
    assert.equal(run.config.main_model, "fixture-codex");
    assert.equal(run.config.provider_revisions.codex, "fixture-cli");

    const detail = await context.app.inject({ method: "GET", url: `/api/runs/${runId}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().run.terminal_reason, "verifier_passed");

    const eventLog = await context.app.inject({ method: "GET", url: `/api/runs/${runId}/event-log` });
    assert.equal(eventLog.statusCode, 200);
    assert.ok(eventLog.json().items.length > 0);
    assert.ok(eventLog.json().items.every((event: { data: object }) => !("_snapshot" in event.data)));
  } finally {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("benchmark API runs all three methods without feeding back into best-of planning", async () => {
  const context = await fixture();
  try {
    const task = await createTask(context);
    const response = await context.app.inject({ method: "POST", url: "/api/benchmarks", payload: { task_ids: [task.id] } });
    assert.equal(response.statusCode, 202, response.body);
    const id = response.json().benchmark.id as string;
    const benchmark = await waitFor(() => context.store.getBenchmark(id), (value) => ["completed", "failed"].includes(value.status), 20_000);
    assert.equal(benchmark.status, "completed");
    assert.equal(benchmark.run_ids.length, 3);
    const runs = await Promise.all(benchmark.run_ids.map((runId) => context.store.getRun(runId)));
    assert.equal(runs.find((run) => run.config.mode === "one_shot")?.generation_count, 1);
    assert.equal(runs.find((run) => run.config.mode === "best_of_n")?.generation_count, 24);
    assert.equal(runs.find((run) => run.config.mode === "avo")?.generation_count, 3);
    assert.equal(runs.find((run) => run.config.mode === "best_of_n")?.lineage_attempt_ids.length, 1);

    const report = await context.app.inject({ method: "GET", url: `/api/benchmarks/${id}` });
    assert.equal(report.statusCode, 200, report.body);
    assert.equal(report.json().rows.length, 3);
    assert.ok(report.json().rows.every((row: { prefix_curve: unknown[] }) => row.prefix_curve.length === 24));
    assert.ok(report.json().rows.every((row: { total_latency_ms: number }) => row.total_latency_ms >= 0));
    assert.ok(report.json().rows.every((row: { usage: { unpriced: boolean } }) => row.usage.unpriced));
  } finally {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("agent tool broker rejects unknown and expired sessions", async () => {
  const context = await fixture();
  try {
    const response = await context.app.inject({
      method: "POST",
      url: "/internal/agent-tools/avo_get_state",
      headers: { "x-avo-tool-token": "not-valid" },
      payload: {},
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "invalid_or_expired_tool_session");
  } finally {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("startup recovery marks only unfinished state as interrupted", async () => {
  const context = await fixture();
  try {
    const task = await createTask(context);
    const run = await context.runner.createRun(task.id, { mode: "avo" });
    const benchmark = await new BenchmarkRunner(context.store, context.runner).create([task.id]);

    assert.deepEqual(await context.store.recoverInterruptedRuns(), [run.id]);
    assert.equal((await context.store.getRun(run.id)).status, "interrupted");
    assert.equal((await context.store.getRun(run.id)).terminal_reason, "api_process_restarted");

    assert.deepEqual(await context.store.recoverInterruptedBenchmarks(), [benchmark.id]);
    assert.equal((await context.store.getBenchmark(benchmark.id)).status, "failed");
    assert.deepEqual(await context.store.recoverInterruptedRuns(), []);
  } finally {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("run and benchmark creation fail closed when a capability probe is unhealthy", async () => {
  const context = await fixture(false);
  try {
    const task = await createTask(context);
    const run = await context.app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { task_id: task.id, config: { mode: "avo" } },
    });
    assert.equal(run.statusCode, 503);
    assert.equal(run.json().error, "provider_capability_probe_failed");

    const benchmark = await context.app.inject({
      method: "POST",
      url: "/api/benchmarks",
      payload: { task_ids: [task.id] },
    });
    assert.equal(benchmark.statusCode, 503);
    assert.equal((await context.store.listRuns()).length, 0);
    assert.equal((await context.store.listBenchmarks()).length, 0);
  } finally {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("Codex runtime writes a project catalog without mutating the global cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avo-codex-runtime-"));
  const codexHome = join(directory, "codex-home");
  const fakeCodex = join(directory, "codex");
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    await writeFile(join(directory, "placeholder"), "");
    await mkdir(codexHome, { recursive: true });
    const originalCache = JSON.stringify({
      client_version: "newer",
      models: [{ slug: "gpt-5.6-sol", display_name: "Sol", input_modalities: ["text", "image"] }],
    });
    await writeFile(join(codexHome, "models_cache.json"), originalCache);
    await writeFile(fakeCodex, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'codex-cli 9.9.9'; fi\nexit 0\n");
    await chmod(fakeCodex, 0o755);
    process.env.CODEX_HOME = codexHome;
    const prepared = await prepareCodexRuntime(loadConfig({
      AVO_DATA_DIR: join(directory, "data"),
      AVO_PROVIDER_MODE: "live",
      AVO_CODEX_BIN: fakeCodex,
      AVO_CODEX_MODEL: "qwen3.8-flash",
    }));
    const catalog = JSON.parse(await readFile(prepared.config.AVO_CODEX_MODEL_CATALOG!, "utf8")) as {
      models: Array<{ slug: string; supports_parallel_tool_calls: boolean }>;
    };
    assert.equal(prepared.codexRevision, "codex-cli 9.9.9");
    assert.equal(catalog.models.length, 1);
    assert.equal(catalog.models[0]?.slug, "qwen3.8-flash");
    assert.deepEqual((catalog.models[0] as { input_modalities?: string[] }).input_modalities, ["text", "image"]);
    assert.equal(catalog.models[0]?.supports_parallel_tool_calls, false);
    assert.equal(await readFile(join(codexHome, "models_cache.json"), "utf8"), originalCache);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Codex Harness accepts only form elicitations from the controlled AVO MCP", () => {
  assert.deepEqual(resolveAvoMcpElicitation({
    serverName: "avo",
    request: {
      mode: "form",
      requestedSchema: {
        type: "object",
        required: ["permission", "confirmed"],
        properties: {
          permission: { type: "string", enum: ["decline", "approve"] },
          confirmed: { type: "boolean" },
          optional_note: { type: "string" },
        },
      },
    },
  }), {
    action: "accept",
    content: { permission: "approve", confirmed: true },
  });
  assert.deepEqual(resolveAvoMcpElicitation({ serverName: "unknown", request: { mode: "form" } }), {
    action: "decline",
    content: null,
  });
  assert.deepEqual(resolveAvoMcpElicitation({ serverName: "avo", request: { mode: "url" } }), {
    action: "decline",
    content: null,
  });
});

test("relative data paths resolve from the AVO workspace root", () => {
  const config = loadConfig({ AVO_DATA_DIR: "./data", AVO_PROVIDER_MODE: "fake" });
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  assert.equal(config.AVO_ROOT, root);
  assert.equal(config.AVO_DATA_DIR, join(root, "data"));
});
