import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  agentSummarySchema,
  supervisorDecisionSchema,
  generationInputSchema,
  type AgentSummary,
  type GenerationInput,
  type StepDeadline,
  type ExperimentalFeatures,
} from "@avo/contracts";
import type { AgentProvider, AgentRoundContext, AgentToolbox, BestOfVariant, FileStateStore } from "@avo/core";
import { trialEvidence } from "@avo/core";
import { toolFailureDiagnostic } from "./tool-failure.ts";
import { toolWaitTimeoutMs, type AppConfig } from "./config.ts";
import { AgentToolBroker } from "./tool-broker.ts";
import { ReviewContext } from "./review-context.ts";
import { allowedAvoTools, svgAgentInstructions, photoAgentInstructions } from "./experimental-tools.ts";
import { experimentPrompt } from "./experiment-runtime.ts";

type RpcId = number | string;
type RpcMessage = { id?: RpcId; method?: string; result?: unknown; error?: { message?: string }; params?: Record<string, unknown> };

class AppServerClient {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly codexHome: string;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private requestId = 0;
  private stderrTail = "";
  private readonly eventTail: string[] = [];
  private readonly recentNotifications: RpcMessage[] = [];

  constructor(
    config: AppConfig,
    token: string,
    providerProxyToken: string,
    includeAvoMcp = true,
    codexHome = join(config.AVO_DATA_DIR, "codex-harness", token),
    private readonly removeHomeOnClose = true,
    features?: ExperimentalFeatures,
  ) {
    if (config.AVO_MAIN_PROVIDER === "qwen" && config.QWEN_BILLING_MODE === "token_plan"
      && !config.AVO_CODEX_PROVIDER_API_KEY) throw new Error("token_plan_api_key_not_configured");
    this.codexHome = codexHome;
    mkdirSync(this.codexHome, { recursive: true, mode: 0o700 });
    const providerArgs = config.AVO_CODEX_PROVIDER_BASE_URL && config.AVO_CODEX_PROVIDER_API_KEY
      ? [
          "-c", `model_provider=${JSON.stringify("avo_qwen")}`,
          "-c", `model_providers.avo_qwen.name=${JSON.stringify("AVO Qwen Responses")}`,
          "-c", `model_providers.avo_qwen.base_url=${JSON.stringify(config.AVO_MAIN_PROVIDER === "78code" ? config.AVO_CODEX_PROVIDER_BASE_URL : `http://${config.AVO_HOST}:${config.AVO_API_PORT}/internal/codex-provider/v1`)}`,
          "-c", `model_providers.avo_qwen.env_key=${JSON.stringify(config.AVO_MAIN_PROVIDER === "78code" ? "AVO_NATIVE_PROVIDER_KEY" : "AVO_CODEX_PROXY_TOKEN")}`,
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
      ...(config.AVO_MAIN_PROVIDER === "78code" ? ["-c", "disable_response_storage=true"] : []),
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
      ...(includeAvoMcp ? [
        "-c", `mcp_servers.avo.command=${JSON.stringify(join(config.AVO_ROOT, "node_modules", ".bin", "tsx"))}`,
        "-c", `mcp_servers.avo.args=${JSON.stringify([join(config.AVO_ROOT, "apps", "api", "src", "mcp-server.ts")])}`,
        "-c", `mcp_servers.avo.env.AVO_INTERNAL_API=${JSON.stringify(`http://${config.AVO_HOST}:${config.AVO_API_PORT}`)}`,
        "-c", `mcp_servers.avo.env.AVO_TOOL_TOKEN=${JSON.stringify(token)}`,
        "-c", `mcp_servers.avo.env.AVO_TOOL_OUTPUT_MAX_CHARS=${JSON.stringify(String(config.AVO_AGENT_TOOL_OUTPUT_MAX_CHARS))}`,
        "-c", `mcp_servers.avo.env.AVO_TOOL_WAIT_TIMEOUT_MS=${JSON.stringify(String(toolWaitTimeoutMs(config)))}`,
        ...(features ? ["-c", `mcp_servers.avo.env.AVO_EXPERIMENTAL_FEATURES=${JSON.stringify(JSON.stringify(features))}`] : []),
        "-c", `mcp_servers.avo.tool_timeout_sec=${Math.ceil(toolWaitTimeoutMs(config) / 1000) + 30}`,
        ...allowedAvoTools(AVO_MCP_TOOL_ALLOWLIST, features).flatMap((tool) => ["-c", `mcp_servers.avo.tools.${tool}.approval_mode="approve"`]),
        "-c", "mcp_servers.avo.required=true",
      ] : []),
    ];
    this.process = spawn(config.AVO_CODEX_BIN, args, {
      cwd: config.AVO_ROOT,
      env: safeCodexEnv({
        CODEX_HOME: this.codexHome,
        AVO_INTERNAL_API: `http://${config.AVO_HOST}:${config.AVO_API_PORT}`,
        AVO_TOOL_TOKEN: token,
        AVO_CODEX_PROXY_TOKEN: providerProxyToken,
        ...(config.AVO_MAIN_PROVIDER === "78code" ? { AVO_NATIVE_PROVIDER_KEY: config.AVO_CODEX_PROVIDER_API_KEY! } : {}),
        ...(config.AVO_MAIN_PROVIDER === "78code" && config.AVO_78CODE_PROXY_URL
          ? { HTTPS_PROXY: config.AVO_78CODE_PROXY_URL, HTTP_PROXY: config.AVO_78CODE_PROXY_URL, NO_PROXY: "127.0.0.1,localhost" } : {}),
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
      if (message.method && message.params) {
        this.recentNotifications.push(message);
        if (this.recentNotifications.length > 100) this.recentNotifications.shift();
      }
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
      const message: RpcMessage = { method: "_app/fatal", params: { message: `codex_app_server_exited_${code ?? "unknown"}` } };
      for (const listener of this.listeners) listener(message);
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

  waitFor(
    method: string,
    predicate: (params: Record<string, unknown>) => boolean,
    timeoutMs = 20 * 60_000,
    includeBuffered = true,
  ) {
    const buffered = includeBuffered
      ? this.recentNotifications.findLast((message) => message.method === method && message.params && predicate(message.params))
      : undefined;
    if (buffered?.params) return Promise.resolve(buffered.params);
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
  close() {
    const cleanup = () => {
      if (this.removeHomeOnClose) void rm(this.codexHome, { recursive: true, force: true });
    };
    if (this.process.exitCode !== null || this.process.signalCode !== null) cleanup();
    else this.process.once("exit", cleanup);
    this.process.kill("SIGTERM");
  }
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

const readTotalTokens = (value: unknown) => {
  const usage = asRecord(value);
  const total = asRecord(usage?.total);
  const candidate = total?.totalTokens ?? usage?.totalTokens ?? usage?.total_tokens;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
};

const readLastTokens = (value: unknown) => {
  const usage = asRecord(value);
  const last = asRecord(usage?.last);
  const candidate = last?.totalTokens ?? last?.total_tokens;
  return typeof candidate === "number" && Number.isFinite(candidate) ? candidate : undefined;
};

const readModelContextWindow = (value: unknown) => {
  const usage = asRecord(value);
  const candidate = usage?.modelContextWindow ?? usage?.model_context_window;
  return typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
};

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

export const AVO_MCP_TOOL_ALLOWLIST = [
  "avo_set_edit_plan",
  "avo_get_trial_evidence",
  "avo_get_task",
  "avo_get_state",
  "avo_get_lineage",
  "avo_get_memory",
  "avo_get_evaluation",
  "avo_get_prompt",
  "avo_set_prompt",
  "avo_append_prompt",
  "avo_replace_prompt",
  "avo_delete_prompt_fragment",
  "avo_select_parent",
  "avo_select_references",
  "avo_list_image_pool",
  "avo_view_image",
  "avo_select_generation_inputs",
  "avo_generate_image",
  "avo_evaluate_draft",
  "avo_restore_attempt",
  "avo_decline_pending_decision",
  "avo_update_working_memory",
  "avo_upsert_hypothesis",
  "avo_abandon_attempt",
  "avo_abandon_step",
  "avo_submit_candidate",
] as const;

export const validateAvoMcpInventory = (result: unknown, features?: ExperimentalFeatures) => {
  const data = asRecord(result)?.data;
  const servers = Array.isArray(data) ? data.map((item) => asRecord(item)).filter(Boolean) : [];
  if (servers.length !== 1 || servers[0]?.name !== "avo") throw new Error("codex_mcp_inventory_violation");
  const actual = Object.keys(asRecord(servers[0]?.tools) ?? {}).sort();
  const expected = allowedAvoTools(AVO_MCP_TOOL_ALLOWLIST, features).sort();
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    throw new Error("codex_mcp_inventory_violation");
  }
  return actual;
};

const assertAvoMcpInventory = async (client: AppServerClient, threadId: string, features?: ExperimentalFeatures) => {
  const result = await client.request("mcpServerStatus/list", {
    threadId,
    detail: "toolsAndAuthOnly",
    limit: 100,
  });
  validateAvoMcpInventory(result, features);
  return avoToolTransportContext(result, features);
};

export const avoToolTransportContext = (result: unknown, features?: ExperimentalFeatures) => {
  const names = validateAvoMcpInventory(result, features);
  const servers = asRecord(result)!.data as Array<Record<string, unknown>>;
  const tools = asRecord(servers[0]!.tools)!;
  return `Authorized AVO tool schemas (the runtime may expose these only through functions.exec):\n${JSON.stringify(names.map((name) => ({ name, ...asRecord(tools[name]) })))}`;
};

export class CodexAppServerAgentProvider implements AgentProvider {
  readonly id = "codex-app-server";

  constructor(
    private readonly config: AppConfig,
    private readonly broker: AgentToolBroker,
    private readonly store?: FileStateStore,
    private readonly providerProxyToken = "",
    private readonly supervisorConfig: AppConfig = config,
  ) {}

  async probe(signal?: AbortSignal) {
    if (!this.config.AVO_CODEX_PROVIDER_BASE_URL || !this.config.AVO_CODEX_PROVIDER_API_KEY || !this.providerProxyToken) {
      return { ok: false, message: "Main Agent Qwen Provider 未配置" };
    }
    const token = randomBytes(24).toString("hex");
    const client = new AppServerClient(this.config, token, this.providerProxyToken);
    try {
      await client.initialize();
      if (signal?.aborted) throw signal.reason ?? new Error("codex_probe_aborted");
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
      await assertAvoMcpInventory(client, thread.thread.id);
      const completed = client.waitFor("turn/completed", () => true, Math.min(this.config.AVO_CODEX_TURN_TIMEOUT_MS, 60_000));
      await client.request("turn/start", {
        threadId: thread.thread.id,
        effort: "low",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        input: [{ type: "text", text: "Reply with OK." }],
      });
      const event = await completed;
      if (signal?.aborted) throw signal.reason ?? new Error("codex_probe_aborted");
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
    const features = context.run.config.experimental_features;
    const allowedTools = allowedAvoTools(AVO_MCP_TOOL_ALLOWLIST, features);
    const client = new AppServerClient(this.config, token, this.providerProxyToken, true, undefined, true, features);
    let off: () => void = () => {};
    let unregister: () => void = () => {};
    let eventWrites = Promise.resolve();
    let hardDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stepStartedAt = Date.now();
      const deadline: StepDeadline = {
        started_at: new Date(stepStartedAt).toISOString(),
        soft_deadline_at: new Date(stepStartedAt + this.config.AVO_AGENT_STEP_SOFT_TIMEOUT_MS).toISOString(),
        hard_deadline_at: new Date(stepStartedAt + this.config.AVO_AGENT_STEP_TIMEOUT_MS).toISOString(),
        state: "open",
      };
      await tools.setStepDeadline(deadline);
      const stepContext = { ...context, run: tools.getRunSnapshot() };
      unregister = this.broker.register(token, tools, stepContext, deadline);
      await client.initialize();
      await this.prepareHarness(context);
      const thread = await client.request("thread/start", {
        model: this.config.AVO_CODEX_MODEL,
        cwd: join(this.config.AVO_DATA_DIR, "runs", context.run.id, "harness"),
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: mainAgentInstructions + (features?.svg_editing ? `\n${svgAgentInstructions}` : "")
          + (features?.photo_adjustments ? `\n${photoAgentInstructions}` : ""),
      }) as { thread: { id: string } };
      const transportContext = await assertAvoMcpInventory(client, thread.thread.id, features);
      if (this.store) {
        await this.store.commitRun(context.run.id, "agent.step_started", {
          thread_id: thread.thread.id,
          variation_attempt: context.run.active_variation_attempt,
        }, (current) => {
          if (!current) throw new Error("run_not_found");
          return { ...current, agent_thread_id: thread.thread.id, updated_at: new Date().toISOString() };
        });
      }

      let policyViolation: string | undefined;
      let tokenWarningRecorded = false;
      const runTokenBase = context.run.agent_total_tokens;
      const explicitRunTokenLimit = context.run.config.max_agent_tokens ?? this.config.AVO_AGENT_TOKEN_LIMIT;

      off = client.onMessage((message) => {
        const item = message.params?.item as Record<string, unknown> | undefined;
        if (message.method === "item/completed" && (item?.type === "commandExecution" || item?.type === "fileChange")) {
          policyViolation = `codex_forbidden_${String(item.type)}`;
          tools.signalBudgetExceeded(policyViolation);
        }
        if (message.method === "item/completed" && item?.type === "mcpToolCall") {
          const tool = String(item.tool ?? item.name ?? "unknown");
          if (!allowedTools.includes(tool)) {
            policyViolation = `codex_forbidden_tool:${tool}`;
            tools.signalBudgetExceeded(policyViolation);
          }
        }
        const event = publicAgentEvent(message);
        const stepTokens = message.method === "thread/tokenUsage/updated"
          ? readTotalTokens(message.params?.tokenUsage ?? message.params)
          : undefined;
        if (stepTokens !== undefined) {
          const latestContextTokens = readLastTokens(message.params?.tokenUsage ?? message.params) ?? 0;
          const modelContextWindow = readModelContextWindow(message.params?.tokenUsage ?? message.params) ?? this.config.AVO_AGENT_CONTEXT_WINDOW;
          const cumulativeTokens = runTokenBase + stepTokens;
          eventWrites = eventWrites.then(() => tools.recordAgentRuntime({ totalTokens: cumulativeTokens }));
          if (explicitRunTokenLimit && cumulativeTokens >= explicitRunTokenLimit) {
            tools.signalBudgetExceeded("agent_token_budget_exhausted");
          } else if (this.config.AVO_AGENT_STEP_TOKEN_LIMIT && stepTokens >= this.config.AVO_AGENT_STEP_TOKEN_LIMIT) {
            tools.signalBudgetExceeded("agent_step_token_budget_exhausted");
          } else if (latestContextTokens >= modelContextWindow * 0.8) {
            tools.signalBudgetExceeded("agent_context_window_near_limit");
          } else if (cumulativeTokens >= this.config.AVO_AGENT_TOKEN_WARNING && !tokenWarningRecorded) {
            tokenWarningRecorded = true;
            if (this.store) {
              eventWrites = eventWrites.then(async () => {
                await this.store!.commitRun(context.run.id, "agent.budget_warning", {
                  total_tokens: cumulativeTokens,
                  limit: explicitRunTokenLimit ?? null,
                }, (current) => {
                  if (!current) throw new Error("run_not_found");
                  return { ...current, updated_at: new Date().toISOString() };
                });
              });
            }
          }
        }
        if (event && this.store) {
          eventWrites = eventWrites.then(async () => {
            await this.store!.commitRun(context.run.id, event.type, event.data, (current) => {
              if (!current) throw new Error("run_not_found");
              return { ...current, updated_at: new Date().toISOString() };
            });
          });
        }
      });

      const started = await client.request("turn/start", {
        threadId: thread.thread.id,
        effort: this.config.AVO_MAIN_PROVIDER === "78code" ? this.config.AVO_CODEX_EFFORT : "low",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        input: [{ type: "text", text: transportContext + "\n\n" + variationStepPrompt(stepContext) + experimentPrompt(stepContext) }],
      }) as { turn?: { id?: string } };
      const turnId = started.turn?.id;
      if (!turnId) throw new Error("codex_turn_id_missing");
      const completed = client.waitFor(
        "turn/completed",
        (params) => (params.turn as { id?: string } | undefined)?.id === turnId,
        this.config.AVO_AGENT_STEP_TIMEOUT_MS + this.config.AVO_CODEX_INTERRUPT_GRACE_MS + 30_000,
      );
      const outcome = await Promise.race([
        completed.then(
          (event) => ({ kind: "completed" as const, event }),
          (error: Error) => ({ kind: "event_error" as const, error }),
        ),
        tools.waitForSubmission().then((submission) => ({ kind: "submitted" as const, submission })),
        tools.waitForAbandonment().then((abandonment) => ({ kind: "abandoned" as const, abandonment })),
        tools.waitForBudgetExceeded().then((reason) => ({ kind: "budget" as const, reason })),
        tools.waitForStop().then(() => ({ kind: "stopped" as const })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          hardDeadlineTimer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, Date.parse(deadline.hard_deadline_at) - Date.now()));
        }),
      ]);

      if (outcome.kind !== "completed") {
        this.broker.beginClosing(token);
        await client.request("turn/interrupt", { threadId: thread.thread.id, turnId }).catch(() => undefined);
        await Promise.race([
          completed.catch(() => undefined),
          delay(this.config.AVO_CODEX_INTERRUPT_GRACE_MS),
        ]);
        await this.broker.waitForIdle(token);
      }
      await eventWrites;

      if (outcome.kind === "submitted" || tools.getRunSnapshot().submitted_draft_id) {
        if (this.store) {
          await this.store.commitRun(context.run.id, "agent.step_completed", {
            variation_attempt: context.run.active_variation_attempt,
            draft_id: outcome.kind === "submitted" ? outcome.submission.draftId : tools.getRunSnapshot().submitted_draft_id,
          }, (current) => {
            if (!current) throw new Error("run_not_found");
            return { ...current, updated_at: new Date().toISOString() };
          });
        }
        return;
      }
      if (outcome.kind === "abandoned" || tools.getRunSnapshot().active_variation_attempt > context.run.active_variation_attempt) return;
      if (policyViolation) throw new Error(policyViolation);
      if (outcome.kind === "budget") {
        await tools.abandonStep(outcome.reason, systemAbandonmentSummary(outcome.reason), undefined, "runtime_cutoff");
        return;
      }
      if (outcome.kind === "stopped") {
        await tools.abandonStep("user_stopped", systemAbandonmentSummary("user_stopped"));
        return;
      }
      if (outcome.kind === "timeout") {
        await tools.abandonStep("agent_step_timeout", systemAbandonmentSummary("agent_step_timeout"), undefined, "runtime_cutoff");
        return;
      }
      if (outcome.kind === "event_error") {
        if (/codex_event_timeout|event_timeout/i.test(outcome.error.message)) {
          if (Date.now() >= Date.parse(deadline.hard_deadline_at)) {
            await tools.abandonStep("agent_step_timeout", systemAbandonmentSummary("agent_step_timeout"), undefined, "runtime_cutoff");
            return;
          }
          throw new Error("app_server_error");
        }
        throw outcome.error;
      }
      const status = (outcome.event.turn as { status?: string } | undefined)?.status;
      if (status !== "completed") throw new Error(`codex_turn_${status ?? "failed"}`);
      await tools.abandonStep("agent_ended_without_decision", systemAbandonmentSummary("agent_ended_without_decision"));
      return;
    } catch (error) {
      const diagnostics = client.diagnostics();
      const code = stableAgentErrorCode((error as Error).message);
      if (diagnostics && this.store) {
        await this.store.commitRun(context.run.id, "agent.diagnostic", {
          code,
          detail: diagnostics.slice(-4_000),
        }, (current) => {
          if (!current) throw new Error("run_not_found");
          return { ...current, updated_at: new Date().toISOString() };
        }).catch(() => undefined);
      }
      throw new Error(code);
    } finally {
      if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);
      off();
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

  async supervise(context: AgentRoundContext, request: { triggers: string[]; scope: "in_step" | "step_boundary" }) {
    const outputContract = {
      intervene: false,
      diagnosis: "Concise trajectory diagnosis.",
      branch_strategy: "continue | restart_source | restore_history | diversify | stop_search",
      recommended_parent_id: null,
      quality_risks: ["risk"],
      avoid: ["direction to avoid"],
      try: ["next strategy"],
      review_node_ids: [],
      search_assessment: { tested_parent_ids: [], trial_claims: [], untested_alternatives: [], conclusion_scope: "branch | tested_alternatives | search_budget", strategy_change: "A concrete, testable difference from the failed branch." },
    };
    const prompt = [
      "你是只读 AVO Supervisor。分析完整 search trajectory、正式单 Lineage、Memory、目标进展和质量风险；不能修改 prompt、调用生成、提交 candidate 或选择 Final。",
      "只有在 scope=step_boundary、触发 three_attempts_without_new_version 且轨迹证明继续搜索没有合理正收益时，才返回 branch_strategy=stop_search。stop_search 只结束搜索，最终节点仍由独立 Verifier 选择；不要返回 recommended_parent_id。",
      "当 scope=step_boundary 且触发 three_attempts_without_new_version 时，continue 是无效决策。你必须 intervene=true，并在 restart_source、restore_history、diversify、stop_search 中选择一个；若继续搜索，必须给出与停滞分支实质不同的策略，restore_history 必须指定真实 recommended_parent_id。",
      "同一个父代的反复失败只支持分支失败，不证明模型能力上限。search_assessment 必须列真实测试过的 parent node/draft IDs、尚未验证的替代方向和具体策略变化。未尝试较早干净节点时，不得宣称没有可行方向；可因成本停止，但 conclusion_scope 必须为 search_budget 并列出未验证方向。",
      "diversify 要给出具体变化，不是换措辞；使用 recommended_parent_id 指明不同父代，或明确改变编辑范围/方法。review_node_ids 可请求按当前框架重审存在继承缺陷或过期判定的历史节点。",
      "source severe/warn 是测量差异，不是语义禁令；只有 Verifier 当前框架和人类约束能决定是否为退化。不得自行把目标允许的色彩、光照、构图变化禁止。质疑框架时请求复审，不能悄悄冻结新门槛。记忆中的能力结论是有适用范围的假设，不是事实。",
      "必须检查 actual_trials 的完整输入，而非只看父图。Source 底图带任何生成参考不算干净 Source-only 试验，不能用它否定干净重启。基于输入历史的结论必须写入 trial_claims：kind 为 observational、clean_source_tested、clean_source_failed、base_effect 或 reference_effect，draft_ids 是真实候选 IDs。后两类须两张图仅改变该变量、提示词保持一致且已在同一 frame 评价；否则只能标 observational，明确混杂变量。单次成败不证明普遍规律。",
      "出现重复生成退化时，在剩余预算内优先提出有区分力的对照：A=Source无生成参考；B=生成底图无参考；必要时C=Source加生成参考。保持完整提示词等其余设置一致。不必强制全部执行，也不能另加预算。构图收益可继承为完整文字方案，不必继承坏图像素；参考用途声明不是像素遮罩。",
      `必须只返回一个顶层 JSON 对象，完整包含以下字段；不得只返回其中某个数组：${JSON.stringify(outputContract)}`,
      JSON.stringify({
        supervisor_request: request,
        task: {
          id: context.task.id,
          user_brief: context.task.user_brief,
          preservation_contract: context.task.preservation_contract,
        },
        variation_attempts: context.run.variation_attempts.slice(-4),
        lineage: context.run.lineage_nodes,
        incumbent_node_id: context.run.incumbent_node_id,
        search_archive: context.run.search_archive.slice(-12),
        memory: context.run.working_memory,
        hypotheses: context.run.hypotheses,
        validator_trends: context.run.validator_trends.slice(-8),
        evaluations: context.run.comparative_decisions.slice(-12).map(agentSupervisorEvaluation),
        current_frame: context.run.evaluation_frame_revisions.at(-1),
        actual_trials: trialEvidence(context.run, context.run.drafts.slice(-12)),
        trial_index: trialEvidence(context.run).map(({ draft_id, method, base_artifact_id, clean_source_generation, prompt_sha256, reference_inputs }) => ({
          draft_id, method, base_artifact_id, clean_source_generation, prompt_sha256, reference_inputs,
        })),
        prior_redirects: context.run.supervisor_decisions.slice(-4),
        parent_selections: context.run.variation_attempts.slice(-4).map((attempt) => attempt.parent_selection),
      }),
    ].join("\n\n");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const result = await this.runStructured(
          context,
          attempt === 1 ? prompt : `${prompt}\n\n上一份输出没有满足顶层对象合同。只返回完整 JSON 对象，不要 Markdown，也不要单独返回 quality_risks/avoid/try 数组。`,
          supervisorSchema,
          true,
        );
        return parseSupervisorAdvice(result);
      } catch (error) {
        lastError = error;
        if (!/structured_output|invalid_json|supervisor_invalid_output|JSON/i.test((error as Error).message)) throw error;
        if (attempt === 2) {
          Object.assign(error as object, { supervisorAttempts: 2 });
          throw error;
        }
      }
    }
    throw lastError;
  }

  private async runStructured(context: AgentRoundContext, prompt: string, outputSchema: Record<string, unknown>, supervisor = false) {
    const token = randomBytes(32).toString("hex");
    const config = supervisor ? { ...this.supervisorConfig, AVO_CODEX_BIN: this.config.AVO_CODEX_BIN } : this.config;
    const history = new ReviewContext(config.AVO_DATA_DIR, "supervisor", `${config.AVO_CODEX_PROVIDER_BASE_URL}:${config.AVO_CODEX_MODEL}`);
    const previous = supervisor ? await history.read(context.run.id) : [];
    const imageIds = new Set([
      context.task.source_artifact_id,
      ...context.run.lineage_nodes.slice(0, 2).map((node) => node.artifact_id),
      ...context.run.lineage_nodes.slice(-2).map((node) => node.artifact_id),
      ...context.run.drafts.slice(-2).map((draft) => draft.artifact_id),
    ]);
    const images = supervisor ? context.imagePool.filter((item) => imageIds.has(item.artifactId)).map((item) => ({ label: `Review image ${item.artifactId}`, path: item.path })) : [];
    const previews = await Promise.all([...new Map([...previous.flatMap((entry) => entry.images), ...images].map((item) => [item.path, item])).values()].slice(-8)
      .map(async (image) => ({ label: `${image.label} (1024px analysis preview)`, path: await history.preview(image.path) })));
    const client = new AppServerClient(config, token, this.providerProxyToken, false);
    try {
      await client.initialize();
      await this.prepareHarness(context);
      const thread = await client.request("thread/start", {
        model: config.AVO_CODEX_MODEL,
        cwd: join(config.AVO_DATA_DIR, "runs", context.run.id, "harness"),
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
      const completed = client.waitFor("turn/completed", () => true, config.AVO_CODEX_TURN_TIMEOUT_MS);
      await client.request("turn/start", {
        threadId: thread.thread.id,
        effort: config.AVO_CODEX_EFFORT,
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        outputSchema,
        input: [
          ...previous.map((entry) => ({ type: "text", text: `Previous Supervisor exchange (fallible evidence):\n${entry.prompt}\n${entry.reply}` })),
          { type: "text", text: prompt },
          ...previews.flatMap((image) => [{ type: "text", text: image.label }, { type: "localImage", path: image.path }]),
        ],
      });
      await completed;
      off();
      const result = parseStructuredJsonText(finalText);
      if (supervisor) {
        parseSupervisorAdvice(result);
        await history.append(context.run.id, { prompt, reply: JSON.stringify(result), images });
      }
      return result;
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

export const parseStructuredJsonText = (text: string): unknown => {
  const trimmed = text.trim();
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]!.trim());
  const balanced = firstBalancedJsonValue(trimmed);
  const candidates = [...new Set([trimmed, ...fenced, ...(balanced ? [balanced] : [])].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next deterministic extraction strategy.
    }
  }
  throw structuredOutputError("codex_structured_output_invalid_json", trimmed);
};

const structuredOutputError = (code: string, value: unknown) => {
  const error = new Error(code);
  const preview = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
  Object.assign(error, { structuredOutputPreview: preview.slice(0, 2_000) });
  return error;
};

const firstBalancedJsonValue = (text: string) => {
  for (let start = 0; start < text.length; start += 1) {
    const opening = text[start];
    if (opening !== "{" && opening !== "[") continue;
    const stack: string[] = [opening];
    let inString = false;
    let escaped = false;
    for (let index = start + 1; index < text.length; index += 1) {
      const character = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === "{" || character === "[") stack.push(character);
      if (character === "}" || character === "]") {
        const expected = character === "}" ? "{" : "[";
        if (stack.at(-1) !== expected) break;
        stack.pop();
        if (stack.length === 0) return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
};

const safeCodexEnv = (extra: Record<string, string>) => {
  const keys = ["HOME", "PATH", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"];
  return Object.fromEntries([
    ...keys.flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []),
    ...Object.entries(extra),
  ]);
};

const stableAgentErrorCode = (message: string) => {
  const known = [
    "agent_token_budget_exhausted",
    "agent_tool_call_limit_exhausted",
    "agent_did_not_submit_candidate",
    "codex_app_server_fatal",
    "app_server_error",
    "codex_event_timeout",
    "codex_interrupt_timeout",
    "codex_app_server_exited",
    "codex_turn_",
    "codex_forbidden_tool",
  ].find((prefix) => message.startsWith(prefix));
  return known ? message.split(":", 1)[0]! : "codex_agent_round_failed";
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
    return { type: "agent.tool_completed", data: { tool: item.tool ?? item.name ?? "unknown", status: item.status ?? "unknown",
      ...(item.status === "failed" || item.error ? { diagnostics: toolFailureDiagnostic(item) } : {}) } };
  }
  if (item.type === "commandExecution" || item.type === "fileChange") {
    return { type: "agent.policy_violation", data: { item_type: item.type } };
  }
  return undefined;
};

const mainAgentInstructions = `You are the autonomous AVO image-editing variation operator Vary(Pt)=Agent(Pt,K,f).
Use only avo_* MCP tools to change candidate state. Do not edit files or call external services directly.
Never call list_mcp_resources, read_mcp_resource, shell, browser, search, file tools, external services, subagents, or other non-AVO capabilities.
Transport exception: when AVO tools are exposed through functions.exec, use that JavaScript wrapper ONLY to discover and sequentially invoke authorized AVO MCP tools. This wrapper is permitted transport, not a policy violation. Inspect ALL_TOOLS filtered to AVO names to find their exact normalized identifiers; the initial message supplies all authorized argument schemas. Do not discover or invoke unrelated tools. Do not use JavaScript to read files, access the network, synthesize/edit images, or bypass the AVO tools.
For a wrapped call, await exactly one authorized tool, then forward every returned content block: image blocks via image(block), text blocks via text(block.text). Do not only serialize image blocks as text: you must see the returned image. If functions.exec yields a running cell ID, use functions.wait only for that cell until it completes. Do not abandon merely because direct AVO tool names are absent: the authorized wrapper path is available.
This session is one complete autonomous Variation Attempt. You decide what to inspect, which parent and references to use, when to generate, when to evaluate, and how many times to revise before submission.
Call tools sequentially and wait for each result before choosing the next action. Never emit parallel tool calls. If a tool returns a validation error, correct the arguments once instead of probing tool names.
The immutable user_brief is evidence for planning and MUST NOT be forwarded verbatim as the image-generation prompt. You must author a focused generation prompt with avo_set_prompt before every generation.
The initial message already contains the human intent, source/public-reference IDs, official lineage, current incumbent, memory, recent Attempts, budgets, and Supervisor advice. Persisted IDs and events are authoritative; interpretations in Memory or prior reviews remain fallible hypotheses. Do not reread unchanged state before the first generation. Explicitly choose a parent with avo_select_parent; the newest draft is never an automatic parent.
View only the images needed for the next decision. Form an Observation, Hypothesis, and focused Intervention.
For every generated draft, inspect it with avo_view_image and evaluate it with avo_evaluate_draft. The Agentic Verifier compares it with the official incumbent under a private fixed frame and returns only a decision_id, relative preference, target progress, confidence, gate, and redacted feedback. You cannot see sealed axes or raw programmatic measurements. Diagnose and revise from the visible feedback.
Every tool response includes the remaining Attempt time and deadline state. When the session becomes decision_only, do not attempt another generation; evaluate any remaining draft and submit a Verifier-recommended candidate or abandon. If a carried pending decision is present, submit it, abandon, or call avo_decline_pending_decision with a rationale before continuing search.
Include the complete next working_memory in avo_submit_candidate or avo_abandon_attempt so reusable findings and dead ends survive into the next Invocation. You may also update Memory or hypotheses earlier when useful.
Submit only when the current comparison recommends commit, using avo_submit_candidate(draft_id,decision_id,...). Equivalent, worse, uncertain, and gate-blocked candidates cannot enter the official lineage; revise or use avo_abandon_attempt. Confidence reports Verifier uncertainty and is not a quality threshold. A successful closing call ends this Invocation immediately; do not call any more tools afterward.
Each avo_generate_image invocation consumes the run generation budget even when the Provider fails. Do not retry after a deterministic Provider error or generation_budget_exhausted.
If no generated artifact exists after a Provider failure, do not submit the source or any reference as a candidate. End the turn with a brief failure report so the controller can fail closed.
The original source remains available as a baseline, not an automatic objective to resemble. Source difference alone does not prove quality degradation; use human requirements and Verifier feedback. Use only artifact IDs from the controlled image pool.
Optimize a replayable EDIT PLAN, not only the last image. Use avo_set_edit_plan to set the complete accumulated prompt, explicit base and reference uses; use avo_get_trial_evidence for exact historical inputs and recipes. Carry successful instructions forward without necessarily carrying generated pixels forward. Source plus ANY generated reference is not a clean Source-only trial. A reference declared for composition may still transfer bad texture; role labels do not mask pixels. Prefer describing the useful structure in the prompt when a reference has visible defects.
When degradation repeats, test clean Source/no references against the generated base/no references with the SAME complete prompt if budget permits; optionally test Source plus generated references separately. Do not change multiple inputs and then claim which one caused the result. Avoid universal conclusions from one sample. Supported/refuted hypotheses require a structured trial_claim; observational evidence is not a controlled causal result. Working-memory prose is a fallible summary, never stronger evidence than the saved inputs.
Only avo_evaluate_draft may invoke f. You cannot forge a comparison, recommendation, official x(t+1), or Final; the controller and Agentic Verifier own those facts.`;

const variationStepPrompt = (context: AgentRoundContext) => [
  `AVO Agent Invocation / Variation Attempt ${context.run.active_variation_attempt}, targeting official version x${context.run.active_evolution_version + 1}. Complete one autonomous variation operator session.`,
  `用户 Brief（只用于规划，禁止原样作为生成 Prompt）：${context.task.user_brief}`,
  `Source Artifact：${context.task.source_artifact_id}`,
  `公开 References：${JSON.stringify(context.task.references)}`,
  `Run 预算：${context.run.generation_count}/${context.run.config.max_generations} 次生成已使用；本 Attempt 最多还可使用 ${context.run.config.max_generations_per_round} 次生成，但应按证据节制使用。`,
  context.run.step_deadline
    ? `Step 截止：soft=${context.run.step_deadline.soft_deadline_at}，hard=${context.run.step_deadline.hard_deadline_at}。soft 后停止生成并完成评价与决策。`
    : "Step 截止由 Controller 管理，并会随每个工具结果返回。",
  context.run.pending_decision
    ? `必须优先处理的历史决策：${JSON.stringify(context.run.pending_decision)}。先重新评价旧 revision 候选；提交、放弃，或用 avo_decline_pending_decision 明确拒绝后才能继续生成。`
    : "当前没有待处理的历史决策。",
  `当前 working memory（跨 Step NOTES）：${JSON.stringify(context.run.working_memory)}`,
  `当前 hypotheses：${JSON.stringify(context.run.hypotheses)}`,
  `正式单 Lineage：${JSON.stringify(context.run.lineage_nodes.map((node) => ({ id: node.id, version: node.version ?? 0, kind: node.kind, previous_version_node_id: node.previous_version_node_id, derived_from_node_id: node.derived_from_node_id, artifact_id: node.artifact_id, current_review: node.current_review })))}`,
  "历史 Commit 不保证在当前框架下仍合格。检查 current_review；若选择 fail/unclear 的父代，必须说明继承缺陷及复用理由。长期 Memory 里的能力判断必须保留证据、适用分支和未测试的替代假设。",
  `当前 incumbent：${context.run.incumbent_node_id}`,
  `本次 frame 提名可重评的历史 Draft：${JSON.stringify(context.run.evaluation_frame_revisions.find((frame) => frame.attempt === context.run.active_variation_attempt)?.reconsider_candidate_ids ?? [])}`,
  context.supervisorDecision
    ? `Supervisor 建议：${JSON.stringify(context.supervisorDecision)}。它是强先验而不是固定命令；如不采用推荐父代，必须记录 override rationale。`
    : "本 Step 没有 Supervisor 介入。",
  `最近 Variation Attempts：${JSON.stringify(context.run.variation_attempts.slice(-2).map((attempt) => ({ attempt: attempt.attempt, target_version: attempt.target_version, status: attempt.status, parent: attempt.parent_selection?.parent_node_id, drafts: attempt.draft_ids, summary: attempt.summary, terminal_reason: attempt.terminal_reason })))}`,
  ...(context.run.config.experimental_features?.photo_adjustments ? [
    `最近候选的可重放输入：${JSON.stringify(context.run.drafts.slice(-8).map((draft) => ({
      draft_id: draft.id, artifact_id: draft.artifact_id, parent_artifact_id: draft.parent_artifact_id,
      source_rooted: draft.parent_artifact_id === context.task.source_artifact_id,
      creation_method: draft.creation_method ?? "image_provider", generation_input: draft.generation_input,
      photo_edit: draft.photo_edit,
    })))}`,
    "比较实际 parent 和 Source，而不是只看正式版本号。无新增损伤不等于没有累计损伤；从 Source 重启也不是质量保证。保留已观察到的改进，将退化原因作为假设，通过更新 prompt/允许的 references/调色参数去验证。隐藏参考仍不可取用。",
  ] : []),
  "你可以在这个持续会话内自由反复执行：检查图片和历史、选择父代、编写 Prompt、生成、查看、评价、诊断、更新 Memory/Hypothesis、修改 Prompt 或父代、再次生成。不要按固定阶段停顿，也不要在一次工具调用后结束 turn。",
  "任务开始时已提供完整的压缩状态。第一轮直接从选择父代、查看必要图片和写 Prompt 开始；不要先调用 avo_get_task / avo_get_state / avo_get_lineage / avo_get_memory 重复读取。只在状态确实变化且返回结果缺少必要事实时调用读取工具。图片必须通过 avo_view_image 按需查看。",
  "结束前必须调用 avo_submit_candidate 提交一个 Verifier 明确推荐 Commit 的 Draft，或调用 avo_abandon_attempt 保存死路；同时提交完整 working_memory。任一关闭调用成功后 Controller 会持久化结果并结束本 Invocation。",
].join("\n\n");

const systemAbandonmentSummary = (reason: string): AgentSummary => ({
  observation: `The autonomous variation step ended at the runtime boundary: ${reason}.`,
  hypothesis: "A fresh variation-step context can continue from the persisted lineage, drafts, evaluations, and memory without retaining the stalled conversation.",
  intervention: "Abandoned this step without committing a candidate and preserved its drafts as trajectory evidence.",
});

const agentSupervisorEvaluation = (decision: AgentRoundContext["run"]["comparative_decisions"][number]) => ({
  id: decision.id,
  draft_id: decision.draft_id,
  incumbent_node_id: decision.incumbent_node_id,
  preference: decision.preference,
  target_progress: decision.target_progress,
  confidence: decision.confidence,
  recommendation: decision.recommendation,
  failed_axes: decision.axis_judgments.filter((judgment) => judgment.verdict !== "pass").map((judgment) => judgment.axis_id),
  technical_gate: decision.technical_gate,
  visible_feedback: decision.feedback_for_main_agent.slice(-12),
});

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
  required: ["intervene", "diagnosis", "branch_strategy", "quality_risks", "avoid", "try", "search_assessment", "review_node_ids"],
  properties: {
    intervene: { type: "boolean" },
    diagnosis: { type: "string", minLength: 1 },
    branch_strategy: { type: "string", enum: ["continue", "restart_source", "restore_history", "diversify", "stop_search"] },
    recommended_parent_id: { type: ["string", "null"] },
    quality_risks: { type: "array", items: { type: "string" }, maxItems: 50 },
    avoid: { type: "array", items: { type: "string" }, maxItems: 50 },
    try: { type: "array", items: { type: "string" }, maxItems: 50 },
    review_node_ids: { type: "array", items: { type: "string" }, maxItems: 10 },
    search_assessment: {
      type: "object", additionalProperties: false,
      required: ["tested_parent_ids", "trial_claims", "untested_alternatives", "conclusion_scope", "strategy_change"],
      properties: {
        tested_parent_ids: { type: "array", items: { type: "string" } },
        trial_claims: { type: "array", maxItems: 20, items: { type: "object", additionalProperties: false,
          required: ["kind", "draft_ids"], properties: {
            kind: { enum: ["observational", "clean_source_tested", "clean_source_failed", "base_effect", "reference_effect"] },
            draft_ids: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
          } } },
        untested_alternatives: { type: "array", items: { type: "string" } },
        conclusion_scope: { type: "string", enum: ["branch", "tested_alternatives", "search_budget"] },
        strategy_change: { type: "string" },
      },
    },
  },
};

const parseSupervisorAdvice = (value: unknown) => {
  const item = asRecord(value);
  if (!item || typeof item.intervene !== "boolean" || typeof item.diagnosis !== "string") {
    throw structuredOutputError("codex_supervisor_invalid_output", value);
  }
  if (!item.search_assessment || !Array.isArray(item.review_node_ids)) throw structuredOutputError("codex_supervisor_invalid_output:missing_search_assessment", value);
  const branch = String(item.branch_strategy ?? "continue");
  if (!["continue", "restart_source", "restore_history", "diversify", "stop_search"].includes(branch)) {
    throw structuredOutputError("codex_supervisor_invalid_output", value);
  }
  return {
    intervene: item.intervene,
    diagnosis: item.diagnosis,
    branch_strategy: branch as "continue" | "restart_source" | "restore_history" | "diversify" | "stop_search",
    ...(typeof item.recommended_parent_id === "string" ? { recommended_parent_id: item.recommended_parent_id } : {}),
    quality_risks: Array.isArray(item.quality_risks) ? item.quality_risks.map(String) : [],
    avoid: Array.isArray(item.avoid) ? item.avoid.map(String) : [],
    try: Array.isArray(item.try) ? item.try.map(String) : [],
    ...(item.search_assessment ? { search_assessment: supervisorDecisionSchema.shape.search_assessment.unwrap().parse(item.search_assessment) } : {}),
    ...(Array.isArray(item.review_node_ids) ? { review_node_ids: supervisorDecisionSchema.shape.review_node_ids.unwrap().parse(item.review_node_ids) } : {}),
  };
};
