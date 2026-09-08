import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import {
  benchmarkConclusionSchema,
  type ProviderHealth,
  type RunEvent,
  type RunSnapshot,
  type RoleProfiles,
  runConfigSchema,
  taskManifestSchema,
} from "@avo/contracts";
import { ArtifactStore, AvoRunner, createId, FileStateStore, SealedEvaluationStore } from "@avo/core";
import Fastify from "fastify";
import { z } from "zod";
import { BenchmarkRunner } from "./benchmark.ts";
import type { AppConfig } from "./config.ts";
import { AgentToolBroker } from "./tool-broker.ts";
import { proxyCodexRequest, type CodexProxyConfig } from "./codex-proxy.ts";

export type AppServices = {
  config: AppConfig;
  store: FileStateStore;
  artifacts: ArtifactStore;
  sealed: SealedEvaluationStore;
  runner: AvoRunner;
  benchmarks: BenchmarkRunner;
  broker: AgentToolBroker;
  runDefaults?: Partial<ReturnType<typeof runConfigSchema.parse>>;
  providerHealth: (profiles?: RoleProfiles) => Promise<ProviderHealth & { mode: string }>;
  modelProfiles?: { defaults: RoleProfiles; options: Array<{ id: "qwen" | "78code"; model: string; configured: boolean }> };
  resolveRunModels?: (profiles: RoleProfiles) => Partial<ReturnType<typeof runConfigSchema.parse>>;
  codexProxy?: CodexProxyConfig;
};

const imageMimeSchema = z.enum(["image/png", "image/jpeg", "image/webp"]);
const privateVerifierKeys = new Set([
  "hidden_verification",
  "private_feedback",
  "evidence",
  "evaluation_frame_revisions",
  "final_verifier_decisions",
]);
const redactHiddenVerification = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(redactHiddenVerification);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !privateVerifierKeys.has(key))
    .map(([key, item]) => [key, redactHiddenVerification(item)]));
};

const publicRun = (run: RunSnapshot): RunSnapshot => {
  const redacted = redactHiddenVerification(run) as RunSnapshot;
  return {
    ...redacted,
    comparative_decisions: redacted.comparative_decisions.map((decision) => ({
      ...decision,
      axis_judgments: [],
      evidence_refs: [],
      private_feedback: [],
      evidence: [],
      candidate_quality: decision.candidate_quality ? { delivery_status: decision.candidate_quality.delivery_status, defects: [] } : undefined,
      incumbent_quality: decision.incumbent_quality ? { delivery_status: decision.incumbent_quality.delivery_status, defects: [] } : undefined,
    })),
    evaluation_frame_revisions: [],
    final_verifier_decisions: [],
  };
};

const publicRunEvent = (event: RunEvent): RunEvent => {
  const { _snapshot: _snapshot, _snapshot_patch: _snapshotPatch, ...data } = event.data;
  return { ...event, data: redactHiddenVerification(data) as Record<string, unknown> };
};

