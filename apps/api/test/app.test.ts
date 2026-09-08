import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";
import sharp from "sharp";
import type { RunSnapshot } from "@avo/contracts";
import {
  type AgentRoundContext,
  type AgentToolbox,
  ArtifactStore,
  AvoRunner,
  FakeAgentProvider,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
  SealedEvaluationStore,
} from "@avo/core";
import { createApp } from "../src/app.ts";
import { BenchmarkRunner } from "../src/benchmark.ts";
import { AVO_MCP_TOOL_ALLOWLIST, parseStructuredJsonText, resolveAvoMcpElicitation, validateAvoMcpInventory } from "../src/codex-provider.ts";
import { createQwenSingleToolCallTransform, qwenRequestBody, qwenResponseBody } from "../src/codex-proxy.ts";
import { prepareCodexRuntime } from "../src/codex-runtime.ts";
import { loadConfig } from "../src/config.ts";
import { AgentToolBroker } from "../src/tool-broker.ts";
import { GptImageProvider, QwenResponsesVerifier } from "../src/http-providers.ts";

const pixel = await sharp({
  create: { width: 64, height: 48, channels: 3, background: { r: 90, g: 130, b: 180 } },
}).png().toBuffer();

const fixture = async (runnable = true) => {
  const directory = await mkdtemp(join(tmpdir(), "avo-api-"));
  const config = loadConfig({ AVO_DATA_DIR: directory, AVO_PROVIDER_MODE: "fake" });
  const store = new FileStateStore(directory);
  const artifacts = new ArtifactStore(directory);
  const sealed = new SealedEvaluationStore(directory);
  const runner = new AvoRunner(store, artifacts, new FakeAgentProvider(), new FakeImageProvider(), new FakeVerifierProvider(1), sealed);
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
    sealed,
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
  return { directory, app, store, runner, sealed, source };
};

