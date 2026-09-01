import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  benchmarkConclusionSchema,
  type ProviderHealth,
  type RunEvent,
  runConfigSchema,
  taskManifestSchema,
} from "@avo/contracts";
import { ArtifactStore, AvoRunner, createId, FileStateStore } from "@avo/core";
import Fastify from "fastify";
import { z } from "zod";
import { BenchmarkRunner } from "./benchmark.ts";
import type { AppConfig } from "./config.ts";
import { AgentToolBroker } from "./tool-broker.ts";

export type AppServices = {
  config: AppConfig;
  store: FileStateStore;
  artifacts: ArtifactStore;
  runner: AvoRunner;
  benchmarks: BenchmarkRunner;
  broker: AgentToolBroker;
  runDefaults?: Partial<ReturnType<typeof runConfigSchema.parse>>;
  providerHealth: () => Promise<ProviderHealth & { mode: string }>;
};

const imageMimeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
const publicRunEvent = (event: RunEvent): RunEvent => {
  const { _snapshot: _snapshot, ...data } = event.data;
  return { ...event, data };
};

export const createApp = async (services: AppServices) => {
  const app = Fastify({ logger: { redact: ["req.headers.authorization", "req.headers.x-avo-tool-token"] } });
  await app.register(cors, { origin: /^http:\/\/127\.0\.0\.1:\d+$/ });
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/provider-health", async () => services.providerHealth());

  app.post("/api/artifacts", async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "image_file_required" });
    const mimeType = imageMimeSchema.safeParse(file.mimetype);
    if (!mimeType.success) return reply.code(415).send({ error: "unsupported_image_type" });
    const artifact = await services.artifacts.put({
      bytes: await file.toBuffer(),
      mimeType: mimeType.data,
      originalName: file.filename,
    });
    return reply.code(201).send({ artifact });
  });

  app.get("/api/artifacts/:id", async (request, reply) => {
    const id = decodeURIComponent((request.params as { id: string }).id);
    const item = await services.artifacts.get(id);
    reply.header("content-type", item.artifact.mime_type);
    reply.header("cache-control", "public, max-age=31536000, immutable");
    return reply.send(item.bytes);
  });

  app.get("/api/tasks", async () => ({ items: await services.store.listTasks() }));
  app.post("/api/tasks", async (request, reply) => {
    const body = z.object({
      title: z.string().min(1).max(200),
      request: z.string().min(1).max(100_000),
      source_artifact_id: z.string(),
      references: z.array(z.object({ artifact_id: z.string(), caption: z.string().max(2_000).optional() })).default([]),
    }).parse(request.body);
    const artifactIds = [body.source_artifact_id, ...body.references.map((item) => item.artifact_id)];
    if ((await Promise.all(artifactIds.map((id) => services.artifacts.exists(id)))).some((exists) => !exists)) {
      return reply.code(400).send({ error: "task_artifact_missing" });
    }
    const task = taskManifestSchema.parse({ schema_version: 1, id: createId("task"), ...body, created_at: new Date().toISOString() });
    await services.store.saveTask(task);
    return reply.code(201).send({ task });
  });
  app.get("/api/tasks/:id", async (request) => ({ task: await services.store.getTask((request.params as { id: string }).id) }));

  app.get("/api/runs", async () => ({ items: await services.store.listRuns() }));
  app.post("/api/runs", async (request, reply) => {
    const health = await services.providerHealth();
    if (!health.runnable) return reply.code(503).send({ error: "provider_capability_probe_failed", health });
    const body = z.object({ task_id: z.string(), config: runConfigSchema.partial().and(z.object({ mode: runConfigSchema.shape.mode })) }).parse(request.body);
    const run = await services.runner.createRun(body.task_id, runConfigSchema.parse({
      ...body.config,
      ...services.runDefaults,
    }));
    void services.runner.start(run.id);
    return reply.code(202).send({ run });
  });
  app.get("/api/runs/:id", async (request) => ({ run: await services.store.getRun((request.params as { id: string }).id) }));
  app.post("/api/runs/:id/stop", async (request) => ({ run: await services.runner.requestStop((request.params as { id: string }).id) }));
  app.post("/api/runs/:id/resume", async (request, reply) => {
    const health = await services.providerHealth();
    if (!health.runnable) return reply.code(503).send({ error: "provider_capability_probe_failed", health });
    const id = (request.params as { id: string }).id;
    return reply.code(202).send({ run: await services.runner.resume(id) });
  });
  app.delete("/api/runs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (services.runner.isActive(id)) return reply.code(409).send({ error: "run_active" });
    const benchmarks = await services.store.listBenchmarks();
    if (benchmarks.some((benchmark) => benchmark.run_ids.includes(id))) {
      return reply.code(409).send({ error: "run_referenced_by_benchmark" });
    }
    const run = await services.store.getRun(id);
    const candidateArtifacts = new Set(run.attempts.map((attempt) => attempt.generated_artifact_id));
    await services.store.deleteRun(id);
    const [tasks, remainingRuns] = await Promise.all([services.store.listTasks(), services.store.listRuns()]);
    const referenced = new Set([
      ...tasks.flatMap((task) => [task.source_artifact_id, ...task.references.map((reference) => reference.artifact_id)]),
      ...remainingRuns.flatMap((item) => item.attempts.map((attempt) => attempt.generated_artifact_id)),
    ]);
    await Promise.all([...candidateArtifacts].map((artifactId) => services.artifacts.removeIfUnreferenced(artifactId, referenced.has(artifactId))));
    return reply.code(204).send();
  });
  app.get("/api/runs/:id/events", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": request.headers.origin ?? "http://127.0.0.1:4311",
    });
    let sequence = Number(request.headers["last-event-id"] ?? 0);
    const send = async () => {
      try {
        const events = await services.store.listRunEvents(id);
        for (const event of events.filter((item) => item.sequence > sequence)) {
          reply.raw.write(`id: ${event.sequence}\nevent: message\ndata: ${JSON.stringify(publicRunEvent(event))}\n\n`);
          sequence = event.sequence;
        }
        const run = await services.store.getRun(id);
        if (["completed", "failed", "stopped", "budget_exhausted", "interrupted"].includes(run.status)) {
          clearInterval(interval);
          reply.raw.end();
        }
      } catch (error) {
        clearInterval(interval);
        reply.raw.end(`event: error\ndata: ${JSON.stringify({ error: (error as Error).message })}\n\n`);
      }
    };
    const interval = setInterval(() => void send(), 500);
    request.raw.on("close", () => clearInterval(interval));
    await send();
  });
  app.get("/api/runs/:id/event-log", async (request) => ({
    items: (await services.store.listRunEvents((request.params as { id: string }).id)).map(publicRunEvent),
  }));

  app.get("/api/benchmarks", async () => ({ items: await services.store.listBenchmarks() }));
  app.post("/api/benchmarks", async (request, reply) => {
    const health = await services.providerHealth();
    if (!health.runnable) return reply.code(503).send({ error: "provider_capability_probe_failed", health });
    const { task_ids } = z.object({ task_ids: z.array(z.string()).min(1).max(10) }).parse(request.body);
    const benchmark = await services.benchmarks.create(task_ids);
    void services.benchmarks.start(benchmark.id);
    return reply.code(202).send({ benchmark });
  });
  app.get("/api/benchmarks/:id", async (request) => {
    const benchmark = await services.store.getBenchmark((request.params as { id: string }).id);
    return services.benchmarks.report(benchmark);
  });
  app.put("/api/benchmarks/:id/conclusion", async (request) => {
    const id = (request.params as { id: string }).id;
    const benchmark = await services.store.getBenchmark(id);
    const conclusion = benchmarkConclusionSchema.parse({ ...(request.body as object), recorded_at: new Date().toISOString() });
    return { benchmark: await services.store.saveBenchmark({ ...benchmark, conclusion, updated_at: new Date().toISOString() }) };
  });

  app.post("/internal/agent-tools/:name", async (request, reply) => {
    const token = request.headers["x-avo-tool-token"];
    if (typeof token !== "string") return reply.code(401).send({ error: "tool_token_required" });
    const result = await services.broker.invoke(token, (request.params as { name: string }).name, (request.body ?? {}) as Record<string, unknown>);
    return result;
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error("request_failed");
    const status = normalized.message.includes("not_found") || (normalized as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400;
    reply.code(status).send({ error: normalized.message || "request_failed" });
  });
  return app;
};