export const createApp = async (services: AppServices) => {
  const app = Fastify({
    bodyLimit: 100 * 1024 * 1024,
    logger: { redact: ["req.headers.authorization", "req.headers.x-avo-tool-token"] },
  });
  await app.register(cors, { origin: /^http:\/\/127\.0\.0\.1:\d+$/ });
  await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024, files: 1 } });

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/api/provider-health", async () => services.providerHealth());
  app.get("/api/model-profiles", async () => services.modelProfiles ?? {
    defaults: { main: "qwen", verifier: "qwen", supervisor: "qwen" },
    options: [{ id: "qwen", model: "qwen3.8-flash", configured: true }],
  });
  if (services.codexProxy) {
    app.all("/internal/codex-provider/*", async (request, reply) =>
      proxyCodexRequest(request, reply, services.codexProxy!));
  }

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

  app.post("/api/sealed-uploads", async (request, reply) => {
    const file = await request.file();
    if (!file) return reply.code(400).send({ error: "image_file_required" });
    const mimeType = imageMimeSchema.safeParse(file.mimetype);
    if (!mimeType.success) return reply.code(415).send({ error: "unsupported_image_type" });
    return reply.code(201).send(await services.sealed.stageUpload({
      bytes: await file.toBuffer(),
      mimeType: mimeType.data,
      originalName: file.filename,
    }));
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
      user_brief: z.string().min(1).max(100_000).optional(),
      request: z.string().min(1).max(100_000).optional(),
      source_artifact_id: z.string(),
      references: z.array(z.object({ artifact_id: z.string(), caption: z.string().max(2_000).optional() })).default([]),
      preservation_contract: z.object({
        color: z.enum(["preserve", "allow_change", "unspecified"]).optional(),
        detail: z.enum(["preserve", "allow_change", "unspecified"]).optional(),
        text: z.enum(["preserve", "allow_change", "unspecified"]).optional(),
        composition: z.enum(["preserve", "allow_change", "unspecified"]).optional(),
        identity: z.enum(["preserve", "allow_change", "unspecified"]).optional(),
        edit_scope: z.enum(["local", "global", "unknown"]).optional(),
        additional_invariants: z.array(z.string()).max(50).optional(),
      }).optional(),
      hidden_references: z.array(z.object({ upload_token: z.string().uuid(), caption: z.string().max(2_000).optional() })).default([]),
      hidden_target_token: z.string().uuid().optional(),
      private_rubric: z.string().max(100_000).optional(),
    }).parse(request.body);
    const userBrief = body.user_brief ?? body.request;
    if (!userBrief) return reply.code(400).send({ error: "user_brief_required" });
    const artifactIds = [body.source_artifact_id, ...body.references.map((item) => item.artifact_id)];
    if ((await Promise.all(artifactIds.map((id) => services.artifacts.exists(id)))).some((exists) => !exists)) {
      return reply.code(400).send({ error: "task_artifact_missing" });
    }
    const taskId = createId("task");
    const hasHiddenEvaluation = body.hidden_references.length > 0 || Boolean(body.hidden_target_token) || Boolean(body.private_rubric?.trim());
    if (hasHiddenEvaluation) {
      await services.sealed.consumeForTask({
        taskId,
        references: body.hidden_references.map((item) => ({
          uploadToken: item.upload_token,
          ...(item.caption ? { caption: item.caption } : {}),
        })),
        ...(body.hidden_target_token ? { hiddenTargetToken: body.hidden_target_token } : {}),
        ...(body.private_rubric ? { privateRubric: body.private_rubric } : {}),
      });
    }
    const task = taskManifestSchema.parse({
      schema_version: 2,
      id: taskId,
      title: body.title,
      user_brief: userBrief,
      source_artifact_id: body.source_artifact_id,
      references: body.references,
      preservation_contract: {
        color: "unspecified",
        detail: "unspecified",
        text: "unspecified",
        composition: "unspecified",
        identity: "unspecified",
        edit_scope: "unknown",
        additional_invariants: [],
      },
      has_hidden_evaluation: hasHiddenEvaluation,
      created_at: new Date().toISOString(),
    });
    await services.store.saveTask(task);
    return reply.code(201).send({ task });
  });
  app.get("/api/tasks/:id", async (request) => ({ task: await services.store.getTask((request.params as { id: string }).id) }));
  app.get("/api/tasks/:id/evaluator-inputs", async (request) => ({
    evaluator_inputs: await services.sealed.describe((request.params as { id: string }).id),
  }));
  app.get("/api/tasks/:id/evaluator-assets/:slot", async (request, reply) => {
    const params = request.params as { id: string; slot: string };
    const item = await services.sealed.readAsset(params.id, params.slot);
    reply.header("content-type", item.mimeType);
    reply.header("cache-control", "private, no-store");
    return reply.send(item.bytes);
  });

  app.get("/api/runs", async () => ({ items: (await services.store.listRuns()).map(publicRun) }));
  app.post("/api/runs", async (request, reply) => {
    const body = z.object({ task_id: z.string(), config: runConfigSchema.partial().and(z.object({ mode: runConfigSchema.shape.mode })) }).parse(request.body);
    const profiles = body.config.role_profiles ?? services.modelProfiles?.defaults;
    if (profiles && services.modelProfiles && Object.values(profiles).some((id) => !services.modelProfiles!.options.some((option) => option.id === id && option.configured))) {
      return reply.code(400).send({ error: "selected_model_provider_not_configured" });
    }
    const health = await services.providerHealth(profiles);
    if (!health.runnable) return reply.code(503).send({ error: "provider_capability_probe_failed", health });
    const run = await services.runner.createRun(body.task_id, runConfigSchema.parse({
      ...body.config,
      ...services.runDefaults,
      ...(profiles ? { ...services.resolveRunModels?.(profiles), role_profiles: profiles } : {}),
    }));
    void services.runner.start(run.id);
    return reply.code(202).send({ run: publicRun(run) });
  });
  app.get("/api/runs/:id", async (request) => ({ run: publicRun(await services.store.getRun((request.params as { id: string }).id)) }));
  app.get("/api/runs/:id/evaluator-results", async (request) => {
    const run = await services.store.getRun((request.params as { id: string }).id);
    return {
      evaluation_frames: run.evaluation_frame_revisions,
      comparative_decisions: run.comparative_decisions,
      final_decisions: run.final_verifier_decisions,
      quality_measurements: run.evaluations.map((evaluation) => ({
        evaluation_id: evaluation.id,
        draft_id: evaluation.draft_id,
        source_quality_debt: evaluation.source_quality_debt,
        step_quality_debt: evaluation.step_quality_debt,
        validator_elapsed_ms: evaluation.validator_elapsed_ms,
      })),
    };
  });
  app.post("/api/runs/:id/stop", async (request) => ({ run: publicRun(await services.runner.requestStop((request.params as { id: string }).id)) }));
  app.post("/api/runs/:id/resume", async (request, reply) => {
    const existing = await services.store.getRun((request.params as { id: string }).id);
    const health = await services.providerHealth(existing.config.role_profiles ?? { main: "qwen", verifier: "qwen", supervisor: "qwen" });
    if (!health.runnable) return reply.code(503).send({ error: "provider_capability_probe_failed", health });
    const id = (request.params as { id: string }).id;
    return reply.code(202).send({ run: publicRun(await services.runner.resume(id)) });
  });
  app.delete("/api/runs/:id", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (services.runner.isActive(id)) return reply.code(409).send({ error: "run_active" });
    const benchmarks = await services.store.listBenchmarks();
    if (benchmarks.some((benchmark) => benchmark.run_ids.includes(id))) {
      return reply.code(409).send({ error: "run_referenced_by_benchmark" });
    }
    const run = await services.store.getRun(id);
    const candidateArtifacts = new Set([
      ...run.attempts.map((attempt) => attempt.generated_artifact_id),
      ...run.drafts.flatMap((draft) => [draft.raw_artifact_id, draft.artifact_id]),
    ]);
    await services.store.deleteRun(id);
    const [tasks, remainingRuns] = await Promise.all([services.store.listTasks(), services.store.listRuns()]);
    const referenced = new Set([
      ...tasks.flatMap((task) => [task.source_artifact_id, ...task.references.map((reference) => reference.artifact_id)]),
      ...remainingRuns.flatMap((item) => [
        ...item.attempts.map((attempt) => attempt.generated_artifact_id),
        ...item.drafts.flatMap((draft) => [draft.raw_artifact_id, draft.artifact_id, draft.parent_artifact_id]),
      ]),
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
    const querySequence = Number((request.query as { after?: string }).after ?? 0);
    let sequence = Math.max(Number(request.headers["last-event-id"] ?? 0), Number.isFinite(querySequence) ? querySequence : 0);
    const send = async () => {
      try {
        const events = await services.store.listRunEvents(id, { afterSequence: sequence });
        for (const event of events) {
          reply.raw.write(`id: ${event.sequence}\nevent: message\ndata: ${JSON.stringify(publicRunEvent(event))}\n\n`);
          sequence = event.sequence;
        }
        const run = await services.store.getRun(id);
        if (["completed", "failed", "stopped", "budget_exhausted", "interrupted", "finalization_pending"].includes(run.status)) {
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
    if (/stream closed prematurely|premature close/i.test(normalized.message)) {
      if (!reply.raw.destroyed) reply.raw.destroy();
      return;
    }
    if (reply.sent || reply.raw.headersSent) {
      if (!reply.raw.destroyed) reply.raw.destroy();
      return;
    }
    const status = normalized.message.includes("not_found") || (normalized as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 400;
    reply.header("content-type", "application/json; charset=utf-8");
    reply.code(status).send(JSON.stringify({ error: normalized.message || "request_failed" }));
  });
  return app;
};