const createTask = async (context: Awaited<ReturnType<typeof fixture>>) => {
  const response = await context.app.inject({
    method: "POST",
    url: "/api/tasks",
    payload: {
      title: "API task",
      user_brief: "Change the background and preserve the subject.",
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

test("structured Codex output accepts JSON embedded in Markdown and rejects prose", () => {
  assert.deepEqual(parseStructuredJsonText('{"intervene":false}'), { intervene: false });
  assert.deepEqual(parseStructuredJsonText('## Supervisor\n\n```json\n{"intervene":true,"try":["restart"]}\n```'), {
    intervene: true,
    try: ["restart"],
  });
  assert.deepEqual(parseStructuredJsonText('Supervisor result:\n{"intervene":false,"diagnosis":"brace } in string"}\nDone.'), {
    intervene: false,
    diagnosis: "brace } in string",
  });
  assert.throws(() => parseStructuredJsonText("## Supervisor\nNo structured result."), (error: unknown) => {
    assert.match((error as Error).message, /codex_structured_output_invalid_json/);
    assert.match((error as { structuredOutputPreview: string }).structuredOutputPreview, /No structured result/);
    return true;
  });
});

test("task and AVO run API complete a fake-provider loop", async () => {
  const context = await fixture();
  try {
    const task = await createTask(context);
    const response = await context.app.inject({ method: "POST", url: "/api/runs", payload: { task_id: task.id, config: { mode: "avo", max_generations: 3, main_model: "client-override" } } });
    assert.equal(response.statusCode, 202, response.body);
    const runId = response.json().run.id as string;
    const run = await waitFor(() => context.store.getRun(runId), (value) => ["budget_exhausted", "failed"].includes(value.status));
    assert.equal(run.status, "budget_exhausted", run.terminal_reason);
    assert.equal(run.generation_count, 3);
    assert.ok(run.lineage_attempt_ids.length >= 1, JSON.stringify(run.evaluations.map((item) => item.correctness_gate)));
    assert.equal(run.config.main_model, "fixture-codex");
    assert.equal(run.config.provider_revisions.codex, "fixture-cli");

    const detail = await context.app.inject({ method: "GET", url: `/api/runs/${runId}` });
    assert.equal(detail.statusCode, 200);
    assert.equal(detail.json().run.terminal_reason, "generation_budget_exhausted");

    const eventLog = await context.app.inject({ method: "GET", url: `/api/runs/${runId}/event-log` });
    assert.equal(eventLog.statusCode, 200);
    assert.ok(eventLog.json().items.length > 0);
    assert.ok(eventLog.json().items.every((event: { data: object }) =>
      !("_snapshot" in event.data) && !("_snapshot_patch" in event.data)));
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
    const benchmark = await waitFor(() => context.store.getBenchmark(id), (value) => ["completed", "failed"].includes(value.status), 120_000);
    assert.equal(benchmark.status, "completed");
    assert.equal(benchmark.run_ids.length, 3);
    const runs = await Promise.all(benchmark.run_ids.map((runId) => context.store.getRun(runId)));
    assert.equal(runs.find((run) => run.config.mode === "one_shot")?.generation_count, 1);
    assert.equal(runs.find((run) => run.config.mode === "best_of_n")?.generation_count, 24);
    assert.equal(runs.find((run) => run.config.mode === "avo")?.generation_count, 24);
    assert.ok((runs.find((run) => run.config.mode === "best_of_n")?.lineage_attempt_ids.length ?? 0) >= 1);

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

test("benchmark runs different tasks concurrently but serializes methods for each task", async () => {
  const context = await fixture();
  try {
    const firstTask = await createTask(context);
    const secondTask = await createTask(context);
    const taskByRun = new Map<string, string>();
    const activeByTask = new Map<string, number>();
    let runNumber = 0;
    let activeTotal = 0;
    let peakTotal = 0;
    let peakSameTask = 0;
    const trackingRunner = {
      async createRun(taskId: string) {
        const id = `run-concurrency-${++runNumber}`;
        taskByRun.set(id, taskId);
        return { id } as RunSnapshot;
      },
      async start(runId: string) {
        const taskId = taskByRun.get(runId)!;
        activeTotal += 1;
        activeByTask.set(taskId, (activeByTask.get(taskId) ?? 0) + 1);
        peakTotal = Math.max(peakTotal, activeTotal);
        peakSameTask = Math.max(peakSameTask, activeByTask.get(taskId)!);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeTotal -= 1;
        activeByTask.set(taskId, activeByTask.get(taskId)! - 1);
        return {} as RunSnapshot;
      },
    } as unknown as AvoRunner;
    const scheduler = new BenchmarkRunner(context.store, trackingRunner, {}, 2);
    const benchmark = await scheduler.create([firstTask.id, secondTask.id]);
    await scheduler.start(benchmark.id);
    const completed = await context.store.getBenchmark(benchmark.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.run_ids.length, 6);
    assert.equal(peakTotal, 2);
    assert.equal(peakSameTask, 1);
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

test("agent tool broker supports a continuous autonomous tool loop and serializes concurrent calls", async () => {
  const calls: string[] = [];
  let currentPrompt = "";
  let releaseSlowPrompt!: () => void;
  const slowPrompt = new Promise<void>((resolve) => { releaseSlowPrompt = resolve; });
  const tools = {
    getRunSnapshot() { return { pending_decision: undefined } as unknown as RunSnapshot; },
    async recordAgentRuntime() { calls.push("runtime"); },
    async setPrompt(prompt: string) {
      calls.push(`prompt:${prompt}`);
      currentPrompt = prompt;
      if (prompt === "slow") await slowPrompt;
    },
    getPrompt() { return currentPrompt; },
    async generateImage() { calls.push("generate"); return "sha256:draft"; },
    signalBudgetExceeded() {},
  } as unknown as AgentToolbox;
  const broker = new AgentToolBroker();
  const unregister = broker.register("autonomous-step", tools, {} as AgentRoundContext);
  try {
    const first = broker.invoke("autonomous-step", "avo_set_prompt", { prompt: "slow" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const queued = broker.invoke("autonomous-step", "avo_set_prompt", { prompt: "queued" });
    let queuedSettled = false;
    void queued.finally(() => { queuedSettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(queuedSettled, false);
    releaseSlowPrompt();
    await first;
    await queued;
    for (let index = 0; index < 12; index += 1) {
      await broker.invoke("autonomous-step", "avo_set_prompt", { prompt: `revision-${index}` });
    }
    assert.equal(calls.length, 28);
    assert.equal(calls[0], "runtime");
    assert.equal(calls[1], "prompt:slow");
    assert.deepEqual(calls.slice(2, 4), ["runtime", "prompt:queued"]);
    assert.deepEqual(calls.slice(-4), ["runtime", "prompt:revision-10", "runtime", "prompt:revision-11"]);
  } finally {
    unregister();
  }
});

test("agent tool broker enters decision-only mode before an unsafe generation", async () => {
  let generated = false;
  const run = {
    pending_decision: undefined,
    drafts: [],
    evaluations: [],
    config: { max_generations: 24 },
    generation_count: 0,
  } as unknown as RunSnapshot;
  const tools = {
    getRunSnapshot() { return run; },
    async recordAgentRuntime() {},
    async setStepDeadline(deadline: RunSnapshot["step_deadline"]) { run.step_deadline = deadline; },
    getPrompt() { return "agent prompt"; },
    async generateImage() { generated = true; return "sha256:draft"; },
    signalBudgetExceeded() {},
  } as unknown as AgentToolbox;
  const now = Date.now();
  run.active_variation_step = 1;
  run.step_deadline = {
    started_at: new Date(now - 16 * 60_000).toISOString(),
    soft_deadline_at: new Date(now - 60_000).toISOString(),
    hard_deadline_at: new Date(now + 4 * 60_000).toISOString(),
    state: "open",
  };
  const broker = new AgentToolBroker();
  const unregister = broker.register("deadline-step", tools, { run } as AgentRoundContext, run.step_deadline);
  try {
    const result = await broker.invoke("deadline-step", "avo_generate_image", {}) as Record<string, unknown>;
    assert.equal(result.error, "step_deadline_insufficient_for_generation");
    assert.equal(result.deadline_state, "decision_only");
    assert.equal(run.step_deadline?.state, "decision_only");
    assert.equal(generated, false);
    const blocked = await broker.invoke("deadline-step", "avo_set_prompt", { prompt: "another" }) as Record<string, unknown>;
    assert.equal(blocked.decision_required, true);
  } finally {
    unregister();
  }
});

test("agent tool broker requires an explicit pending-decision disposition before search resumes", async () => {
  let currentPrompt = "";
  let declinedWith = "";
  const run = {
    pending_decision: {
      source_step: 1,
      draft_ids: ["draft-carried"],
      evaluation_ids: ["evaluation-carried"],
      reason: "agent_step_timeout",
      created_at: new Date().toISOString(),
    },
  } as unknown as RunSnapshot;
  const tools = {
    getRunSnapshot() { return run; },
    async recordAgentRuntime() {},
    getPrompt() { return currentPrompt; },
    async setPrompt(prompt: string) { currentPrompt = prompt; },
    async declinePendingDecision(rationale: string) {
      declinedWith = rationale;
      run.pending_decision = undefined;
    },
    signalBudgetExceeded() {},
  } as unknown as AgentToolbox;
  const broker = new AgentToolBroker();
  const unregister = broker.register("pending-decision-step", tools, {} as AgentRoundContext);
  try {
    const blocked = await broker.invoke("pending-decision-step", "avo_set_prompt", { prompt: "new direction" }) as Record<string, unknown>;
    assert.equal(blocked.decision_required, true);
    assert.equal((blocked.pending_decision as { source_step: number }).source_step, 1);

    const declined = await broker.invoke("pending-decision-step", "avo_decline_pending_decision", {
      rationale: "The carried result violates the hidden blocker; restart from source.",
    }) as Record<string, unknown>;
    assert.equal(declined.ok, true);
    assert.match(declinedWith, /restart from source/);

    const resumed = await broker.invoke("pending-decision-step", "avo_set_prompt", { prompt: "new direction" }) as Record<string, unknown>;
    assert.equal(resumed.ok, true);
    assert.equal(currentPrompt, "new direction");
  } finally {
    unregister();
  }
});

test("Qwen proxy forces sequential low-reasoning tool execution and caps output", () => {
  const body = JSON.parse(qwenRequestBody({
    model: "qwen3.8-flash",
    instructions: "generic Codex instructions that must not reach Qwen",
    tools: [
      { type: "function", name: "web_search", parameters: {} },
      { type: "custom", name: "apply_patch", format: {} },
      {
        type: "namespace",
        name: "mcp__avo",
        tools: [
          { type: "function", name: "avo_get_state", description: "state", parameters: { type: "object" } },
          { type: "function", name: "avo_generate_image", description: "generate", parameters: { type: "object" } },
        ],
      },
    ],
    parallel_tool_calls: true,
    reasoning: { effort: "high" },
    max_output_tokens: 32_000,
  }, 8_192)) as Record<string, unknown>;
  assert.equal(body.parallel_tool_calls, false);
  assert.equal(body.store, true);
  assert.deepEqual(body.reasoning, { effort: "low" });
  assert.equal(body.max_output_tokens, 8_192);
  assert.equal(body.model, "qwen3.8-flash");
  assert.match(String(body.instructions), /exactly one function per response/);
  assert.equal(String(body.instructions).includes("generic Codex"), false);
  const tools = body.tools as Array<{ type: string; name: string }>;
  assert.deepEqual(tools.map(({ type, name }) => ({ type, name })), [
    { type: "function", name: "avo_get_state" },
    { type: "function", name: "avo_generate_image" },
  ]);
});

test("Qwen proxy gives no-tool structured requests a JSON-only instruction", () => {
  const body = JSON.parse(qwenRequestBody({
    model: "qwen3.8-flash",
    instructions: "generic Codex instructions",
    tools: [],
    text: { format: { type: "json_schema", name: "supervisor", schema: { type: "object" } } },
  }, 8_192)) as Record<string, unknown>;
  assert.match(String(body.instructions), /exactly one JSON value/);
  assert.match(String(body.instructions), /top level/);
  assert.deepEqual(body.tools, []);
});

test("Qwen proxy preserves only the first function call in JSON responses", () => {
  const normalized = JSON.parse(qwenResponseBody(JSON.stringify({
    id: "resp-1",
    output: [
      { type: "reasoning", id: "reasoning-1" },
      { type: "function_call", id: "call-item-1", call_id: "call-1", name: "avo_get_state" },
      { type: "message", id: "message-after-call" },
      { type: "function_call", id: "call-item-2", call_id: "call-2", name: "avo_generate_image" },
    ],
  }))) as { output: Array<{ id: string; namespace?: string }> };
  assert.deepEqual(normalized.output.map((item) => item.id), ["reasoning-1", "call-item-1"]);
  assert.equal(normalized.output[1]?.namespace, "mcp__avo");
});

test("Qwen proxy continues a completed tool boundary with previous_response_id", () => {
  const body = JSON.parse(qwenRequestBody({
    model: "qwen3.8-flash",
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "task" }] },
      { type: "function_call", id: "call-item-1", call_id: "call-1", name: "avo_get_state", arguments: "{}" },
      { type: "function_call_output", id: "output-1", call_id: "call-1", output: "{\"ok\":true}" },
    ],
    tools: [{ type: "namespace", name: "mcp__avo", tools: [{ type: "function", name: "avo_get_state", parameters: {} }] }],
  }, 8_192, { responseId: "resp-1", callId: "call-1" })) as Record<string, unknown>;
  assert.equal(body.previous_response_id, "resp-1");
  assert.deepEqual(body.input, [
    { type: "function_call_output", call_id: "call-1", output: "{\"ok\":true}" },
  ]);
});

test("Qwen proxy creates a hard SSE boundary after the first function call", async () => {
  const event = (type: string, value: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
  const input = [
    event("response.created", { response: { id: "resp-1", output: [] } }),
    event("response.output_item.done", { output_index: 0, item: { type: "reasoning", id: "reasoning-1" } }),
    event("response.output_item.done", { output_index: 1, item: { type: "function_call", id: "call-item-1", call_id: "call-1", name: "avo_get_state" } }),
    event("response.output_item.done", { output_index: 2, item: { type: "message", id: "hallucinated-message" } }),
    event("response.output_item.done", { output_index: 3, item: { type: "function_call", id: "call-item-2", call_id: "call-2", name: "avo_generate_image" } }),
    event("response.completed", {
      response: {
        id: "resp-1",
        status: "completed",
        output: [
          { type: "reasoning", id: "reasoning-1" },
          { type: "function_call", id: "call-item-1", call_id: "call-1", name: "avo_get_state" },
          { type: "message", id: "hallucinated-message" },
          { type: "function_call", id: "call-item-2", call_id: "call-2", name: "avo_generate_image" },
        ],
      },
    }),
    "data: [DONE]\n\n",
  ].join("");
  const chunks: Buffer[] = [];
  for await (const chunk of Readable.from([input.slice(0, 173), input.slice(173)]).pipe(createQwenSingleToolCallTransform())) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const output = Buffer.concat(chunks).toString("utf8");
  assert.match(output, /call-item-1/);
  assert.match(output, /"namespace":"mcp__avo"/);
  assert.equal(output.includes("hallucinated-message"), false);
  assert.equal(output.includes("call-item-2"), false);
  assert.match(output, /data: \[DONE\]/);
  const completed = output.split("\n\n")
    .map((frame) => frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .flatMap((payload) => payload && payload !== "[DONE]" ? [JSON.parse(payload) as Record<string, unknown>] : [])
    .find((item) => item.type === "response.completed") as { response: { output: Array<{ id: string; namespace?: string }> } };
  assert.deepEqual(completed.response.output.map((item) => item.id), ["reasoning-1", "call-item-1"]);
  assert.equal(completed.response.output[1]?.namespace, "mcp__avo");
});

test("image adapter hides four 120-second-equivalent timeouts and returns only the fifth successful submission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avo-image-retry-"));
  const originalFetch = globalThis.fetch;
  try {
    const sourcePath = join(directory, "source.png");
    await writeFile(sourcePath, pixel);
    const clientTaskIds: string[] = [];
    let submissions = 0;
    let succeedOnFifth = true;
    globalThis.fetch = async (url, init) => {
      const target = String(url);
      if (target.endsWith("/api/image-tasks/edits")) {
        submissions += 1;
        const form = init?.body as FormData;
        clientTaskIds.push(String(form.get("client_task_id")));
        if (!succeedOnFifth || submissions < 5) {
          return new Response(JSON.stringify({ error: "simulated provider timeout" }), { status: 400, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ id: `provider-task-${submissions}` }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target.includes("/api/image-tasks?")) {
        const taskId = new URL(target).searchParams.get("ids");
        return new Response(JSON.stringify(succeedOnFifth && taskId === "provider-task-5"
          ? { id: taskId, status: "completed", data: [{ url: "https://images.test/result.png" }] }
          : { id: taskId, status: "running" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (target === "https://images.test/result.png") return new Response(Uint8Array.from(pixel).buffer, { status: 200, headers: { "content-type": "image/png" } });
      throw new Error(`unexpected_fetch:${target}`);
    };
    const provider = new GptImageProvider({
      ...loadConfig({
        AVO_DATA_DIR: directory,
        AVO_PROVIDER_MODE: "live",
        OPENAI_API_KEY: "test-key",
        AVO_IMAGE_BASE_URL: "https://images.test/v1",
      }),
      AVO_IMAGE_ATTEMPT_TIMEOUT_MS: 10_000,
      AVO_IMAGE_MAX_ATTEMPTS: 5,
    });
    const result = await provider.generate({
      prompt: "Test one logical generation.",
      base: { path: sourcePath, mimeType: "image/png" },
      references: [],
      idempotencyKey: "logical-generation-1",
    });
    assert.equal(submissions, 5);
    assert.equal(new Set(clientTaskIds).size, 5);
    assert.deepEqual(result.providerAttempts?.map((attempt) => attempt.status), ["timed_out", "timed_out", "timed_out", "timed_out", "succeeded"]);
    assert.equal(result.bytes.equals(pixel), true);

    submissions = 0;
    clientTaskIds.length = 0;
    succeedOnFifth = false;
    await assert.rejects(provider.generate({
      prompt: "Test one exhausted logical generation.",
      base: { path: sourcePath, mimeType: "image/png" },
      references: [],
      idempotencyKey: "logical-generation-2",
    }), (error: Error & { providerAttempts?: Array<{ status: string }> }) => {
      assert.match(error.message, /^image_provider_ambiguous:retries_exhausted:5_provider_attempts_failed$/);
      assert.equal(error.providerAttempts?.length, 5);
      assert.ok(error.providerAttempts?.every((attempt) => attempt.status === "timed_out"));
      return true;
    });
    assert.equal(submissions, 5);
    assert.equal(new Set(clientTaskIds).size, 5);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Evaluation Frame cross-field validation participates in schema repair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avo-frame-repair-"));
  const originalFetch = globalThis.fetch;
  try {
    const sourcePath = join(directory, "source.png");
    await writeFile(sourcePath, pixel);
    const validPayload = {
      axes: [{
        id: "axis-intent",
        label: "Intent",
        criterion: "Satisfy the frozen user intent.",
        mode: "optimize",
        importance: "blocker",
        visibility: "public",
        anchor_refs: ["brief:user_brief"],
        required_tools: [],
        regions: [],
      }],
      target_interpretation: { role: "none", rationale: "No target media is configured." },
      change_summary: "Initial frame.",
      coverage: [{ anchor_ref: "brief:user_brief", axis_ids: ["axis-intent"] }],
      reconsider_candidate_ids: [],
    };
    const input = {
      runId: "run-frame-repair",
      attempt: 1,
      task: {
        schema_version: 2 as const,
        id: "task-frame-repair",
        title: "Frame repair",
        user_brief: "Improve the image without damaging it.",
        source_artifact_id: `sha256:${"0".repeat(64)}`,
        references: [],
        preservation_contract: {
          color: "preserve" as const,
          detail: "preserve" as const,
          text: "unspecified" as const,
          composition: "preserve" as const,
          identity: "unspecified" as const,
          edit_scope: "unknown" as const,
          additional_invariants: [],
        },
        has_hidden_evaluation: false,
        created_at: new Date().toISOString(),
      },
      sourcePath,
      publicReferences: [],
      sealedReferences: [],
      lineage: [],
      archive: [],
      recentAttempts: [],
    };
    const verifier = new QwenResponsesVerifier(loadConfig({
      AVO_DATA_DIR: directory,
      AVO_PROVIDER_MODE: "live",
      QWEN_BASE_URL: "https://qwen.test/v1",
      QWEN_API_KEY: "test-key",
      QWEN_MODEL: "qwen3.8-flash",
    }));
    const responseFor = (payload: unknown, index: number) => new Response(JSON.stringify({
      id: `resp-frame-${index}`,
      output: [{
        type: "function_call",
        call_id: `call-frame-${index}`,
        name: "submit_evaluation_frame",
        arguments: JSON.stringify(payload),
      }],
    }), { status: 200, headers: { "content-type": "application/json" } });

    const requests: Array<Record<string, unknown>> = [];
    const repairResponses = [
      responseFor({ ...validPayload, coverage: [{ anchor_ref: "brief:user_brief", axis_ids: ["axis-missing"] }] }, 1),
      responseFor(validPayload, 2),
    ];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return repairResponses.shift()!;
    };
    const repaired = await verifier.createEvaluationFrame(input);
    assert.equal(repaired.provenance, "verifier");
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /evaluation_frame_invalid_axis_coverage/);

    const invalidCases: Array<{ payload: Record<string, unknown>; error: RegExp }> = [
      {
        payload: { ...validPayload, coverage: [{ anchor_ref: "unrelated:anchor", axis_ids: ["axis-intent"] }] },
        error: /evaluation_frame_missing_human_anchors/,
      },
      {
        payload: { ...validPayload, axes: [...validPayload.axes, { ...validPayload.axes[0] }] },
        error: /evaluation_frame_duplicate_axis_ids/,
      },
      {
        payload: { ...validPayload, reconsider_candidate_ids: ["draft-does-not-exist"] },
        error: /evaluation_frame_unknown_reconsider_candidates/,
      },
    ];
    for (const [caseIndex, invalid] of invalidCases.entries()) {
      const responses = [responseFor(invalid.payload, caseIndex * 2 + 10), responseFor(invalid.payload, caseIndex * 2 + 11)];
      globalThis.fetch = async () => responses.shift()!;
      await assert.rejects(verifier.createEvaluationFrame(input), invalid.error);
    }
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Final Verifier repairs unknown nodes while Controller owns evidence references", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avo-final-repair-"));
  const originalFetch = globalThis.fetch;
  try {
    const sourcePath = join(directory, "source.png");
    const candidatePath = join(directory, "candidate.png");
    await writeFile(sourcePath, pixel);
    await writeFile(candidatePath, pixel);
    const responses = [
      { id: "resp-final-1", output: [{ type: "function_call", call_id: "call-final-1", name: "submit_final_selection", arguments: JSON.stringify({ selected_node_id: "node-unknown", confidence: 0.8, rationale: "Unknown node." }) }] },
      { id: "resp-final-2", output: [{ type: "function_call", call_id: "call-final-2", name: "submit_final_selection", arguments: JSON.stringify({ selected_node_id: "node-commit", confidence: 0.9, rationale: "The committed candidate best matches the target." }) }] },
    ];
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
    };
    const verifier = new QwenResponsesVerifier(loadConfig({
      AVO_DATA_DIR: directory,
      AVO_PROVIDER_MODE: "live",
      QWEN_BASE_URL: "https://qwen.test/v1",
      QWEN_API_KEY: "test-key",
      QWEN_MODEL: "qwen3.8-flash",
    }));
    const createdAt = new Date().toISOString();
    const frame = {
      id: "frame-final-1",
      run_id: "run-final",
      attempt: 1,
      revision: 1,
      provenance: "verifier" as const,
      axes: [{ id: "axis-intent", label: "Intent", criterion: "Match the target.", mode: "optimize" as const, importance: "blocker" as const, visibility: "public" as const, anchor_refs: ["brief:user_brief"], required_tools: [], regions: [] }],
      target_interpretation: { role: "none" as const, rationale: "No target media." },
      change_summary: "Initial frame.",
      axis_diff: { added: ["axis-intent"], removed: [], changed: [] },
      coverage: [{ anchor_ref: "brief:user_brief", axis_ids: ["axis-intent"] }],
      reconsider_candidate_ids: [],
      model: "fixture",
      created_at: createdAt,
    };
    const result = await verifier.selectFinal({
      runId: "run-final",
      task: {
        schema_version: 2,
        id: "task-final",
        title: "Final selection",
        user_brief: "Select the image closest to the intended target.",
        source_artifact_id: `sha256:${"0".repeat(64)}`,
        references: [],
        preservation_contract: { color: "unspecified", detail: "unspecified", text: "unspecified", composition: "unspecified", identity: "unspecified", edit_scope: "unknown", additional_invariants: [] },
        has_hidden_evaluation: false,
        created_at: createdAt,
      },
      frame,
      sourcePath,
      candidates: [{
        node: { id: "node-source", run_id: "run-final", kind: "seed", artifact_id: `sha256:${"0".repeat(64)}`, ancestry_depth: 0, pareto_active: false, version: 0, committed_at: createdAt },
        path: sourcePath,
      }, {
        node: { id: "node-commit", run_id: "run-final", kind: "commit", artifact_id: `sha256:${"1".repeat(64)}`, parent_node_id: "node-source", ancestry_depth: 1, pareto_active: false, version: 1, committed_at: createdAt },
        path: candidatePath,
      }],
      publicReferences: [],
      sealedReferences: [],
    });

    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1]), /final_verifier_selected_unknown_node:\\?"node-unknown\\?";allowed=node-source,node-commit/);
    const tool = (requests[0]?.tools as Array<{ parameters: { required: string[]; properties: Record<string, unknown> } }>)[0]!;
    assert.deepEqual(tool.parameters.required, ["selected_node_id", "confidence", "rationale"]);
    assert.equal("evidence_refs" in tool.parameters.properties, false);
    assert.deepEqual(result.evidence_refs, ["frame-final-1", "node-commit"]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("Agentic Verifier repairs its schema, reverses low-confidence A/B order, and keeps confidence out of acceptance", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avo-verifier-"));
  const originalFetch = globalThis.fetch;
  try {
    const sourcePath = join(directory, "source.png");
    const candidatePath = join(directory, "candidate.png");
    await writeFile(sourcePath, pixel);
    await writeFile(candidatePath, await sharp(pixel).modulate({ brightness: 1.05 }).png().toBuffer());
    const payload = {
      correctness: "pass",
      winner: "A",
      incumbent_correctness: "pass",
      candidate_quality: { delivery_status: "acceptable", defects: [] },
      incumbent_quality: { delivery_status: "acceptable", defects: [] },
      target_progress: "improved",
      axis_judgments: [{
        axis_id: "axis-intent",
        verdict: "pass",
        candidate_score: 90,
        incumbent_score: 80,
        evidence: "The candidate is holistically closer to the fixed target frame.",
      }],
      confidence: 0.62,
      feedback_for_main_agent: ["The candidate is the better image under the complete frame."],
      private_feedback: [],
    };
    const responses = [
      { id: "resp-tool", output: [{ type: "function_call", call_id: "call-source", name: "measure_source_fidelity", arguments: "{}" }] },
      { id: "resp-initial-invalid", output: [{ type: "function_call", call_id: "call-submit-invalid", name: "submit_verifier_comparison", arguments: JSON.stringify({
        ...payload,
        axis_judgments: payload.axis_judgments.map((judgment) => ({ ...judgment, axis_id: "axis-unknown" })),
      }) }] },
      { id: "resp-initial", output: [{ type: "function_call", call_id: "call-submit-1", name: "submit_verifier_comparison", arguments: JSON.stringify(payload) }] },
      { id: "resp-reverse", output: [{ type: "function_call", call_id: "call-submit-2", name: "submit_verifier_comparison", arguments: JSON.stringify({ ...payload, winner: "B", confidence: 0.72 }) }] },
    ];
    const requests: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "content-type": "application/json" } });
    };
    const verifier = new QwenResponsesVerifier(loadConfig({
      AVO_DATA_DIR: directory,
      AVO_PROVIDER_MODE: "live",
      QWEN_BASE_URL: "https://qwen.test/v1",
      QWEN_API_KEY: "test-key",
      QWEN_MODEL: "qwen3.8-flash",
    }));
    const called: string[] = [];
    const decision = await verifier.compare({
      runId: "run-test",
      draftId: "draft-test",
      candidateArtifactId: `sha256:${"1".repeat(64)}`,
      task: {
        schema_version: 2,
        id: "task-test",
        title: "Test",
        user_brief: "Move toward the target.",
        source_artifact_id: `sha256:${"0".repeat(64)}`,
        references: [],
        preservation_contract: { color: "unspecified", detail: "unspecified", text: "unspecified", composition: "unspecified", identity: "unspecified", edit_scope: "unknown", additional_invariants: [] },
        has_hidden_evaluation: true,
        created_at: new Date().toISOString(),
      },
      frame: {
        id: "frame-test-1",
        run_id: "run-test",
        attempt: 1,
        revision: 1,
        provenance: "verifier",
        axes: [{ id: "axis-intent", label: "Intent", criterion: "Match target", mode: "match_target", importance: "blocker", visibility: "sealed", anchor_refs: ["brief:user_brief", "media:hidden_target"], required_tools: ["measure_target_alignment"], regions: [] }],
        target_interpretation: { role: "strong_target", rationale: "The target is a strong direction." },
        change_summary: "Initial frame.",
        axis_diff: { added: ["axis-intent"], removed: [], changed: [] },
        coverage: [{ anchor_ref: "brief:user_brief", axis_ids: ["axis-intent"] }, { anchor_ref: "media:hidden_target", axis_ids: ["axis-intent"] }],
        reconsider_candidate_ids: [],
        model: "fixture",
        created_at: new Date().toISOString(),
      },
      sourcePath,
      parentPath: sourcePath,
      incumbentNode: { id: "node-source", run_id: "run-test", kind: "seed", artifact_id: `sha256:${"0".repeat(64)}`, ancestry_depth: 0, pareto_active: false, version: 0, committed_at: new Date().toISOString() },
      incumbentPath: sourcePath,
      candidatePath,
      publicReferences: [],
      sealedReferences: [],
      hiddenTargetPath: candidatePath,
      history: [],
      technicalGate: { passed: true, blockers: [], warnings: [] },
      callTool: async (tool) => {
        called.push(tool);
        return { id: `evidence-${tool}`, tool, summary: `${tool} result`, data: { ok: true } };
      },
    });
    assert.equal(decision.preference, "better");
    assert.equal(decision.confidence, 0.72);
    assert.equal(decision.recommendation, "commit");
    assert.deepEqual(new Set(called), new Set(["measure_integrity", "measure_artifacts", "measure_target_alignment", "measure_source_fidelity"]));
    assert.equal(requests.length, 4);
    assert.equal(requests[1]?.previous_response_id, "resp-tool");
    assert.equal(requests[2]?.previous_response_id, "resp-initial-invalid");
    assert.match(JSON.stringify(requests[2]?.input), /comparison_unknown_axis_ids:axis-unknown/);
    assert.equal(requests[0]?.parallel_tool_calls, false);
    assert.equal(requests[0]?.store, true);
    const submitTool = (requests[0]?.tools as Array<{ name: string; parameters: { required: string[]; properties: Record<string, unknown> } }>)
      .find((tool) => tool.name === "submit_verifier_comparison")!;
    assert.equal(submitTool.parameters.required.includes("recommendation"), false);
    assert.equal(submitTool.parameters.required.includes("evidence_refs"), false);
    assert.equal("recommendation" in submitTool.parameters.properties, false);
    assert.equal("evidence_refs" in submitTool.parameters.properties, false);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  }
});

test("sealed evaluator inputs are consumed once and never appear in public task payloads", async () => {
  const context = await fixture();
  try {
    const staged = await context.sealed.stageUpload({ bytes: pixel, mimeType: "image/png", originalName: "hidden-target.png" });
    const response = await context.app.inject({
      method: "POST",
      url: "/api/tasks",
      payload: {
        title: "Sealed task",
        user_brief: "Match the private evaluator target without exposing it to the agent.",
        source_artifact_id: context.source.id,
        references: [],
        hidden_target_token: staged.upload_token,
        private_rubric: "Private target alignment is important.",
      },
    });
    assert.equal(response.statusCode, 201, response.body);
    const task = response.json().task as { id: string; has_hidden_evaluation: boolean };
    assert.equal(task.has_hidden_evaluation, true);
    assert.equal(response.body.includes(staged.upload_token), false);
    assert.equal(response.body.includes("hidden-target.png"), false);
    assert.equal(response.body.includes("Private target alignment"), false);

    const publicTask = await context.app.inject({ method: "GET", url: `/api/tasks/${task.id}` });
    assert.equal(publicTask.body.includes("hidden-target.png"), false);
    const evaluator = await context.app.inject({ method: "GET", url: `/api/tasks/${task.id}/evaluator-inputs` });
    assert.equal(evaluator.statusCode, 200);
    assert.equal(evaluator.json().evaluator_inputs.has_hidden_target, true);
    const hiddenImage = await context.app.inject({ method: "GET", url: `/api/tasks/${task.id}/evaluator-assets/target` });
    assert.equal(hiddenImage.statusCode, 200);
    assert.deepEqual(hiddenImage.rawPayload, pixel);

    const createdRun = await context.app.inject({
      method: "POST",
      url: "/api/runs",
      payload: { task_id: task.id, config: { mode: "one_shot", max_generations: 1 } },
    });
    const runId = createdRun.json().run.id as string;
    const run = await waitFor(() => context.store.getRun(runId), (value) => value.status === "completed");
    assert.equal(run.verifier_count, 1);
    assert.equal(run.comparative_decisions[0]?.recommendation, "commit");
    assert.equal(run.evaluation_frame_revisions[0]?.target_interpretation.role, "strong_target");
    const agentTools = {
      getRunSnapshot() { return run; },
      async recordAgentRuntime() {},
      getEvaluation() { return run.evaluations[0]!; },
      signalBudgetExceeded() {},
    } as unknown as AgentToolbox;
    const broker = new AgentToolBroker();
    const unregister = broker.register("sealed-feedback", agentTools, {} as AgentRoundContext);
    try {
      const visible = await broker.invoke("sealed-feedback", "avo_get_evaluation", {
        evaluation_id: run.evaluations[0]!.id,
      }) as Record<string, unknown>;
      assert.equal("source_quality_debt" in visible, false);
      assert.equal("axis_judgments" in visible, false);
      assert.equal((visible.comparison as { preference: string }).preference, "better");
      assert.deepEqual(visible.verifier_feedback, run.evaluations[0]!.agent_feedback);
      const cached = await broker.invoke("sealed-feedback", "avo_get_evaluation", {
        evaluation_id: run.evaluations[0]!.id,
      }) as Record<string, unknown>;
      assert.equal(cached.cache_hit, true);
      assert.equal("source_quality_debt" in cached, false);
    } finally {
      unregister();
    }
    const publicRun = JSON.stringify(run);
    assert.equal(publicRun.includes("hidden-target.png"), false);
    assert.equal(publicRun.includes("Private target alignment"), false);
    const events = await context.app.inject({ method: "GET", url: `/api/runs/${runId}/event-log` });
    assert.equal(events.body.includes("hidden-target.png"), false);
    assert.equal(events.body.includes("Private target alignment"), false);
    assert.equal(events.body.includes("hidden_verification"), false);
    assert.equal(events.body.includes("evaluation_frame_revisions"), false);
    assert.equal(events.body.includes("private_feedback"), false);
    const runResponse = await context.app.inject({ method: "GET", url: `/api/runs/${runId}` });
    assert.equal(runResponse.body.includes("hidden_verification"), false);
    assert.equal(runResponse.body.includes("measure_target_alignment"), false);
    const evaluatorResults = await context.app.inject({ method: "GET", url: `/api/runs/${runId}/evaluator-results` });
    assert.equal(evaluatorResults.statusCode, 200);
    assert.equal(evaluatorResults.json().evaluation_frames[0].target_interpretation.role, "strong_target");
    assert.equal(evaluatorResults.json().comparative_decisions[0].preference, "better");
    assert.ok(evaluatorResults.json().comparative_decisions[0].evidence.length >= 3);
  } finally {
    await context.app.close();
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("deleting a failed run removes unreferenced raw and effective draft blobs", async () => {
  const context = await fixture();
  try {
    const task = await createTask(context);
    const run = await context.runner.createRun(task.id, { mode: "avo" });
    const raw = await context.runner.artifacts.put({
      bytes: Buffer.concat([pixel, Buffer.from("raw-draft")]),
      mimeType: "image/png",
      originalName: "raw.png",
    });
    const effective = await context.runner.artifacts.put({
      bytes: Buffer.concat([pixel, Buffer.from("effective-draft")]),
      mimeType: "image/png",
      originalName: "effective.png",
    });
    await context.store.commitRun(run.id, "draft.generated", {}, (current) => ({
      ...current!,
      status: "failed",
      terminal_reason: "fixture_failed",
      drafts: [{
        id: "draft-delete-fixture",
        round: 1,
        status: "generated",
        raw_artifact_id: raw.id,
        artifact_id: effective.id,
        parent_artifact_id: context.source.id,
        prompt: "Fixture prompt",
        generation_input: { base_artifact_id: context.source.id, reference_artifact_ids: [] },
        dimensions: {
          source: { width: 1, height: 1 },
          provider: { width: 1, height: 1 },
          final: { width: 1, height: 1 },
          normalized: false,
        },
        latency_ms: 1,
        created_at: new Date().toISOString(),
      }],
      updated_at: new Date().toISOString(),
    }));
    const response = await context.app.inject({ method: "DELETE", url: `/api/runs/${run.id}` });
    assert.equal(response.statusCode, 204, response.body);
    assert.equal(await context.runner.artifacts.exists(raw.id), false);
    assert.equal(await context.runner.artifacts.exists(effective.id), false);
    assert.equal(await context.runner.artifacts.exists(context.source.id), true);
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
      models: Array<{ slug: string; supports_parallel_tool_calls: boolean; context_window: number; max_output_tokens: number }>;
    };
    assert.equal(prepared.codexRevision, "codex-cli 9.9.9");
    assert.deepEqual(new Set(catalog.models.map((model) => model.slug)), new Set(["qwen3.8-flash", "qwen3.8-max"]));
    assert.equal(catalog.models[0]?.slug, "qwen3.8-flash");
    assert.deepEqual((catalog.models[0] as { input_modalities?: string[] }).input_modalities, ["text", "image"]);
    assert.equal(catalog.models[0]?.supports_parallel_tool_calls, false);
    assert.equal(catalog.models[0]?.context_window, 1_000_000);
    assert.equal(catalog.models[0]?.max_output_tokens, 8_192);
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

test("Codex Harness rejects any MCP inventory beyond the AVO allowlist", () => {
  assert.deepEqual(validateAvoMcpInventory({
    data: [{ name: "avo", tools: Object.fromEntries(AVO_MCP_TOOL_ALLOWLIST.map((name) => [name, {}])) }],
  }), [...AVO_MCP_TOOL_ALLOWLIST].sort());
  assert.throws(() => validateAvoMcpInventory({
    data: [
      { name: "avo", tools: Object.fromEntries(AVO_MCP_TOOL_ALLOWLIST.map((name) => [name, {}])) },
      { name: "global-js", tools: { js: {} } },
    ],
  }), /codex_mcp_inventory_violation/);
});

test("relative data paths resolve from the AVO workspace root", () => {
  const config = loadConfig({ AVO_DATA_DIR: "./data", AVO_PROVIDER_MODE: "fake" });
  const root = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
  assert.equal(config.AVO_ROOT, root);
  assert.equal(config.AVO_DATA_DIR, join(root, "data"));
});
