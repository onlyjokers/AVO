import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  agentSummarySchema,
  generationInputSchema,
  supervisorRedirectSchema,
  type AgentSummary,
  type GenerationInput,
} from "@avo/contracts";
import type { AgentProvider, AgentRoundContext, AgentToolbox, BestOfVariant, FileStateStore } from "@avo/core";
import type { AppConfig } from "./config.ts";
import { AgentToolBroker } from "./tool-broker.ts";

type RpcId = number | string;
type RpcMessage = { id?: RpcId; method?: string; result?: unknown; error?: { message?: string }; params?: Record<string, unknown> };

class AppServerClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private requestId = 0;
  private stderrTail = "";
  private readonly eventTail: string[] = [];

  constructor(config: AppConfig, token: string) {
    const providerArgs = config.AVO_CODEX_PROVIDER_BASE_URL && config.AVO_CODEX_PROVIDER_API_KEY
      ? [
          "-c", `model_provider=${JSON.stringify("avo_qwen")}`,
          "-c", `model_providers.avo_qwen.name=${JSON.stringify("AVO Qwen Responses")}`,
          "-c", `model_providers.avo_qwen.base_url=${JSON.stringify(config.AVO_CODEX_PROVIDER_BASE_URL)}`,
          "-c", `model_providers.avo_qwen.env_key=${JSON.stringify("AVO_CODEX_PROVIDER_API_KEY")}`,
          "-c", `model_providers.avo_qwen.wire_api=${JSON.stringify("responses")}`,
          "-c", "model_providers.avo_qwen.requires_openai_auth=false",
          "-c", "model_providers.avo_qwen.supports_websockets=false",
          "-c", "model_providers.avo_qwen.request_max_retries=3",
          "-c", "model_providers.avo_qwen.stream_max_retries=3",
        ]
      : [];
    const args = [
      "app-server",
      "--stdio",
      ...providerArgs,
      "--disable", "skill_search",
      "--disable", "skill_mcp_dependency_install",
      "--disable", "shell_tool",
      "--disable", "unified_exec",
      "--disable", "browser_use",
      "--disable", "apps",
      "--disable", "plugins",
      "--disable", "memories",
      "--disable", "multi_agent",
      "--disable", "image_generation",
      "--disable", "hooks",
      ...(config.AVO_CODEX_MODEL_CATALOG
        ? ["-c", `model_catalog_json=${JSON.stringify(config.AVO_CODEX_MODEL_CATALOG)}`]
        : []),
      "-c", `mcp_servers.avo.command=${JSON.stringify(join(config.AVO_ROOT, "node_modules", ".bin", "tsx"))}`,
      "-c", `mcp_servers.avo.args=${JSON.stringify([join(config.AVO_ROOT, "apps", "api", "src", "mcp-server.ts")])}`,
      "-c", `mcp_servers.avo.env.AVO_INTERNAL_API=${JSON.stringify(`http://${config.AVO_HOST}:${config.AVO_API_PORT}`)}`,
      "-c", `mcp_servers.avo.env.AVO_TOOL_TOKEN=${JSON.stringify(token)}`,
      "-c", "mcp_servers.avo.required=true",
    ];
    this.process = spawn(config.AVO_CODEX_BIN, args, {
      cwd: config.AVO_ROOT,
      env: safeCodexEnv({
        AVO_INTERNAL_API: `http://${config.AVO_HOST}:${config.AVO_API_PORT}`,
        AVO_TOOL_TOKEN: token,
        ...(config.AVO_CODEX_PROVIDER_API_KEY
          ? { AVO_CODEX_PROVIDER_API_KEY: config.AVO_CODEX_PROVIDER_API_KEY }
          : {}),
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.process.stdout });
    this.process.stderr.on("data", (chunk) => {
      const text = String(chunk);
      this.stderrTail = `${this.stderrTail}${text}`.slice(-4_000);
      if (/failed to renew cache TTL|missing field `supports_parallel_tool_calls`|failed to install system skills|authentication|unauthorized/i.test(text)) {
        const message: RpcMessage = { method: "_app/fatal", params: { message: text.slice(-1_000) } };
        for (const listener of this.listeners) listener(message);
      }
    });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line) as RpcMessage; } catch { return; }
      this.eventTail.push(rpcDiagnostic(message));
      if (this.eventTail.length > 40) this.eventTail.shift();
      if (message.id !== undefined && message.method) {
        this.respondToServerRequest(message);
      }
      if (typeof message.id === "number" && ("result" in message || "error" in message)) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(message.error.message ?? "app_server_request_failed"));
          else pending.resolve(message.result);
        }
      }
      for (const listener of this.listeners) listener(message);
    });
    this.process.on("exit", (code) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`codex_app_server_exited_${code ?? "unknown"}`));
      this.pending.clear();
    });
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "avo-image-editing", title: "AVO Image Editing", version: "0.1.0" } });
    this.notify("initialized", {});
  }

  request(method: string, params: Record<string, unknown>) {
    const id = ++this.requestId;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(`${JSON.stringify({ method, id, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown>) {
    this.process.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private respondToServerRequest(message: RpcMessage) {
    const result = message.method === "mcpServer/elicitation/request"
      ? resolveAvoMcpElicitation(message.params ?? {})
      : undefined;
    const response = result
      ? { id: message.id, result }
      : { id: message.id, error: { code: -32601, message: "Client request method not supported" } };
    this.process.stdin.write(`${JSON.stringify(response)}\n`);
  }

  waitFor(method: string, predicate: (params: Record<string, unknown>) => boolean, timeoutMs = 20 * 60_000) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`codex_event_timeout:${method}`)); }, timeoutMs);
      const listener = (message: RpcMessage) => {
        if (message.method === "_app/fatal") {
          cleanup();
          reject(new Error(`codex_app_server_fatal:${String(message.params?.message ?? "unknown")}`));
          return;
        }
        if (message.method === method && message.params && predicate(message.params)) {
          cleanup();
          resolve(message.params);
        }
      };
      const cleanup = () => { clearTimeout(timeout); this.listeners.delete(listener); };
      this.listeners.add(listener);
    });
  }

  onMessage(listener: (message: RpcMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  diagnostics() {
    const stderr = this.stderrTail.replace(/sk-[a-zA-Z0-9_.-]+/g, "[REDACTED]");
    return [stderr, this.eventTail.join(" | ")].filter(Boolean).join("\n");
  }
  close() { this.process.kill("SIGTERM"); }
}

const rpcDiagnostic = (message: RpcMessage) => {
  const turn = message.params?.turn as Record<string, unknown> | undefined;
  const error = message.params?.error as Record<string, unknown> | undefined;
  const parts = [message.method ?? (typeof message.id === "number" ? `response:${message.id}` : "unknown")];
  if (typeof turn?.status === "string") parts.push(`turn=${turn.status}`);
  if (typeof error?.code === "string") parts.push(`code=${error.code}`);
  if (typeof message.error?.message === "string") parts.push(`rpc_error=${message.error.message.slice(0, 160)}`);
  if (message.method === "mcpServer/elicitation/request") {
    const request = asRecord(message.params?.request) ?? message.params;
    parts.push(`server=${String(message.params?.serverName ?? "unknown")}`);
    parts.push(`mode=${String(request?.mode ?? "form")}`);
    const properties = asRecord(asRecord(request?.requestedSchema)?.properties);
    if (properties) parts.push(`fields=${Object.keys(properties).sort().join(",")}`);
  }
  return parts.join(":");
};

type ElicitationResponse =
  | { action: "accept"; content: Record<string, unknown> }
  | { action: "decline"; content: null };

export const resolveAvoMcpElicitation = (params: Record<string, unknown>): ElicitationResponse => {
  if (params.serverName !== "avo") return { action: "decline", content: null };
  const request = asRecord(params.request) ?? params;
  const mode = typeof request.mode === "string" ? request.mode : "form";
  if (mode !== "form" && mode !== "openai/form") return { action: "decline", content: null };
  const schema = asRecord(request.requestedSchema);
  return { action: "accept", content: schema ? elicitationObject(schema) : {} };
};

const elicitationObject = (schema: Record<string, unknown>) => {
  const properties = asRecord(schema.properties) ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((item): item is string => typeof item === "string") : []);
  return Object.fromEntries(Object.entries(properties).flatMap(([key, value]) => {
    if (!required.has(key)) return [];
    return [[key, elicitationValue(asRecord(value) ?? {})]];
  }));
};

const elicitationValue = (schema: Record<string, unknown>): unknown => {
  if ("const" in schema) return schema.const;
  if ("default" in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.find((value) => typeof value === "string" && /^(accept|approve|allow|yes)$/i.test(value)) ?? schema.enum[0];
  }
  if (schema.type === "boolean") return true;
  if (schema.type === "number" || schema.type === "integer") return typeof schema.minimum === "number" ? schema.minimum : 0;
  if (schema.type === "array") return [];
  if (schema.type === "object") return elicitationObject(schema);
  return "accept";
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export class CodexAppServerAgentProvider implements AgentProvider {
  readonly id = "codex-app-server";

  constructor(
    private readonly config: AppConfig,
    private readonly broker: AgentToolBroker,
    private readonly store?: FileStateStore,
  ) {}

  async probe() {
    if (!this.config.AVO_CODEX_PROVIDER_BASE_URL || !this.config.AVO_CODEX_PROVIDER_API_KEY) {
      return { ok: false, message: "Main Agent Qwen Provider 未配置" };
    }
    const token = randomBytes(24).toString("hex");
    const client = new AppServerClient(this.config, token);
    try {
      await client.initialize();
      const result = await client.request("model/list", { limit: 100, includeHidden: true }) as { data?: Array<{ id?: string; inputModalities?: string[] }> };
      const model = result.data?.find((item) => item.id === this.config.AVO_CODEX_MODEL);
      if (!model) return { ok: false, message: `Codex 中没有 ${this.config.AVO_CODEX_MODEL}` };
      if (model.inputModalities && !model.inputModalities.includes("image")) return { ok: false, message: "Codex 模型不支持图片输入" };
      const thread = await client.request("thread/start", {
        model: this.config.AVO_CODEX_MODEL,
        cwd: this.config.AVO_ROOT,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: "Reply briefly. Do not use tools or edit files.",
      }) as { thread: { id: string } };
      const completed = client.waitFor("turn/completed", () => true, Math.min(this.config.AVO_CODEX_TURN_TIMEOUT_MS, 60_000));
      await client.request("turn/start", {
        threadId: thread.thread.id,
        effort: "low",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        input: [{ type: "text", text: "Reply with OK." }],
      });
      const event = await completed;
      if ((event.turn as { status?: string } | undefined)?.status !== "completed") return { ok: false, message: "Codex capability turn 未完成" };
      return { ok: true, message: `${this.config.AVO_CODEX_MODEL}、图片能力与 app-server turn 可用` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    } finally {
      client.close();
    }
  }

  async runRound(context: AgentRoundContext, tools: AgentToolbox) {
    const token = randomBytes(32).toString("hex");
    const unregister = this.broker.register(token, tools, context);
    const client = new AppServerClient(this.config, token);
    try {
      await client.initialize();
      await this.prepareHarness(context);
      const thread = await client.request("thread/start", {
        model: this.config.AVO_CODEX_MODEL,
        cwd: join(this.config.AVO_DATA_DIR, "runs", context.run.id, "harness"),
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: mainAgentInstructions,
      }) as { thread: { id: string } };
      let policyViolation: string | undefined;
      let eventWrites = Promise.resolve();
      const off = client.onMessage((message) => {
        const item = message.params?.item as Record<string, unknown> | undefined;
        if (message.method === "item/completed" && (item?.type === "commandExecution" || item?.type === "fileChange")) {
          policyViolation = `codex_forbidden_${String(item.type)}`;
        }
        const event = publicAgentEvent(message);
        if (event && this.store) {
          eventWrites = eventWrites.then(async () => {
            await this.store!.commitRun(context.run.id, event.type, event.data, (current) => {
              if (!current) throw new Error("run_not_found");
              return { ...current, updated_at: new Date().toISOString() };
            });
          });
        }
      });
      const completed = client.waitFor(
        "turn/completed",
        (params) => (params.turn as { id?: string } | undefined)?.id !== undefined,
        this.config.AVO_CODEX_TURN_TIMEOUT_MS,
      );
      await client.request("turn/start", {
        threadId: thread.thread.id,
        effort: this.config.AVO_CODEX_EFFORT,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        input: [
          { type: "text", text: roundPrompt(context) },
          ...context.imagePool.filter((image) => image.kind !== "candidate" || image.artifactId === context.run.attempts.find((item) => item.id === context.run.best_failed_attempt_id)?.generated_artifact_id)
            .map((image) => ({ type: "localImage", path: image.path, detail: "high" })),
        ],
      });
      const event = await completed;
      off();
      await eventWrites;
      const status = (event.turn as { status?: string } | undefined)?.status;
      if (status !== "completed") throw new Error(`codex_turn_${status ?? "failed"}`);
      if (policyViolation) throw new Error(policyViolation);
    } catch (error) {
      const diagnostics = client.diagnostics();
      throw new Error(`${(error as Error).message}${diagnostics ? `:${diagnostics.slice(-800)}` : ""}`);
    } finally {
      unregister();
      client.close();
    }
  }

  async planBestOf(context: AgentRoundContext, count: number): Promise<BestOfVariant[]> {
    const result = await this.runStructured(context, [
      `为同一个图片编辑任务一次性规划 ${count} 个相互独立的方案。`,
      "在输出全部方案前不会看到任何生成结果或 verifier feedback。",
      "每个方案必须使用允许池中的 artifact ID，base 通常为原图。",
      JSON.stringify({ task: context.task, checklist: context.checklist, image_pool: context.imagePool.map(({ path: _path, ...item }) => item) }),
    ].join("\n\n"), bestOfSchema(count));
    const parsed = result as { variants?: unknown[] };
    if (!Array.isArray(parsed.variants)) throw new Error("codex_best_of_invalid_output");
    return parsed.variants.map((variant) => {
      const item = variant as Record<string, unknown>;
      return {
        prompt: String(item.prompt),
        input: generationInputSchema.parse(item.input),
        summary: agentSummarySchema.parse(item.summary),
      };
    });
  }

  async supervise(context: AgentRoundContext) {
    const result = await this.runStructured(context, [
      "你是只读 AVO Supervisor。分析最近失败，给下一轮一次性重定向；不能修改 prompt、调用生成或提交 candidate。",
      JSON.stringify({ task: context.task, checklist: context.checklist, attempts: context.recentAttempts, memory: context.run.working_memory }),
    ].join("\n\n"), supervisorSchema);
    return supervisorRedirectSchema.parse(result);
  }

  private async runStructured(context: AgentRoundContext, prompt: string, outputSchema: Record<string, unknown>) {
    const token = randomBytes(32).toString("hex");
    const client = new AppServerClient(this.config, token);
    try {
      await client.initialize();
      await this.prepareHarness(context);
      const thread = await client.request("thread/start", {
        model: this.config.AVO_CODEX_MODEL,
        cwd: join(this.config.AVO_DATA_DIR, "runs", context.run.id, "harness"),
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: "Return only the requested structured result. Do not modify files or call model providers.",
      }) as { thread: { id: string } };
      let finalText = "";
      const off = client.onMessage((message) => {
        if (message.method !== "item/completed") return;
        const item = message.params?.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && item.text) finalText = item.text;
      });
      const completed = client.waitFor("turn/completed", () => true, this.config.AVO_CODEX_TURN_TIMEOUT_MS);
      await client.request("turn/start", {
        threadId: thread.thread.id,
        effort: this.config.AVO_CODEX_EFFORT,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema,
        input: [{ type: "text", text: prompt }],
      });
      await completed;
      off();
      return JSON.parse(finalText) as unknown;
    } finally {
      client.close();
    }
  }

  private async prepareHarness(context: AgentRoundContext) {
    const directory = join(this.config.AVO_DATA_DIR, "runs", context.run.id, "harness");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "AGENTS.md"), `${mainAgentInstructions}\n`);
  }
}

const safeCodexEnv = (extra: Record<string, string>) => {
  const keys = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"];
  return Object.fromEntries([
    ...keys.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []),
    ...Object.entries(extra),
  ]);
};

const publicAgentEvent = (message: RpcMessage): { type: string; data: Record<string, unknown> } | undefined => {
  if (message.method === "turn/started") return { type: "agent.turn_started", data: {} };
  if (message.method === "thread/tokenUsage/updated") {
    return { type: "agent.usage_updated", data: { usage: message.params?.tokenUsage ?? message.params ?? {} } };
  }
  if (message.method !== "item/completed") return undefined;
  const item = message.params?.item as Record<string, unknown> | undefined;
  if (!item) return undefined;
  if (item.type === "agentMessage") return { type: "agent.message", data: { text: String(item.text ?? "") } };
  if (item.type === "reasoning") return { type: "agent.reasoning_summary", data: { summary: item.summary ?? [] } };
  if (item.type === "mcpToolCall") {
    return { type: "agent.tool_completed", data: { tool: item.tool ?? item.name ?? "unknown", status: item.status ?? "unknown" } };
  }
  if (item.type === "commandExecution" || item.type === "fileChange") {
    return { type: "agent.policy_violation", data: { item_type: item.type } };
  }
  return undefined;
};

const mainAgentInstructions = `You are the AVO image-editing variation operator. You are not the verifier and must never claim PASS.
Use only avo_* MCP tools to change candidate state. Do not edit files or call external services directly.
Inspect the task, current state, and relevant images. Form an Observation, Hypothesis, and focused Intervention.
You may spend at most two image generations in this round. Submit exactly one generated artifact with avo_submit_candidate.
Each avo_generate_image invocation consumes the round request allowance even when the Provider fails. Do not retry after a deterministic Provider error or round_generation_budget_exhausted.
If no generated artifact exists after a Provider failure, do not submit the source or any reference as a candidate. End the turn with a brief failure report so the controller can fail closed.
The original source must remain visible as the preservation reference. Use only artifact IDs returned by avo_list_image_pool.
Do not call any verifier, invent a verdict, or commit lineage. The controller owns verification and commit.`;

const roundPrompt = (context: AgentRoundContext) => [
  "执行一轮 AVO candidate search。先读取任务和状态，检查图像，再形成假设并生成。",
  `任务：${context.task.request}`,
  `冻结需求：${JSON.stringify(context.checklist.requirements)}`,
  `当前 working memory：${JSON.stringify(context.run.working_memory)}`,
  context.supervisorRedirect ? `Supervisor 一次性建议：${JSON.stringify(context.supervisorRedirect)}` : "本轮没有 Supervisor 建议。",
  "最终必须调用 avo_submit_candidate；不要在文本中宣告成功。",
].join("\n\n");

const bestOfSchema = (count: number) => ({
  type: "object",
  additionalProperties: false,
  required: ["variants"],
  properties: {
    variants: {
      type: "array",
      minItems: count,
      maxItems: count,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["prompt", "input", "summary"],
        properties: {
          prompt: { type: "string", minLength: 1 },
          input: {
            type: "object",
            additionalProperties: false,
            required: ["base_artifact_id", "reference_artifact_ids"],
            properties: { base_artifact_id: { type: "string" }, reference_artifact_ids: { type: "array", items: { type: "string" } } },
          },
          summary: {
            type: "object",
            additionalProperties: false,
            required: ["observation", "hypothesis", "intervention"],
            properties: { observation: { type: "string" }, hypothesis: { type: "string" }, intervention: { type: "string" } },
          },
        },
      },
    },
  },
});

const supervisorSchema = {
  type: "object",
  additionalProperties: false,
  required: ["diagnosis", "avoid", "try"],
  properties: {
    diagnosis: { type: "string", minLength: 1 },
    avoid: { type: "array", items: { type: "string" }, maxItems: 10 },
    try: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
  },
};
