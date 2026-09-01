import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import {
  requirementChecklistSchema,
  usageSchema,
  verificationResultSchema,
  type RequirementChecklist,
  type VerificationResult,
} from "@avo/contracts";
import type { ImageProvider, VerifierProvider } from "@avo/core";
import type { AppConfig } from "./config.ts";

const dataUrl = async (path: string) => {
  const mime = path.endsWith(".jpg") || path.endsWith(".jpeg") ? "image/jpeg" : path.endsWith(".webp") ? "image/webp" : "image/png";
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
};

const retryableFetch = async (url: string, init: RequestInit, attempts = 3) => {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (response.ok || ![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === attempts) return response;
      await response.arrayBuffer().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    } catch (error) {
      lastError = error;
      if (attempt === attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
};

export class GptImageProvider implements ImageProvider {
  readonly id = "openai-gpt-image-2";
  constructor(private readonly config: AppConfig) {}

  async probe() {
    if (!this.config.OPENAI_API_KEY) return { ok: false, message: "OPENAI_API_KEY 未配置" };
    if (!this.config.AVO_RUN_LIVE_PROBES) return { ok: false, message: "已配置但真实 probe 未授权；设置 AVO_RUN_LIVE_PROBES=true" };
    const directory = await mkdtemp(join(tmpdir(), "avo-image-probe-"));
    try {
      const source = join(directory, "source.png");
      await writeFile(source, probePixel);
      const result = await this.generate({
        prompt: "Keep the input unchanged. This is a capability probe.",
        base: { path: source, mimeType: "image/png" },
        references: [],
        idempotencyKey: `avo-probe-${Date.now()}`,
      });
      if (result.bytes.length < 100) return { ok: false, message: "GPT Image 2 probe 返回空图片" };
      return { ok: true, message: `${this.config.AVO_IMAGE_MODEL} 真实编辑 probe 通过` };
    } catch (error) {
      return { ok: false, message: `GPT Image 2 probe 失败：${(error as Error).message}` };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async generate(input: Parameters<ImageProvider["generate"]>[0]) {
    if (!this.config.OPENAI_API_KEY) throw new Error("openai_api_key_missing");
    const started = Date.now();
    const clientTaskId = deterministicUuid(input.idempotencyKey);
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
    });
    const submitted = await response.json() as ImageTask;
    if (!response.ok) throw new Error(`image_provider_http_${response.status}:${imageTaskError(submitted)}`);
    const taskId = submitted.id ?? clientTaskId;
    const task = await pollImageTask({
      serviceRoot,
      taskId,
      apiKey: this.config.OPENAI_API_KEY,
      timeoutMs: this.config.AVO_IMAGE_TASK_TIMEOUT_MS,
    });
    const outputUrl = task.data?.find((item) => typeof item.url === "string")?.url;
    if (!outputUrl) throw new Error("image_provider_missing_output");
    let bytes: Buffer;
    try {
      const output = await retryableFetch(new URL(outputUrl, serviceRoot).toString(), {});
      if (!output.ok) throw new Error(`HTTP ${output.status}`);
      bytes = Buffer.from(await output.arrayBuffer());
    } catch (error) {
      throw new Error(`image_provider_ambiguous:output_download_failed:${(error as Error).message}`);
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

const pollImageTask = async (input: { serviceRoot: string; taskId: string; apiKey: string; timeoutMs: number }) => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const response = await retryableFetch(`${input.serviceRoot}/api/image-tasks?ids=${encodeURIComponent(input.taskId)}&_t=${Date.now()}`, {
      headers: { authorization: `Bearer ${input.apiKey}` },
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
    await new Promise((resolve) => setTimeout(resolve, 2_000));
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

export class QwenResponsesVerifier implements VerifierProvider {
  readonly id = "qwen-responses-verifier";
  constructor(private readonly config: AppConfig) {}

  async probe() {
    if (!this.config.QWEN_BASE_URL || !this.config.QWEN_API_KEY || !this.config.QWEN_MODEL) {
      return { ok: false, message: "QWEN_BASE_URL、QWEN_API_KEY 或 QWEN_MODEL 未配置" };
    }
    if (!this.config.AVO_RUN_LIVE_PROBES) return { ok: false, message: "已配置但真实 probe 未授权；设置 AVO_RUN_LIVE_PROBES=true" };
    const directory = await mkdtemp(join(tmpdir(), "avo-qwen-probe-"));
    try {
      const source = join(directory, "source.png");
      await writeFile(source, probePixel);
      const task = {
        schema_version: 1 as const,
        id: "task-capability-probe",
        title: "Capability probe",
        request: "Keep the image unchanged.",
        source_artifact_id: `sha256:${"0".repeat(64)}`,
        references: [],
        created_at: new Date().toISOString(),
      };
      const checklist = await this.createChecklist({ task, sourcePath: source, references: [] });
      await this.verify({ runId: "run-capability-probe", attemptNumber: 1, task: { ...task, checklist }, checklist, sourcePath: source, references: [], candidatePath: source });
      return { ok: true, message: `${this.config.QWEN_MODEL} 多图 Responses probe 通过` };
    } catch (error) {
      return { ok: false, message: `Qwen probe 失败：${(error as Error).message}` };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async createChecklist(input: Parameters<VerifierProvider["createChecklist"]>[0]): Promise<RequirementChecklist> {
    const content: Array<Record<string, unknown>> = [
      { type: "input_text", text: `将甲方图片编辑需求拆成稳定、可独立判断的需求清单。不要评价候选图。\n\n需求：\n${input.task.request}` },
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
          `原始需求：${input.task.request}`,
          `冻结清单：${JSON.stringify(input.checklist.requirements)}`,
          "下面依次是原图、用户参考图和当前候选图。",
        ].join("\n\n"),
      },
      { type: "input_text", text: "原图" },
      { type: "input_image", image_url: await dataUrl(input.sourcePath), detail: "high" },
    ];
    for (const reference of input.references) {
      content.push({ type: "input_text", text: `用户参考图：${reference.caption ?? "未提供说明"}` });
      content.push({ type: "input_image", image_url: await dataUrl(reference.path), detail: "high" });
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
      const response = await retryableFetch(`${this.config.QWEN_BASE_URL.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.config.QWEN_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: this.config.QWEN_MODEL,
          input: [{ role: "user", content: repair ? [{ type: "input_text", text: "上一份输出不符合 JSON Schema。只调用指定函数，并提供严格符合参数 schema 的结果。" }, ...content] : content }],
          tools: [{
            type: "function",
            name,
            description: "Return the validated structured result for this AVO controller step.",
            parameters: schema,
            strict: true,
          }],
          tool_choice: "required",
          reasoning: { effort: "none" },
          max_output_tokens: 8_000,
        }),
      });
      const body = await response.json() as Record<string, unknown>;
      if (!response.ok) throw new Error(`qwen_responses_http_${response.status}:${errorMessage(body)}`);
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
