import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { z } from "zod";
import sharp from "sharp";
import { ProxyAgent, type Dispatcher } from "undici";
import { ReviewContext } from "./review-context.ts";
import { detailContent } from "./visual-detail.ts";
import {
  comparativeVerifierDecisionSchema,
  evaluationFrameRevisionSchema,
  finalVerifierDecisionSchema,
  requirementChecklistSchema,
  usageSchema,
  verificationResultSchema,
  type ComparativeVerifierDecision,
  type EvaluationFrameRevision,
  type FinalVerifierDecision,
  type RequirementChecklist,
  type VerificationResult,
} from "@avo/contracts";
import type { ImageGenerationResult, ImageProvider, VerifierEvidence, VerifierProvider, VerifierToolName } from "@avo/core";
import type { AppConfig } from "./config.ts";

const dataUrl = async (path: string) => {
  const mime = path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg" : path.endsWith(".webp") ? "image/webp" : "image/png";
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
};

const retryableFetch = async (url: string, init: RequestInit, attempts = 3, dispatcher?: Dispatcher) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (init.signal?.aborted) throw init.signal.reason ?? new Error("request_aborted");
    try {
      const response = await fetch(url, { ...init, ...(dispatcher ? { dispatcher } : {}) });
      if (response.ok || !([408, 425, 429].includes(response.status) || response.status >= 500) || attempt === attempts) return response;
      await response.arrayBuffer().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } catch (error) {
      lastError = error;
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
};

export const responsesBody = async (response: Response): Promise<Record<string, unknown>> => {
  if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error("responses_provider_empty_stream");
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer = (buffer + decoder.decode(value, { stream: !done })).replaceAll("\r\n", "\n");
        let boundary: number;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (!data || data === "[DONE]") continue;
          const event = JSON.parse(data) as Record<string, unknown>;
          if (event.type === "response.completed") return event.response as Record<string, unknown>;
          if (event.type === "response.incomplete") throw new Error(`responses_provider_output_incomplete:${JSON.stringify((event.response as Record<string, unknown> | undefined)?.incomplete_details ?? {})}`);
          if (event.type === "response.failed" || event.type === "error") throw new Error(`responses_provider_stream_failed:${errorMessage(event)}`);
        }
        if (done) throw new Error("responses_provider_stream_incomplete");
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  }
  const text = await response.text();
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(`responses_provider_http_${response.status}:non_json_response:${response.headers.get("content-type") ?? "unknown"}`); }
  if (!response.ok) throw new Error(`responses_provider_http_${response.status}:${errorMessage(body)}`);
  return body;
};

export class GptImageProvider implements ImageProvider {
  readonly id = "openai-gpt-image-2";
  constructor(private readonly config: AppConfig) {}

  async probe(signal?: AbortSignal) {
    if (!this.config.OPENAI_API_KEY) return { ok: false, message: "OPENAI_API_KEY 未配置" };
    if (!this.config.AVO_RUN_LIVE_PROBES) return { ok: false, message: "已配置但真实 probe 未授权；设置 AVO_RUN_LIVE_PROBES=true" };
    const directory = await mkdtemp(join(tmpdir(), "avo-image-probe-"));
    try {
      const source = join(directory, "source.png");
      await writeFile(source, probePixel);
      const result = await this.generateWithTaskTimeout({
        prompt: "Keep the input unchanged. This is a capability probe.",
        base: { path: source, mimeType: "image/png" },
        references: [],
        idempotencyKey: `avo-probe-${Date.now()}`,
      }, Math.min(this.config.AVO_IMAGE_TASK_TIMEOUT_MS, this.config.AVO_PROVIDER_PROBE_TIMEOUT_MS), signal, 1);
      if (result.bytes.length < 100) return { ok: false, message: "GPT Image 2 probe 返回空图片" };
      return { ok: true, message: `${this.config.AVO_IMAGE_MODEL} 真实编辑 probe 通过` };
    } catch (error) {
      return { ok: false, message: `GPT Image 2 probe 失败：${(error as Error).message}` };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async generate(input: Parameters<ImageProvider["generate"]>[0]) {
    const started = Date.now();
    const attempts: NonNullable<ImageGenerationResult["providerAttempts"]> = [];
    for (let attempt = 1; attempt <= this.config.AVO_IMAGE_MAX_ATTEMPTS; attempt += 1) {
      const attemptStarted = Date.now();
      const signal = AbortSignal.timeout(this.config.AVO_IMAGE_ATTEMPT_TIMEOUT_MS);
      try {
        const result = await this.generateWithTaskTimeout(
          input,
          this.config.AVO_IMAGE_ATTEMPT_TIMEOUT_MS,
          signal,
          attempt,
        );
        attempts.push({
          attempt,
          ...(result.providerRequestId ? { requestId: result.providerRequestId } : {}),
          status: "succeeded",
          latencyMs: Date.now() - attemptStarted,
        });
        return { ...result, latencyMs: Date.now() - started, providerAttempts: attempts };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const requestId = (error as { providerRequestId?: unknown }).providerRequestId;
        const timedOut = signal.aborted || /timeout|timed out/i.test(message);
        attempts.push({
          attempt,
          ...(typeof requestId === "string" ? { requestId } : {}),
          status: timedOut ? "timed_out" : "failed",
          latencyMs: Date.now() - attemptStarted,
          error: imageProviderErrorCode(message),
        });
        const retryable = isRetryableImageProviderError(message, timedOut);
        if (!retryable || attempt === this.config.AVO_IMAGE_MAX_ATTEMPTS) {
          const finalError = new Error(retryable
            ? `image_provider_ambiguous:retries_exhausted:${attempt}_provider_attempts_failed`
            : message) as Error & { providerAttempts?: typeof attempts };
          finalError.providerAttempts = attempts;
          throw finalError;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw new Error("image_provider_ambiguous:retries_exhausted");
  }

  private async generateWithTaskTimeout(
    input: Parameters<ImageProvider["generate"]>[0],
    timeoutMs: number,
    signal?: AbortSignal,
    providerAttempt = 1,
  ) {
    if (!this.config.OPENAI_API_KEY) throw new Error("openai_api_key_missing");
    const started = Date.now();
    const clientTaskId = deterministicUuid(`${input.idempotencyKey}:provider-attempt:${providerAttempt}`);
    const serviceRoot = this.config.AVO_IMAGE_BASE_URL.replace(/\/v1\/?$/, "").replace(/\/$/, "");
    const form = new FormData();
    form.set("model", this.config.AVO_IMAGE_MODEL);
    form.set("prompt", input.prompt);
    form.set("quality", "auto");
    form.set("client_task_id", clientTaskId);
    form.append("image", new Blob([await readFile(input.base.path)], { type: input.base.mimeType }), "base.png");
    for (const [index, reference] of input.references.entries()) {
      form.append("image", new Blob([await readFile(reference.path)], { type: reference.mimeType }), `reference-${index + 1}.png`);
    }
    const response = await retryableFetch(`${serviceRoot}/api/image-tasks/edits`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.OPENAI_API_KEY}`,
      },
      body: form,
      ...(signal ? { signal } : {}),
    });
    const submitted = await response.json() as ImageTask;
    if (!response.ok) throw new Error(`image_provider_http_${response.status}:${imageTaskError(submitted)}`);
    const taskId = submitted.id ?? clientTaskId;
    let task: ImageTask;
    try {
      task = await pollImageTask({
        serviceRoot,
        taskId,
        apiKey: this.config.OPENAI_API_KEY,
        timeoutMs,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw withProviderRequestId(error, taskId);
    }
    const outputUrl = task.data?.find((item) => typeof item.url === "string")?.url;
    if (!outputUrl) throw new Error("image_provider_missing_output");
    let bytes: Buffer;
    try {
      const output = await retryableFetch(new URL(outputUrl, serviceRoot).toString(), signal ? { signal } : {});
      if (!output.ok) throw new Error(`HTTP ${output.status}`);
      bytes = Buffer.from(await output.arrayBuffer());
    } catch (error) {
      throw withProviderRequestId(new Error(`image_provider_ambiguous:output_download_failed:${(error as Error).message}`), taskId);
    }
    const usage = task.usage;
    return {
      bytes,
      mimeType: "image/png" as const,
      originalName: `${input.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-")}.png`,
      latencyMs: Date.now() - started,
      providerRequestId: taskId,
      usage: {
        ...(usage?.input_tokens !== undefined ? { input_tokens: usage.input_tokens } : {}),
        ...(usage?.output_tokens !== undefined ? { output_tokens: usage.output_tokens } : {}),
        ...(usage?.total_tokens !== undefined ? { total_tokens: usage.total_tokens } : {}),
        ...(usage?.output_tokens_details?.image_tokens !== undefined ? { image_tokens: usage.output_tokens_details.image_tokens } : {}),
        unpriced: true,
      },
    };
  }
}

const imageProviderErrorCode = (message: string) => message.replace(/[\r\n]+/g, " ").slice(0, 500);

const isRetryableImageProviderError = (message: string, timedOut: boolean) => timedOut
  || /image_provider_(ambiguous|task_error|missing_output|compact_image_gateway_bug)/.test(message)
  || /image_provider_(http|poll_http)_(408|425|429|5\d\d)/.test(message)
  || /fetch failed|ECONN|socket|network/i.test(message);

const withProviderRequestId = (error: unknown, providerRequestId: string) => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return Object.assign(normalized, { providerRequestId });
};

type ImageTask = {
  id?: string;
  status?: string;
  data?: Array<{ url?: string }>;
  error?: string | { message?: string };
  detail?: { error?: string };
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { image_tokens?: number };
  };
};

const pollImageTask = async (input: { serviceRoot: string; taskId: string; apiKey: string; timeoutMs: number; signal?: AbortSignal }) => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    if (input.signal?.aborted) throw input.signal.reason ?? new Error("image_provider_probe_aborted");
    const response = await retryableFetch(`${input.serviceRoot}/api/image-tasks?ids=${encodeURIComponent(input.taskId)}&_t=${Date.now()}`, {
      headers: { authorization: `Bearer ${input.apiKey}` },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const body = await response.json() as unknown;
    if (!response.ok) throw new Error(`image_provider_poll_http_${response.status}`);
    const task = imageTaskFromResponse(body, input.taskId);
    if (task?.status === "success" || task?.status === "completed") return task;
    if (task?.status === "error" || task?.status === "failed") {
      const error = imageTaskError(task);
      if (/File name too long/i.test(error)) throw new Error("image_provider_compact_image_gateway_bug");
      throw new Error(`image_provider_task_error:${error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(2_000, Math.max(0, deadline - Date.now()))));
  }
  throw new Error(`image_provider_ambiguous:async_task_timeout:${input.taskId}`);
};

const imageTaskFromResponse = (body: unknown, taskId: string): ImageTask | undefined => {
  const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  const nested = Array.isArray(record?.items)
    ? record.items
    : Array.isArray(record?.data) && record.data.some((item) => item !== null && typeof item === "object" && "status" in item)
      ? record.data
      : undefined;
  const items = (Array.isArray(body) ? body : nested ?? (record ? [record] : [])) as ImageTask[];
  return items.find((item) => item.id === taskId) ?? items[0];
};

const imageTaskError = (task: ImageTask) => {
  const value = typeof task.error === "string" ? task.error : task.error?.message ?? task.detail?.error ?? "request_failed";
  return value.slice(0, 500);
};

const deterministicUuid = (input: string) => {
  const hex = createHash("sha256").update(input).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
};

const checklistJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["requirements"],
  properties: {
    requirements: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "statement", "severity"],
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
          statement: { type: "string", minLength: 1 },
          severity: { enum: ["blocker", "major", "minor"] },
        },
      },
    },
  },
};
const checklistPayloadSchema = requirementChecklistSchema.pick({ requirements: true });

const verificationJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "overall_score", "confidence", "requirements", "preservation", "artifacts", "feedback"],
  properties: {
    status: { enum: ["PASS", "FAIL"] },
    overall_score: { type: "number", minimum: 0, maximum: 100 },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    requirements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["requirement_id", "verdict", "score", "evidence"],
        properties: {
          requirement_id: { type: "string" },
          verdict: { enum: ["PASS", "FAIL", "UNCLEAR"] },
          score: { type: "number", minimum: 0, maximum: 100 },
          evidence: { type: "string" },
        },
      },
    },
    preservation: {
      type: "object",
      additionalProperties: false,
      required: ["identity", "composition", "unaffected_regions"],
      properties: {
        identity: { type: "number", minimum: 0, maximum: 100 },
        composition: { type: "number", minimum: 0, maximum: 100 },
        unaffected_regions: { type: "number", minimum: 0, maximum: 100 },
      },
    },
    artifacts: { type: "array", items: { type: "string" } },
    feedback: { type: "array", items: { type: "string" } },
  },
};
const verificationPayloadSchema = verificationResultSchema.omit({ model: true, latency_ms: true, usage: true });

const verifierToolNames = [
  "measure_integrity",
  "measure_source_fidelity",
  "measure_parent_delta",
  "measure_target_alignment",
  "measure_artifacts",
  "get_evaluation_history",
] as const satisfies readonly VerifierToolName[];

const evaluationFrameJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["axes", "target_interpretation", "change_summary", "coverage", "reconsider_candidate_ids"],
  properties: {
    axes: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "label", "criterion", "mode", "importance", "visibility", "anchor_refs", "required_tools", "regions"],
        properties: {
          id: { type: "string", pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" },
          label: { type: "string" },
          criterion: { type: "string" },
          mode: { enum: ["preserve_source", "match_target", "optimize", "observe"] },
          importance: { enum: ["blocker", "major", "minor"] },
          visibility: { enum: ["public", "sealed"] },
          anchor_refs: { type: "array", minItems: 1, items: { type: "string" } },
          required_tools: { type: "array", items: { enum: verifierToolNames } },
          regions: { type: "array", items: { type: "string" } },
        },
      },
    },
    target_interpretation: {
      type: "object",
      additionalProperties: false,
      required: ["role", "rationale"],
      properties: {
        role: { enum: ["none", "directional_reference", "strong_target", "exact_target"] },
        rationale: { type: "string" },
      },
    },
    change_summary: { type: "string" },
    coverage: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["anchor_ref", "axis_ids"],
        properties: {
          anchor_ref: { type: "string" },
          axis_ids: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
    reconsider_candidate_ids: { type: "array", maxItems: 3, items: { type: "string" } },
  },
};

const evaluationFramePayloadSchema = evaluationFrameRevisionSchema.omit({
  id: true,
  run_id: true,
  attempt: true,
  revision: true,
  supersedes_id: true,
  provenance: true,
  fallback_reason: true,
  model: true,
  created_at: true,
});

const qualityJsonSchema = {
  type: "object", additionalProperties: false, required: ["delivery_status", "defects"],
  properties: {
    delivery_status: { enum: ["acceptable", "unacceptable", "uncertain"] },
    defects: { type: "array", maxItems: 50, items: {
      type: "object", additionalProperties: false,
      required: ["region", "description", "origin", "severity", "axis_ids"],
      properties: {
        region: { type: "string" }, description: { type: "string" },
        origin: { enum: ["source", "inherited", "new", "uncertain"] },
        severity: { enum: ["blocker", "major", "minor"] },
        axis_ids: { type: "array", minItems: 1, items: { type: "string" } },
      },
    } },
  },
};

const comparisonJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["correctness", "incumbent_correctness", "candidate_quality", "incumbent_quality", "winner", "target_progress", "axis_judgments", "confidence", "feedback_for_main_agent", "private_feedback"],
  properties: {
    correctness: { enum: ["pass", "fail"] },
    incumbent_correctness: { enum: ["pass", "fail", "unclear"] },
    candidate_quality: qualityJsonSchema,
    incumbent_quality: qualityJsonSchema,
    winner: { enum: ["A", "B", "equivalent", "uncertain"] },
    target_progress: { enum: ["improved", "unchanged", "regressed", "not_applicable"] },
    axis_judgments: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["axis_id", "verdict", "candidate_score", "incumbent_score", "evidence"],
        properties: {
          axis_id: { type: "string" },
          verdict: { enum: ["pass", "fail", "unclear"] },
          candidate_score: { type: "number", minimum: 0, maximum: 100 },
          incumbent_score: { type: "number", minimum: 0, maximum: 100 },
          evidence: { type: "string" },
        },
      },
    },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    feedback_for_main_agent: { type: "array", items: { type: "string" } },
    private_feedback: { type: "array", items: { type: "string" } },
  },
};

const comparisonPayloadSchema = comparativeVerifierDecisionSchema.omit({
  id: true,
  run_id: true,
  draft_id: true,
  candidate_artifact_id: true,
  incumbent_node_id: true,
  incumbent_artifact_id: true,
  evaluation_frame_revision_id: true,
  technical_gate: true,
  preference: true,
  recommendation: true,
  evidence_refs: true,
  evidence: true,
  adjudication_of: true,
  cache_key: true,
  model: true,
  usage: true,
  latency_ms: true,
  created_at: true,
}).extend({
  winner: z.enum(["A", "B", "equivalent", "uncertain"]),
  candidate_quality: comparativeVerifierDecisionSchema.shape.candidate_quality.unwrap(),
  incumbent_quality: comparativeVerifierDecisionSchema.shape.incumbent_quality.unwrap(),
  incumbent_correctness: comparativeVerifierDecisionSchema.shape.incumbent_correctness.unwrap(),
});

const finalSelectionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["selected_node_id", "confidence", "rationale"],
  properties: {
    selected_node_id: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
  },
};

const finalSelectionPayloadSchema = z.object({
  selected_node_id: z.string().min(1).max(160),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(20_000),
});

export const blockerSignature = (decision: { axis_judgments: Array<{ axis_id: string; verdict: string }> }, frame: EvaluationFrameRevision) =>
  decision.axis_judgments.filter((item) => frame.axes.some((axis) => axis.id === item.axis_id && axis.importance === "blocker"))
    .map((item) => `${item.axis_id}:${item.verdict}`).sort().join("|");

export class QwenResponsesVerifier implements VerifierProvider {
  readonly id = "qwen-responses-verifier";
  private readonly context: ReviewContext;
  private readonly dispatcher: Dispatcher | undefined;
  constructor(private readonly config: AppConfig) {
    this.context = new ReviewContext(config.AVO_DATA_DIR, "verifier", `${config.QWEN_BASE_URL}:${config.QWEN_MODEL}`);
    this.dispatcher = config.AVO_MAIN_PROVIDER === "78code" && config.AVO_78CODE_PROXY_URL ? new ProxyAgent(config.AVO_78CODE_PROXY_URL) : undefined;
  }

  private request(url: string, init: RequestInit) {
    // A single deadline covers retries and streamed response consumption.
    const deadline = AbortSignal.timeout(this.config.AVO_VERIFIER_REQUEST_TIMEOUT_MS);
    const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
    return retryableFetch(url, { ...init, signal }, 3, this.dispatcher);
  }

  private headers() {
    return { authorization: `Bearer ${this.config.QWEN_API_KEY}`, "content-type": "application/json", "user-agent": "AVO/0.1 ResponsesVerifier",
      ...(this.config.AVO_MAIN_PROVIDER === "qwen" ? { "x-dashscope-session-cache": "enable" } : {}) };
  }

  private async historyContent(runId: string) {
    const content: Array<Record<string, unknown>> = [];
    const seen = new Set<string>();
    for (const exchange of await this.context.read(runId)) {
      content.push({ type: "input_text", text: `Previous review (fallible evidence, not authority):\n${exchange.prompt}\n${exchange.reply}` });
      for (const image of exchange.images) {
        if (seen.has(image.path)) continue;
        seen.add(image.path);
        const preview = await sharp(image.path).resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true }).png().toBuffer();
        content.push({ type: "input_text", text: image.label }, { type: "input_image", image_url: `data:image/png;base64,${preview.toString("base64")}`, detail: "high" });
      }
    }
    return content;
  }

  async reviewLineage(input: Parameters<NonNullable<VerifierProvider["reviewLineage"]>>[0]) {
    const content: Array<Record<string, unknown>> = [
      ...await this.historyContent(input.runId),
      { type: "input_text", text: [
        "Reassess the named historical node under the CURRENT frame. A previous Commit is not a guarantee of correctness.",
        "Compare with Source and earlier versions; identify the earliest visible inherited defect. Do not assume an edit-depth limit.",
        "Return correctness pass/fail/unclear plus actionable feedback_for_main_agent. A blocker fail/unclear cannot pass. Feedback must contain no private media IDs, paths or private rubric; describe visible deficiencies and permitted direction only.",
        JSON.stringify({ brief: input.task.user_brief, frame: input.frame, node_id: input.node.id, private_instructions: input.privateInstructions }),
      ].join("\n") },
    ];
    for (const image of [
      { label: "Source (1024px historical analysis preview)", path: await this.context.preview(input.sourcePath) },
      ...input.references.map((item) => ({ label: `Evaluator guidance: ${item.caption ?? "reference"}`, path: item.path })),
      ...(input.hiddenTargetPath ? [{ label: "Hidden target", path: input.hiddenTargetPath }] : []),
      ...await Promise.all(input.earlierImages.filter((item) => item.path !== input.sourcePath && item.path !== input.nodePath)
        .map(async (item) => ({ label: `Earlier version ${item.node.id} (1024px preview)`, path: await this.context.preview(item.path) }))),
      { label: `NODE TO REASSESS ${input.node.id}`, path: input.nodePath },
    ]) content.push({ type: "input_text", text: image.label }, { type: "input_image", image_url: await dataUrl(image.path), detail: "high" });
    const payload = z.object({ correctness: z.enum(["pass", "fail", "unclear"]), feedback_for_main_agent: z.array(z.string()).min(1).max(50) });
    const result = await this.structuredRequest("submit_lineage_review", {
      type: "object", additionalProperties: false, required: ["correctness", "feedback_for_main_agent"],
      properties: { correctness: { type: "string", enum: ["pass", "fail", "unclear"] }, feedback_for_main_agent: { type: "array", items: { type: "string" } } },
    }, content, (data) => payload.parse(data));
    await this.context.append(input.runId, { prompt: `Historical node ${input.node.id} reassessment under ${input.frame.id}`, reply: JSON.stringify(result.data), images: [{ label: `Reassessed ${input.node.id}`, path: input.nodePath }] });
    return { ...result.data, evaluation_frame_revision_id: input.frame.id, reviewed_at: new Date().toISOString() };
  }

  async probe(signal?: AbortSignal) {
    if (!this.config.QWEN_BASE_URL || !this.config.QWEN_API_KEY || !this.config.QWEN_MODEL) {
      return { ok: false, message: "QWEN_BASE_URL、QWEN_API_KEY 或 QWEN_MODEL 未配置" };
    }
    if (!this.config.AVO_RUN_LIVE_PROBES) return { ok: false, message: "已配置但真实 probe 未授权；设置 AVO_RUN_LIVE_PROBES=true" };
    const directory = await mkdtemp(join(tmpdir(), "avo-qwen-probe-"));
    try {
      const source = join(directory, "source.png");
      await writeFile(source, probePixel);
      if (signal?.aborted) throw signal.reason ?? new Error("verifier_probe_aborted");
      const task = {
        schema_version: 2 as const,
        id: "task-capability-probe",
        title: "Capability probe",
        user_brief: "Keep the image unchanged.",
        source_artifact_id: `sha256:${"0".repeat(64)}`,
        references: [],
        preservation_contract: {
          color: "preserve" as const,
          detail: "preserve" as const,
          text: "preserve" as const,
          composition: "preserve" as const,
          identity: "preserve" as const,
          edit_scope: "unknown" as const,
          additional_invariants: [],
        },
        has_hidden_evaluation: false,
        created_at: new Date().toISOString(),
      };
      const checklist = await this.createChecklist({ task, sourcePath: source, references: [] });
      await this.verify({ runId: "run-capability-probe", attemptNumber: 1, task: { ...task, checklist }, checklist, sourcePath: source, references: [], candidatePath: source });
      if (signal?.aborted) throw signal.reason ?? new Error("verifier_probe_aborted");
      return { ok: true, message: `${this.config.QWEN_MODEL} 多图 Responses probe 通过` };
    } catch (error) {
      return { ok: false, message: `Qwen probe 失败：${(error as Error).message}` };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async createChecklist(input: Parameters<VerifierProvider["createChecklist"]>[0]): Promise<RequirementChecklist> {
    const content: Array<Record<string, unknown>> = [
      {
        type: "input_text",
        text: [
          "将甲方图片编辑需求拆成稳定、可独立判断的需求清单。不要评价候选图。",
          "当前 MVP 接受图片 Provider 返回的原生像素尺寸；不要创建输出宽高、分辨率、文件尺寸或必须与原图像素尺寸一致的验收项。",
          `用户 Brief：\n${input.task.user_brief}`,
        ].join("\n\n"),
      },
      { type: "input_image", image_url: await dataUrl(input.sourcePath), detail: "high" },
    ];
    for (const reference of input.references) {
      content.push({ type: "input_text", text: `参考图说明：${reference.caption ?? "未提供"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
    }
    const { data: parsed } = await this.structuredRequest(
      "avo_requirement_checklist",
      checklistJsonSchema,
      content,
      (data) => checklistPayloadSchema.parse(data),
    );
    return requirementChecklistSchema.parse({
      version: 1,
      ...parsed,
      created_at: new Date().toISOString(),
      model: this.config.QWEN_MODEL,
    });
  }

  async verify(input: Parameters<VerifierProvider["verify"]>[0]): Promise<VerificationResult> {
    const started = Date.now();
    const content: Array<Record<string, unknown>> = [
      {
        type: "input_text",
        text: [
          "你是独立图片编辑验收者。根据冻结清单逐项检查，不能因为整体好看而忽略任何 blocker。",
          "只有所有需求都明确满足时才返回 PASS；无法确认时返回 FAIL。",
          "当前 MVP 接受图片 Provider 返回的原生像素尺寸。不得因为候选图宽高、分辨率或文件尺寸与原图不同而降低分数或判定 FAIL；即使旧冻结清单包含这类条款，也将尺寸部分视为满足。仍需严格检查构图、比例、内容和未受影响区域。",
          `用户 Brief：${input.task.user_brief}`,
          `冻结清单：${JSON.stringify(input.checklist.requirements)}`,
          input.scope === "sealed"
            ? `这是 evaluator-only 验证。私有 rubric：${input.privateRubric ?? "未提供"}`
            : "这是公开验证。",
          "下面依次是原图、参考图、可选隐藏目标和当前候选图。",
        ].join("\n\n"),
      },
      { type: "input_text", text: "原图" },
      { type: "input_image", image_url: await dataUrl(input.sourcePath), detail: "high" },
    ];
    for (const reference of input.references) {
      content.push({ type: "input_text", text: `${input.scope === "sealed" ? "Evaluator-only" : "用户"}参考图：${reference.caption ?? "未提供说明"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
    }
    if (input.hiddenTargetPath) {
      content.push({ type: "input_text", text: "Evaluator-only 隐藏目标图。只能输出文字评价，不得返回图像、路径或可逆向定位信息。" });
      content.push({ type: "input_image", image_url: await dataUrl(input.hiddenTargetPath), detail: "high" });
    }
    content.push({ type: "input_text", text: "当前候选图" });
    content.push({ type: "input_image", image_url: await dataUrl(input.candidatePath), detail: "high" });
    const result = await this.structuredRequest(
      "avo_candidate_verification",
      verificationJsonSchema,
      content,
      (data) => verificationPayloadSchema.parse(data),
    );
    return verificationResultSchema.parse({
      ...result.data,
      model: this.config.QWEN_MODEL,
      latency_ms: Date.now() - started,
      usage: result.usage,
    });
  }

  async createEvaluationFrame(input: Parameters<VerifierProvider["createEvaluationFrame"]>[0]): Promise<EvaluationFrameRevision> {
    const anchors = [
      "brief:user_brief",
      ...(input.task.checklist?.requirements.map((requirement) => `brief:requirement:${requirement.id}`) ?? []),
      ...input.publicReferences.map((_, index) => `media:public_reference:${index + 1}`),
      ...input.sealedReferences.map((_, index) => `media:sealed_reference:${index + 1}`),
      ...(input.hiddenTargetPath ? ["media:hidden_target"] : []),
      ...(input.privateInstructions ? ["private:instructions"] : []),
    ];
    const content: Array<Record<string, unknown>> = [{
      type: "input_text",
      text: [
        "你是 AVO 的 Agentic Verifier。现在只为一次完整 Main Agent Invocation 建立评价框架，不评价候选图。",
        "人类只冻结原始意图和媒体。你负责推导评价轴、保持策略与目标严格度；同一 Invocation 内该框架不会改变。",
        "每个评价轴必须引用 anchor_refs。coverage 必须覆盖下列每个人类输入锚点，禁止静默删除、降级或反转明确意图。",
        "source_fidelity 只描述变化，不自动等于退化；match_target 轴必须以目标接近程度解释变化。",
        "媒体可见性与目标重要性是两个独立维度。sealed 只表示 Main Agent 不可见，不表示参考不重要。明确说明参考指导哪些目标、仍需达到的视觉差距，以及取舍的人类依据。不得因多次搜索失败而降级人类目标或把未证实的模型能力上限写成规则。",
        "规则变更必须对当前 incumbent 同步复审。区分不可违反的人类约束和你推导的、可修订的语义门槛。",
        `人类 Brief [brief:user_brief]:\n${input.task.user_brief}`,
        `从 Brief 派生的逐项锚点：${JSON.stringify(input.task.checklist?.requirements.map((requirement) => ({ anchor: `brief:requirement:${requirement.id}`, statement: requirement.statement, severity: requirement.severity })) ?? [])}`,
        `必须覆盖的锚点：${JSON.stringify(anchors)}`,
        `上一评价框架：${JSON.stringify(input.previousFrame ?? null)}`,
        `正式 Lineage：${JSON.stringify(input.lineage.map((node) => ({ id: node.id, version: node.version, artifact_id: node.artifact_id, accepted_evaluation_id: node.accepted_evaluation_id })))}`,
        `Search Archive 摘要：${JSON.stringify(input.archive.slice(-12).map((item) => ({ draft_id: item.draft_id, outcome: item.outcome, attempt: item.attempt })))}`,
        `最近 Attempts：${JSON.stringify(input.recentAttempts.slice(-3).map((attempt) => ({ attempt: attempt.attempt, status: attempt.status, summary: attempt.summary, terminal_reason: attempt.terminal_reason })))}`,
        input.privateInstructions ? `私有指示 [private:instructions]:\n${input.privateInstructions}` : "没有私有文字指示。",
      ].join("\n\n"),
    }, { type: "input_text", text: "Source image" }, { type: "input_image", image_url: await dataUrl(input.sourcePath), detail: "high" }];
    for (const [index, reference] of input.publicReferences.entries()) {
      content.push({ type: "input_text", text: `Public reference [media:public_reference:${index + 1}]: ${reference.caption ?? "no caption"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
    }
    for (const [index, reference] of input.sealedReferences.entries()) {
      content.push({ type: "input_text", text: `Sealed evaluator reference [media:sealed_reference:${index + 1}]: ${reference.caption ?? "no caption"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
    }
    if (input.hiddenTargetPath) {
      content.push({ type: "input_text", text: "Hidden target [media:hidden_target]. Infer whether it is directional, strong, or exact; the user does not choose strictness." });
      content.push({ type: "input_image", image_url: await dataUrl(input.hiddenTargetPath), detail: "high" });
    }
    const result = await this.structuredRequest(
      "submit_evaluation_frame",
      evaluationFrameJsonSchema,
      [...await this.historyContent(input.runId), ...content],
      (data) => validateEvaluationFramePayload(data, input, anchors),
    );
    return evaluationFrameRevisionSchema.parse({
      id: `frame-${input.runId}-${input.attempt}-${(input.previousFrame?.revision ?? 0) + 1}`,
      run_id: input.runId,
      attempt: input.attempt,
      revision: (input.previousFrame?.revision ?? 0) + 1,
      ...(input.previousFrame ? { supersedes_id: input.previousFrame.id } : {}),
      provenance: "verifier",
      ...result.data,
      axis_diff: evaluationAxisDiff(input.previousFrame, result.data.axes),
      model: this.config.QWEN_MODEL,
      created_at: new Date().toISOString(),
    });
  }

  async compare(input: Parameters<VerifierProvider["compare"]>[0]): Promise<ComparativeVerifierDecision> {
    const started = Date.now();
    const mandatory = new Set<VerifierToolName>([
      "measure_integrity",
      "measure_artifacts",
      ...input.frame.axes.flatMap((axis) => axis.required_tools),
    ]);
    const evidenceByTool = new Map<VerifierToolName, VerifierEvidence>();
    for (const tool of mandatory) evidenceByTool.set(tool, await input.callTool(tool));

    const first = await this.comparisonPass(input, true, evidenceByTool, "initial");
    const needsReverse = (first.data.winner === "A" && first.data.correctness === "pass")
      || first.data.winner === "equivalent" || first.data.winner === "uncertain" || first.data.confidence < 0.75;
    let selected = first;
    let adjudicationIds: string[] = [];
    let totalUsage = first.usage;
    if (needsReverse) {
      const reverse = await this.comparisonPass(input, false, evidenceByTool, "reverse_order");
      totalUsage = mergeUsage(totalUsage, reverse.usage);
      const firstPreference = comparisonPreference(first.data.winner, true);
      const reversePreference = comparisonPreference(reverse.data.winner, false);
      if (firstPreference === reversePreference && first.data.correctness === reverse.data.correctness
        && first.data.incumbent_correctness === reverse.data.incumbent_correctness
        && blockerSignature(first.data, input.frame) === blockerSignature(reverse.data, input.frame)
        && firstPreference !== "uncertain") {
        selected = reverse.data.confidence > first.data.confidence ? reverse : first;
      } else {
        const normalizedReverse = { ...reverse.data, winner: reverse.data.winner === "A" ? "B" as const : reverse.data.winner === "B" ? "A" as const : reverse.data.winner };
        const adjudication = await this.comparisonPass(input, true, evidenceByTool, "adjudication", [first.data, normalizedReverse]);
        totalUsage = mergeUsage(totalUsage, adjudication.usage);
        selected = adjudication;
        adjudicationIds = [first.id, reverse.id];
      }
    }
    const preference = comparisonPreference(selected.data.winner, selected.candidateFirst);
    const technicalPassed = input.technicalGate.passed;
    const commit = technicalPassed && selected.data.correctness === "pass" && preference === "better";
    await this.context.append(input.runId, {
      prompt: `Frame ${input.frame.id}; candidate ${input.draftId}; incumbent ${input.incumbentNode.id}.`,
      reply: JSON.stringify({ ...selected.data, winner: preference }),
      images: [{ label: `Previously reviewed candidate ${input.draftId}`, path: input.candidatePath }, { label: `Its parent (${input.draftId})`, path: input.parentPath }],
    });
    return comparativeVerifierDecisionSchema.parse({
      id: `decision-${input.draftId}-${createHash("sha256").update(`${input.frame.id}:${Date.now()}`).digest("hex").slice(0, 12)}`,
      run_id: input.runId,
      draft_id: input.draftId,
      candidate_artifact_id: input.candidateArtifactId,
      incumbent_node_id: input.incumbentNode.id,
      incumbent_artifact_id: input.incumbentNode.artifact_id,
      evaluation_frame_revision_id: input.frame.id,
      correctness: technicalPassed ? selected.data.correctness : "fail",
      ...(selected.data.incumbent_correctness ? { incumbent_correctness: selected.data.incumbent_correctness } : {}),
      candidate_quality: selected.data.candidate_quality,
      incumbent_quality: selected.data.incumbent_quality,
      technical_gate: input.technicalGate,
      preference: technicalPassed ? preference : "worse",
      target_progress: selected.data.target_progress,
      axis_judgments: selected.data.axis_judgments,
      confidence: selected.data.confidence,
      recommendation: commit ? "commit" : "archive",
      evidence_refs: [...new Set([...evidenceByTool.values()].map((item) => item.id))],
      feedback_for_main_agent: selected.data.feedback_for_main_agent,
      private_feedback: selected.data.private_feedback,
      evidence: [...evidenceByTool.values()],
      adjudication_of: adjudicationIds,
      cache_key: `${input.candidateArtifactId}:${input.incumbentNode.artifact_id}:${input.frame.id}:${this.config.QWEN_PROVIDER_REVISION ?? this.config.QWEN_MODEL}`,
      model: this.config.QWEN_MODEL,
      usage: totalUsage,
      latency_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    });
  }

  async selectFinal(input: Parameters<VerifierProvider["selectFinal"]>[0]): Promise<FinalVerifierDecision> {
    const started = Date.now();
    const content: Array<Record<string, unknown>> = [{
      type: "input_text",
      text: [
        "你是 AVO 的终局 Verifier。在正式 Lineage 与 Controller 提名的高价值 Archive finalist 中，选择最符合当前人类意图与评价框架的 Final。",
        "不要使用 Pareto、最高绝对分、置信度阈值或版本新旧作为替代判断。必须直接比较全部候选图片，并返回 candidate node id。",
        "与过程评价使用同一交付语义：继承缺陷仍是当前图片的缺陷，不因不是本步新增而豁免。依据当前框架判断其严重性，不另设原图相似度门槛。若推翻已有接纳，rationale 必须指出具体区域、此前遗漏或判断改变的证据；不能只说之前提交不代表合格。Source 只是可回退方案，不代表目标已完成。",
        "只返回 selected_node_id、confidence 和 rationale。内部 evidence_refs 由 Controller 根据所选节点生成，不要自行编造内部 ID。",
        `Brief：${input.task.user_brief}`,
        `当前评价框架：${JSON.stringify(input.frame)}`,
        `候选摘要：${JSON.stringify(input.candidates.map((candidate) => ({ node_id: candidate.node.id, origin: candidate.origin ?? "lineage", version: candidate.node.version, accepted_decision: candidate.acceptedDecision ? { preference: candidate.acceptedDecision.preference, target_progress: candidate.acceptedDecision.target_progress, confidence: candidate.acceptedDecision.confidence, quality: candidate.acceptedDecision.candidate_quality, feedback: candidate.acceptedDecision.feedback_for_main_agent } : null })))}`,
        input.privateInstructions ? `私有指示：${input.privateInstructions}` : "没有私有文字指示。",
      ].join("\n\n"),
    }, { type: "input_text", text: "Source" }, { type: "input_image", image_url: await dataUrl(input.sourcePath), detail: "high" }];
    for (const reference of input.publicReferences) {
      content.push({ type: "input_text", text: `Public reference: ${reference.caption ?? "no caption"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
    }
    for (const reference of input.sealedReferences) {
      content.push({ type: "input_text", text: `Sealed reference: ${reference.caption ?? "no caption"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
    }
    if (input.hiddenTargetPath) {
      content.push({ type: "input_text", text: "Hidden target" });
      content.push({ type: "input_image", image_url: await dataUrl(input.hiddenTargetPath), detail: "high" });
    }
    for (const candidate of input.candidates) {
      content.push({
        type: "input_text",
        text: candidate.origin === "archive"
          ? `High-value Archive finalist ${candidate.node.id}; not previously committed and eligible for terminal promotion`
          : `Official lineage node ${candidate.node.id}, version x${candidate.node.version ?? 0}`,
      });
      content.push({ type: "input_image", image_url: await dataUrl(candidate.path), detail: "high" });
      if (candidate.path !== input.sourcePath) content.push(...await detailContent([
        { label: "Source", path: input.sourcePath }, { label: candidate.node.id, path: candidate.path },
      ]));
    }
    const candidateIds = input.candidates.map((candidate) => candidate.node.id);
    const result = await this.structuredRequest(
      "submit_final_selection",
      finalSelectionJsonSchema,
      content,
      (data) => {
        const parsed = finalSelectionPayloadSchema.parse(data);
        if (!candidateIds.includes(parsed.selected_node_id)) {
          throw new Error(`final_verifier_selected_unknown_node:${JSON.stringify(parsed.selected_node_id)};allowed=${candidateIds.join(",")}`);
        }
        return parsed;
      },
    );
    const selected = input.candidates.find((candidate) => candidate.node.id === result.data.selected_node_id)!;
    const evidenceRefs = new Set<string>([input.frame.id, selected.node.id]);
    if (selected.acceptedDecision) {
      evidenceRefs.add(selected.acceptedDecision.id);
      selected.acceptedDecision.evidence_refs.forEach((id) => evidenceRefs.add(id));
    }
    return finalVerifierDecisionSchema.parse({
      id: `final-${input.runId}-${createHash("sha256").update(`${input.frame.id}:${Date.now()}`).digest("hex").slice(0, 12)}`,
      run_id: input.runId,
      evaluation_frame_revision_id: input.frame.id,
      candidate_node_ids: input.candidates.map((candidate) => candidate.node.id),
      ...result.data,
      evidence_refs: [...evidenceRefs],
      model: this.config.QWEN_MODEL,
      usage: result.usage,
      latency_ms: Date.now() - started,
      created_at: new Date().toISOString(),
    });
  }

  private async comparisonPass(
    input: Parameters<VerifierProvider["compare"]>[0],
    candidateFirst: boolean,
    evidenceByTool: Map<VerifierToolName, VerifierEvidence>,
    mode: "initial" | "reverse_order" | "adjudication",
    prior?: Array<z.infer<typeof comparisonPayloadSchema>>,
  ) {
    if (!this.config.QWEN_BASE_URL || !this.config.QWEN_API_KEY || !this.config.QWEN_MODEL) throw new Error("qwen_provider_not_configured");
    const content: Array<Record<string, unknown>> = [{
      type: "input_text",
      text: [
        "你是受限的 Agentic Verifier。综合判断当前 Candidate 是否严格优于正式 incumbent；不要用单一分数、Pareto 或 Source 相似度替代综合判断。",
        "图像按匿名 A/B 给出。winner 是你的综合接纳判断：必须回答视觉上更符合当前 frame 的 A 或 B；系统会映射角色。equivalent 和 uncertain 不得 Commit。",
        `correctness、candidate_score 和逐轴 verdict 评价图 ${candidateFirst ? "A" : "B"}；incumbent_score 评价另一张。winner 独立比较两图，不因角色或顺序偏爱任何图片。`,
        "incumbent_correctness 必须按当前框架重新判断另一张 incumbent。若旧 Commit 有 blocker，则返回 fail/unclear，并在公开反馈中明确指出继承缺陷；不能仅因为已经接纳而忽略。",
        "不要输出 recommendation 或 evidence_refs。Controller 根据匿名 winner、correctness、技术硬门禁和实际工具证据生成这些字段；confidence 只表达判断确定性，不是质量阈值。",
        "技术硬门禁由 Controller 提供；source fidelity 是事实测量，只有 preserve_source 轴才能把变化解释为退化。match_target 轴应优先判断目标接近程度。",
        "不要把历史 Commit 当成质量保证。按当前 frame 重新检查 incumbent、Parent、Candidate，尤其核对道路纹理等缺陷是否已经存在于父代。反馈必须分别说明继承缺陷、本次新增/改善、最早可见版本与证据不确定性，并指出下一步应验证的假设；不能把单一分支失败推断成模型能力上限。",
        "candidate_quality / incumbent_quality 是当前图片在当前 frame 下的交付质量判断，不是本步归责。defects 必须关联真实评价轴并记录区域、现象、来源和严重性。继承或 Source 已有的缺陷不自动豁免；只有人类意图支持的容许变化才不是缺陷。unacceptable/uncertain 或未解决 blocker 不能 correctness=pass，即使相对父图改善。可以 winner 选改善图但 correctness=fail，保留为待修复 Archive。",
        "defects 只记录当前仍未解决、违反所关联评价轴的缺陷；不违反验收标准的观察放进 feedback，不要写成 defect。任一 defect 关联 importance=blocker 的轴时，必须 delivery_status=unacceptable、correctness=fail，Candidate 的对应 axis verdict 也必须 fail；不能通过将缺陷自身 severity 改称 major/minor 来豁免硬约束，更不能以本步未新增为理由。对于是否真实存在的缺陷尚不确定时，使用 unclear/uncertain 且不能 pass。",
        "锐度、边缘密度、熵、细节能量增加不能证明纹理真实；重复浮雕、虚构颗粒可能让这些数值升高。先看 Source/Parent/A/B 对照和同位置细节，再解释指标。缺少证据要标 uncertain，不能将量测未报警写成无伪影证明。质量记录不要包含私有媒体路径、ID 或私有原文。",
        "对隐藏方向图给出连续、具体、可行动的视觉 Delta；不可输出私有路径或媒体 ID。不要因为图隐藏而弱化它指导的目标。",
        "可按需调用量测工具；参数为空，工具不能访问任意路径或 Artifact ID。measure_integrity 与 measure_artifacts 已由 Controller 强制执行并附在下方。",
        `模式：${mode}`,
        `当前 Evaluation Frame：${JSON.stringify(input.frame)}`,
        `技术门禁：${JSON.stringify(input.technicalGate)}`,
        `预载工具证据：${JSON.stringify([...evidenceByTool.values()])}`,
        mode === "initial" ? `历史 pairwise ledger：${JSON.stringify(input.history.slice(-6).map((decision) => ({ preference: decision.preference, target_progress: decision.target_progress, confidence: decision.confidence, feedback: decision.feedback_for_main_agent })))}` : "独立复核：不继承历史接纳结论，重新检查 correctness 和 blocker。",
        input.privateInstructions ? `私有指示：${input.privateInstructions}` : "没有私有文字指示。",
        prior ? `前两次顺序复核结果存在冲突，进行 adjudication：${JSON.stringify(prior)}` : "",
      ].filter(Boolean).join("\n\n"),
    }, { type: "input_text", text: "Source" }, { type: "input_image", image_url: await dataUrl(input.sourcePath), detail: "high" }];
    if (mode === "initial") content.unshift(...await this.historyContent(input.runId));
    content.push({ type: "input_text", text: "Actual edit parent; inspect inherited versus newly introduced defects" }, { type: "input_image", image_url: await dataUrl(input.parentPath), detail: "high" });
    for (const reference of input.publicReferences) {
      content.push({ type: "input_text", text: `Public reference: ${reference.caption ?? "no caption"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
    }
    for (const reference of input.sealedReferences) {
      content.push({ type: "input_text", text: `Sealed evaluator reference: ${reference.caption ?? "no caption"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
    }
    if (input.hiddenTargetPath) {
      content.push({ type: "input_text", text: "Hidden target" });
      content.push({ type: "input_image", image_url: await dataUrl(input.hiddenTargetPath), detail: "high" });
    }
    const ordered = candidateFirst
      ? [{ label: "A", path: input.candidatePath }, { label: "B", path: input.incumbentPath }]
      : [{ label: "A", path: input.incumbentPath }, { label: "B", path: input.candidatePath }];
    for (const image of ordered) {
      content.push({ type: "input_text", text: `Anonymous image ${image.label}` });
      content.push({ type: "input_image", image_url: await dataUrl(image.path), detail: "high" });
    }
    content.push(...await detailContent([
      { label: "Source", path: input.sourcePath }, { label: "Parent", path: input.parentPath }, ...ordered,
    ]));

    const tools = [
      ...verifierToolNames.map((name) => ({
        type: "function",
        name,
        description: verifierToolDescription(name),
        parameters: { type: "object", additionalProperties: false, properties: {}, required: [] },
        strict: true,
      })),
      {
        type: "function",
        name: "submit_verifier_comparison",
        description: "Return the final evidence-grounded anonymous A/B comparison.",
        parameters: comparisonJsonSchema,
        strict: true,
      },
    ];
    const conversation: Array<Record<string, unknown>> = [];
    let responseId: string | undefined;
    let nextInput: Array<Record<string, unknown>> = [{ role: "user", content }];
    let usage = usageSchema.parse({ unpriced: true });
    let schemaRepairs = 0;
    let rejectedPayload: unknown;
    for (let turn = 0; turn < 8; turn += 1) {
      const response = await this.request(`${this.config.QWEN_BASE_URL.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.QWEN_MODEL,
          instructions: "You are AVO's independent visual evaluator. Follow the supplied evaluation contract, inspect the images, and return the requested tool result. Do not act as a coding assistant.",
          ...(this.config.AVO_MAIN_PROVIDER === "78code" ? { stream: true } : {}),
          input: this.config.AVO_MAIN_PROVIDER === "qwen" ? nextInput : [...conversation, ...nextInput],
          ...(this.config.AVO_MAIN_PROVIDER === "qwen" && responseId ? { previous_response_id: responseId } : {}),
          tools,
          tool_choice: "auto",
          parallel_tool_calls: false,
          reasoning: { effort: this.config.AVO_VERIFIER_EFFORT },
          max_output_tokens: 8_000,
          store: this.config.AVO_MAIN_PROVIDER === "qwen",
        }),
      });
      const body = await responsesBody(response);
      conversation.push(...nextInput, ...(Array.isArray(body.output) ? body.output : []));
      responseId = typeof body.id === "string" ? body.id : undefined;
      usage = mergeUsage(usage, responseUsage(body));
      const calls = extractFunctionCalls(body);
      const submitted = calls.find((call) => call.name === "submit_verifier_comparison");
      if (submitted) {
        try {
          const data = validateComparisonPayload(JSON.parse(submitted.arguments), input.frame);
          if (rejectedPayload) validateQualityRepair(rejectedPayload, data, input.frame);
          return {
            id: submitted.callId,
            data,
            candidateFirst,
            usage,
          };
        } catch (error) {
          const detail = (error as Error).message.slice(0, 1_200);
          if (schemaRepairs >= 1) throw new Error(`verifier_invalid_json_after_repair:${detail}`);
          schemaRepairs += 1;
          try { rejectedPayload = JSON.parse(submitted.arguments); } catch { /* Syntax repair has no usable defect ledger. */ }
          nextInput = [{
            type: "function_call_output",
            call_id: submitted.callId,
            output: JSON.stringify({
              ok: false,
              error: `comparison_contract_invalid:${detail}`,
              instruction: "Resubmit the complete comparison once. Use every frame axis exactly once and do not return recommendation or evidence_refs. This is a consistency repair, not a new visual review: do not erase an already reported defect on a blocker axis to obtain pass. Preserve that failed delivery assessment; a later evidence-based review can reassess it separately.",
            }),
          }];
          continue;
        }
      }
      const outputs: Array<Record<string, unknown>> = [];
      for (const call of calls) {
        if (!verifierToolNames.includes(call.name as VerifierToolName)) continue;
        const tool = call.name as VerifierToolName;
        const evidence = evidenceByTool.get(tool) ?? await input.callTool(tool);
        evidenceByTool.set(tool, evidence);
        outputs.push({ type: "function_call_output", call_id: call.callId, output: JSON.stringify(evidence) });
      }
      nextInput = outputs.length > 0
        ? outputs
        : [{ role: "user", content: [{ type: "input_text", text: "请调用需要的量测工具，然后调用 submit_verifier_comparison。不要输出 Markdown。" }] }];
    }
    throw new Error("verifier_tool_loop_exhausted");
  }

  private async structuredRequest<T extends Record<string, unknown>>(
    name: string,
    schema: Record<string, unknown>,
    content: Array<Record<string, unknown>>,
    validate: (data: unknown) => T,
  ) {
    if (!this.config.QWEN_BASE_URL || !this.config.QWEN_API_KEY || !this.config.QWEN_MODEL) throw new Error("qwen_provider_not_configured");
    let repair = false;
    let lastValidationError = "unknown";
    for (let schemaAttempt = 0; schemaAttempt < 2; schemaAttempt += 1) {
      const response = await this.request(`${this.config.QWEN_BASE_URL.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.QWEN_MODEL,
          instructions: "You are AVO's independent visual evaluator. Follow the supplied evaluation contract, inspect the images, and return the requested tool result. Do not act as a coding assistant.",
          ...(this.config.AVO_MAIN_PROVIDER === "78code" ? { stream: true } : {}),
          input: [{
            role: "user",
            content: repair
              ? [{
                  type: "input_text",
                  text: `上一份输出不符合评价协议：${lastValidationError}。请重新提交完整结果；只调用指定函数，并严格满足参数 schema 及该跨字段约束。`,
                }, ...content]
              : content,
          }],
          tools: [{
            type: "function",
            name,
            description: "Return the validated structured result for this AVO controller step.",
            parameters: schema,
            strict: true,
          }],
          tool_choice: "required",
          parallel_tool_calls: false,
          reasoning: { effort: this.config.AVO_VERIFIER_EFFORT },
          store: false,
          max_output_tokens: 8_000,
        }),
      });
      const body = await responsesBody(response);
      try {
        const data = validate(JSON.parse(extractStructuredPayload(body, name)));
        const rawUsage = body.usage as Record<string, unknown> | undefined;
        const usage = usageSchema.parse({
          ...(typeof rawUsage?.input_tokens === "number" ? { input_tokens: rawUsage.input_tokens } : {}),
          ...(typeof rawUsage?.output_tokens === "number" ? { output_tokens: rawUsage.output_tokens } : {}),
          ...(typeof rawUsage?.total_tokens === "number" ? { total_tokens: rawUsage.total_tokens } : {}),
          unpriced: true,
        });
        return { data, usage };
      } catch (error) {
        lastValidationError = (error as Error).message.slice(0, 800);
        repair = true;
      }
    }
    throw new Error(`verifier_invalid_json_after_repair:${lastValidationError}`);
  }
}

const verifyEvaluationFrameCrossReferences = (
  frame: z.infer<typeof evaluationFramePayloadSchema>,
  input: Parameters<VerifierProvider["createEvaluationFrame"]>[0],
  anchors: string[],
) => {
  const axisIds = frame.axes.map((axis) => axis.id);
  if (new Set(axisIds).size !== axisIds.length) throw new Error("evaluation_frame_duplicate_axis_ids");

  const covered = new Set(frame.coverage.map((item) => item.anchor_ref));
  const missing = anchors.filter((anchor) => !covered.has(anchor));
  if (missing.length > 0) throw new Error(`evaluation_frame_missing_human_anchors:${missing.join(",")}`);

  const knownAxisIds = new Set(axisIds);
  if (frame.coverage.some((item) => item.axis_ids.some((id) => !knownAxisIds.has(id)))) {
    throw new Error("evaluation_frame_invalid_axis_coverage");
  }

  const knownDraftIds = new Set([
    ...input.lineage.flatMap((node) => node.draft_id ? [node.draft_id] : []),
    ...input.archive.map((item) => item.draft_id),
    ...input.recentAttempts.flatMap((attempt) => attempt.draft_ids),
  ]);
  const unknownDraftIds = frame.reconsider_candidate_ids.filter((id) => !knownDraftIds.has(id));
  if (unknownDraftIds.length > 0) {
    throw new Error(`evaluation_frame_unknown_reconsider_candidates:${unknownDraftIds.join(",")}`);
  }
  return frame;
};

const validateEvaluationFramePayload = (
  data: unknown,
  input: Parameters<VerifierProvider["createEvaluationFrame"]>[0],
  anchors: string[],
) => verifyEvaluationFrameCrossReferences(evaluationFramePayloadSchema.parse(data), input, anchors);

export const validateQualityRepair = (previous: unknown, next: unknown, frame: EvaluationFrameRevision) => {
  const before = comparisonPayloadSchema.safeParse(previous);
  if (!before.success) return;
  const after = comparisonPayloadSchema.parse(next);
  for (const key of ["candidate_quality", "incumbent_quality"] as const) {
    const knownViolation = before.data[key].defects.some((defect) => defect.severity === "blocker" || defect.axis_ids.some((id) =>
      frame.axes.some((axis) => axis.id === id && axis.importance === "blocker")));
    if (knownViolation && after[key].delivery_status !== "unacceptable") {
      throw new Error(`comparison_repair_cannot_erase_${key}_blocker_evidence`);
    }
  }
};

export const validateComparisonPayload = (
  value: unknown,
  frame: EvaluationFrameRevision,
) => {
  const parsed = comparisonPayloadSchema.parse(value);
  const expectedAxisIds = frame.axes.map((axis) => axis.id);
  const actualAxisIds = parsed.axis_judgments.map((judgment) => judgment.axis_id);
  if (new Set(actualAxisIds).size !== actualAxisIds.length) {
    throw new Error("comparison_duplicate_axis_ids");
  }
  const expected = new Set(expectedAxisIds);
  const unknown = actualAxisIds.filter((axisId) => !expected.has(axisId));
  if (unknown.length > 0) throw new Error(`comparison_unknown_axis_ids:${unknown.join(",")}`);
  const actual = new Set(actualAxisIds);
  const missing = expectedAxisIds.filter((axisId) => !actual.has(axisId));
  if (missing.length > 0) throw new Error(`comparison_missing_axis_ids:${missing.join(",")}`);
  const failedBlockers = parsed.axis_judgments.filter((judgment) => frame.axes.some((axis) => (
    axis.id === judgment.axis_id && axis.importance === "blocker"
  )) && judgment.verdict !== "pass");
  if (parsed.correctness === "pass" && failedBlockers.length > 0) {
    throw new Error(`comparison_correctness_conflicts_with_blockers:${failedBlockers.map((item) => item.axis_id).join(",")}`);
  }
  for (const [label, quality, correctness] of [
    ["candidate", parsed.candidate_quality, parsed.correctness],
    ["incumbent", parsed.incumbent_quality, parsed.incumbent_correctness],
  ] as const) {
    if (quality.defects.some((defect) => defect.axis_ids.some((id) => !expected.has(id)))) {
      throw new Error(`comparison_${label}_quality_unknown_axis`);
    }
    const violatedBlockers = quality.defects.flatMap((defect) => defect.axis_ids)
      .filter((id) => frame.axes.some((axis) => axis.id === id && axis.importance === "blocker"));
    if (violatedBlockers.length && (quality.delivery_status !== "unacceptable" || correctness === "pass")) {
      throw new Error(`comparison_${label}_unresolved_defect_violates_blocker_axis:${[...new Set(violatedBlockers)].join(",")}`);
    }
    if (label === "candidate" && violatedBlockers.some((id) => parsed.axis_judgments.some((axis) => axis.axis_id === id && axis.verdict === "pass"))) {
      throw new Error("comparison_candidate_defect_conflicts_with_axis_pass");
    }
    if (quality.defects.some((defect) => defect.severity === "blocker") && quality.delivery_status === "acceptable") {
      throw new Error(`comparison_${label}_unresolved_quality_blocker`);
    }
    if (correctness === "pass" && quality.delivery_status !== "acceptable") {
      throw new Error(`comparison_${label}_correctness_conflicts_with_delivery_quality`);
    }
  }
  return parsed;
};

const verifierToolDescription = (tool: VerifierToolName) => ({
  measure_integrity: "Measure decode, channel, alpha, blank and transparent integrity. This is objective technical evidence.",
  measure_source_fidelity: "Measure differences from Source. A difference is not automatically a defect; interpret it only through preserve_source axes.",
  measure_parent_delta: "Measure the local change from the selected generation parent to the candidate.",
  measure_target_alignment: "Measure deterministic color, structure and edge proximity to the hidden target. These metrics are partial evidence, not semantic truth.",
  measure_artifacts: "Measure clipping, detail loss, banding and blockiness. Severe objective corruption may close the technical gate.",
  get_evaluation_history: "Read a bounded pairwise ledger for prior candidates under recorded frame revisions.",
})[tool];

const evaluationAxisDiff = (
  previous: EvaluationFrameRevision | undefined,
  axes: EvaluationFrameRevision["axes"],
) => {
  const before = new Map((previous?.axes ?? []).map((axis) => [axis.id, axis]));
  const after = new Map(axes.map((axis) => [axis.id, axis]));
  return {
    added: [...after.keys()].filter((id) => !before.has(id)),
    removed: [...before.keys()].filter((id) => !after.has(id)),
    changed: [...after.keys()].filter((id) => before.has(id)
      && JSON.stringify(before.get(id)) !== JSON.stringify(after.get(id))),
  };
};

const comparisonPreference = (
  winner: "A" | "B" | "equivalent" | "uncertain",
  candidateFirst: boolean,
): ComparativeVerifierDecision["preference"] => {
  if (winner === "equivalent" || winner === "uncertain") return winner;
  const candidateWon = (winner === "A") === candidateFirst;
  return candidateWon ? "better" : "worse";
};

const responseUsage = (body: Record<string, unknown>) => {
  const raw = body.usage as Record<string, unknown> | undefined;
  return usageSchema.parse({
    ...(typeof raw?.input_tokens === "number" ? { input_tokens: raw.input_tokens } : {}),
    ...(typeof raw?.output_tokens === "number" ? { output_tokens: raw.output_tokens } : {}),
    ...(typeof raw?.total_tokens === "number" ? { total_tokens: raw.total_tokens } : {}),
    unpriced: true,
  });
};

const mergeUsage = (left: z.infer<typeof usageSchema>, right: z.infer<typeof usageSchema>) => usageSchema.parse({
  input_tokens: (left.input_tokens ?? 0) + (right.input_tokens ?? 0),
  output_tokens: (left.output_tokens ?? 0) + (right.output_tokens ?? 0),
  total_tokens: (left.total_tokens ?? 0) + (right.total_tokens ?? 0),
  unpriced: true,
});

const extractFunctionCalls = (body: Record<string, unknown>) => {
  const output = Array.isArray(body.output) ? body.output : [];
  return output.flatMap((item) => {
    if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "function_call") return [];
    const call = item as { id?: unknown; call_id?: unknown; name?: unknown; arguments?: unknown };
    if (typeof call.name !== "string" || typeof call.arguments !== "string") return [];
    return [{
      callId: typeof call.call_id === "string" ? call.call_id : typeof call.id === "string" ? call.id : `call-${Date.now()}`,
      name: call.name,
      arguments: call.arguments,
    }];
  });
};

const errorMessage = (body: Record<string, unknown>) => {
  const error = body.error;
  return typeof error === "object" && error && "message" in error ? String((error as { message: unknown }).message) : "request_failed";
};

const extractStructuredPayload = (body: Record<string, unknown>, name: string) => {
  if (typeof body.output_text === "string") return body.output_text;
  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    if ((item as { type?: unknown }).type === "function_call"
      && (item as { name?: unknown }).name === name
      && typeof (item as { arguments?: unknown }).arguments === "string") {
      return String((item as { arguments: string }).arguments);
    }
    const content = Array.isArray((item as { content?: unknown }).content) ? (item as { content: unknown[] }).content : [];
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") return String((part as { text: string }).text);
    }
  }
  throw new Error("responses_output_text_missing");
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let current = value;
  for (let bit = 0; bit < 8; bit += 1) current = (current & 1) ? 0xedb88320 ^ (current >>> 1) : current >>> 1;
  return current >>> 0;
});

const pngChunk = (type: string, data: Buffer) => {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  let checksum = 0xffffffff;
  for (const byte of Buffer.concat([typeBytes, data])) checksum = crcTable[(checksum ^ byte) & 0xff]! ^ (checksum >>> 8);
  output.writeUInt32BE((checksum ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
};

const createProbePng = () => {
  const width = 64;
  const height = 64;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Array.from({ length: height }, (_, y) => {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) row.set([32 + x * 2, 64 + y * 2, 160, 255], 1 + x * 4);
    return row;
  });
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
};

const probePixel = createProbePng();
