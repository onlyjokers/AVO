import type { FastifyReply, FastifyRequest } from "fastify";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { AppConfig } from "./config.ts";

const AVO_QWEN_INSTRUCTIONS = [
  "You are the autonomous AVO image-editing variation operator.",
  "Follow the developer and user messages in the input.",
  "Only call the provided avo_* functions.",
  "Call exactly one function per response, then wait for its function_call_output before deciding the next action.",
  "Never infer that a function failed before receiving its function_call_output.",
].join(" ");

const AVO_QWEN_STRUCTURED_INSTRUCTIONS = [
  "Follow the user input and return exactly one JSON value.",
  "The JSON must match the provided response schema at the top level.",
  "Do not call tools, add Markdown fences, commentary, or return a single field in place of the requested object.",
].join(" ");

export type CodexProxyConfig = {
  token: string;
  upstreamBaseUrl: string;
  upstreamApiKey: string;
  maxOutputTokens: number;
  responseIdByCallId: Map<string, string>;
};

export const createCodexProxyConfig = (config: AppConfig, token: string): CodexProxyConfig | undefined =>
  config.AVO_CODEX_PROVIDER_BASE_URL && config.AVO_CODEX_PROVIDER_API_KEY
    ? {
        token,
        upstreamBaseUrl: config.AVO_CODEX_PROVIDER_BASE_URL,
        upstreamApiKey: config.AVO_CODEX_PROVIDER_API_KEY,
        maxOutputTokens: config.AVO_CODEX_MAX_OUTPUT_TOKENS,
        responseIdByCallId: new Map(),
      }
    : undefined;

export const proxyCodexRequest = async (
  request: FastifyRequest,
  reply: FastifyReply,
  config: CodexProxyConfig,
) => {
  if (request.headers.authorization !== `Bearer ${config.token}`) {
    return reply.code(401).send({ error: "codex_proxy_unauthorized" });
  }
  const suffix = (request.params as { "*"?: string })["*"] ?? "";
  const upstream = new URL(config.upstreamBaseUrl);
  const upstreamRoot = new URL(upstream.pathname.replace(/v1\/?$/, ""), upstream.origin);
  const target = new URL(suffix, upstreamRoot).toString();
  const isResponsesRequest = /(?:^|\/)responses\/?$/.test(suffix);
  const originalBody = requestBodyRecord(request.body);
  const codexResponseTools = avoNamespaceTools(originalBody.tools);
  const continuation = isResponsesRequest
    ? qwenContinuation(originalBody, config.responseIdByCallId)
    : undefined;
  const body = request.method === "GET" || request.method === "HEAD"
    ? undefined
    : isResponsesRequest
      ? qwenRequestBody(originalBody, config.maxOutputTokens, continuation)
      : JSON.stringify(request.body ?? {});
  const response = await fetch(target, {
    method: request.method,
    headers: {
      authorization: `Bearer ${config.upstreamApiKey}`,
      "content-type": request.headers["content-type"] ?? "application/json",
      accept: request.headers.accept ?? "application/json",
      "x-dashscope-session-cache": "enable",
    },
    ...(body === undefined ? {} : { body }),
  });
  reply.code(response.status);
  const contentType = response.headers.get("content-type");
  if (contentType) reply.header("content-type", contentType);
  const requestId = response.headers.get("x-request-id");
  if (requestId) reply.header("x-request-id", requestId);
  if (!response.body) return reply.send();
  const upstreamBody = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>);
  if (!isResponsesRequest || !response.ok) return reply.send(upstreamBody);
  if (contentType?.includes("text/event-stream")) {
    reply.header("x-avo-qwen-tool-boundary", "single-call");
    if (continuation) reply.header("x-avo-qwen-continuation", "previous-response-id");
    return reply.send(upstreamBody.pipe(createQwenSingleToolCallTransform({
      responseTools: codexResponseTools,
      onBoundaryCompleted: (boundary) => rememberQwenBoundary(config.responseIdByCallId, boundary),
      onProviderError: (error) => request.log.warn({ qwenError: error }, "Qwen Responses stream error"),
    })));
  }
  const chunks: Buffer[] = [];
  for await (const chunk of upstreamBody) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const rawBody = Buffer.concat(chunks).toString("utf8");
  const responseError = qwenResponseError(rawBody);
  if (responseError) request.log.warn({ qwenError: responseError }, "Qwen Responses body error");
  return reply.send(qwenResponseBody(
    rawBody,
    {
      responseTools: codexResponseTools,
      onBoundaryCompleted: (boundary) => rememberQwenBoundary(config.responseIdByCallId, boundary),
    },
  ));
};

export type QwenContinuation = {
  responseId: string;
  callId: string;
};

export const qwenRequestBody = (input: unknown, maxOutputTokens: number, continuation?: QwenContinuation) => {
  const parsed = typeof input === "string" ? JSON.parse(input) as unknown : input;
  const body = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? { ...(parsed as Record<string, unknown>) }
    : {};
  const requestedMax = typeof body.max_output_tokens === "number" ? body.max_output_tokens : maxOutputTokens;
  const continuationInput = continuation
    ? qwenContinuationInput(body.input, continuation.callId)
    : undefined;
  const tools = avoFlatFunctionTools(body.tools);
  return JSON.stringify({
    ...body,
    instructions: tools.length > 0 ? AVO_QWEN_INSTRUCTIONS : AVO_QWEN_STRUCTURED_INSTRUCTIONS,
    tools,
    ...(continuation ? { previous_response_id: continuation.responseId } : {}),
    ...(continuationInput ? { input: continuationInput } : {}),
    store: true,
    parallel_tool_calls: false,
    reasoning: { effort: "low" },
    max_output_tokens: Math.min(requestedMax, maxOutputTokens),
  });
};

const avoNamespaceTools = (value: unknown) => {
  if (!Array.isArray(value)) return [];
  const namespace = value.find((item) => {
    const tool = asRecord(item);
    return tool?.type === "namespace" && tool.name === "mcp__avo";
  });
  const namespaceRecord = asRecord(namespace);
  const tools = namespaceRecord?.tools;
  if (!Array.isArray(tools)) return [];
  const avoTools = tools.flatMap((item) => {
    const tool = asRecord(item);
    return tool?.type === "function" && typeof tool.name === "string" && tool.name.startsWith("avo_")
      ? [{ ...tool, type: "function" }]
      : [];
  });
  return namespaceRecord && avoTools.length > 0
    ? [{ ...namespaceRecord, type: "namespace", name: "mcp__avo", tools: avoTools }]
    : [];
};

const avoFlatFunctionTools = (value: unknown) => {
  const namespace = avoNamespaceTools(value)[0];
  const tools = asRecord(namespace)?.tools;
  return Array.isArray(tools) ? tools : [];
};

export const qwenResponseBody = (input: string, options: {
  responseTools?: unknown[];
  onBoundaryCompleted?: (boundary: QwenBoundary) => void;
} = {}) => {
  let body: unknown;
  try { body = JSON.parse(input); } catch { return input; }
  const record = asRecord(body);
  if (!record || !Array.isArray(record.output)) return input;
  const output = throughFirstFunctionCall(record.output).map(codexRoutedToolItem);
  const functionCall = output.map(asRecord).find((item) => item?.type === "function_call");
  const responseId = typeof record.id === "string" ? record.id : undefined;
  const callId = typeof functionCall?.call_id === "string" ? functionCall.call_id : undefined;
  if (responseId && callId) options.onBoundaryCompleted?.({ responseId, callId });
  return JSON.stringify({
    ...record,
    ...(options.responseTools ? { tools: options.responseTools } : {}),
    output,
  });
};

export type QwenBoundary = {
  responseId: string;
  callId: string;
};

export const createQwenSingleToolCallTransform = (options: {
  responseTools?: unknown[];
  onBoundaryCompleted?: (boundary: QwenBoundary) => void;
  onProviderError?: (error: Record<string, unknown>) => void;
} = {}) => {
  let buffer = "";
  let firstFunctionCallItemId: string | undefined;
  let firstFunctionCallCallId: string | undefined;
  let responseId: string | undefined;
  let boundaryReached = false;

  const transform = new Transform({
    transform(chunk, _encoding, callback) {
      buffer += chunk.toString("utf8");
      while (true) {
        const boundary = frameBoundary(buffer);
        if (!boundary) break;
        const frame = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const output = normalizeSseFrame(frame, {
          boundaryReached,
          firstFunctionCallItemId,
          firstFunctionCallCallId,
          responseId,
          responseTools: options.responseTools,
        });
        if (output.responseId) responseId = output.responseId;
        if (output.firstFunctionCallItemId) {
          firstFunctionCallItemId = output.firstFunctionCallItemId;
          firstFunctionCallCallId = output.firstFunctionCallCallId;
          boundaryReached = true;
        }
        if (output.boundaryCompleted && responseId && firstFunctionCallCallId) {
          options.onBoundaryCompleted?.({ responseId, callId: firstFunctionCallCallId });
        }
        if (output.providerError) options.onProviderError?.(output.providerError);
        if (output.frame !== undefined) this.push(`${output.frame}\n\n`);
      }
      callback();
    },
    flush(callback) {
      if (buffer) {
        const output = normalizeSseFrame(buffer, {
          boundaryReached,
          firstFunctionCallItemId,
          firstFunctionCallCallId,
          responseId,
          responseTools: options.responseTools,
        });
        if (output.frame !== undefined) this.push(output.frame);
      }
      callback();
    },
  });
  return transform;
};

type SseBoundaryState = {
  boundaryReached: boolean;
  firstFunctionCallItemId: string | undefined;
  firstFunctionCallCallId: string | undefined;
  responseId: string | undefined;
  responseTools: unknown[] | undefined;
};

const normalizeSseFrame = (frame: string, state: SseBoundaryState) => {
  const payload = ssePayload(frame);
  if (!payload || payload === "[DONE]") {
    return { frame: state.boundaryReached && payload !== "[DONE]" ? undefined : frame };
  }
  let parsedEvent: Record<string, unknown>;
  try { parsedEvent = JSON.parse(payload) as Record<string, unknown>; } catch {
    return { frame: state.boundaryReached ? undefined : frame };
  }
  const parsedItem = asRecord(parsedEvent.item);
  const event = parsedItem?.type === "function_call"
    ? { ...parsedEvent, item: codexRoutedToolItem(parsedItem) }
    : parsedEvent;
  const type = typeof event.type === "string" ? event.type : sseEventName(frame);
  const eventResponse = asRecord(event.response);
  const routedFrame = event === parsedEvent ? frame : replaceSsePayload(frame, JSON.stringify(event));
  const responseFrame = eventResponse && state.responseTools
    ? replaceSsePayload(routedFrame, JSON.stringify({
        ...event,
        response: { ...eventResponse, tools: state.responseTools },
      }))
    : routedFrame;
  if (type === "response.completed" && eventResponse?.status !== "completed") {
    return {
      frame: responseFrame,
      providerError: asRecord(eventResponse?.error) ?? asRecord(eventResponse?.incomplete_details) ?? eventResponse ?? event,
    };
  }
  if (type === "response.failed" || type === "response.incomplete" || type === "error") {
    return { frame: responseFrame, providerError: asRecord(event.error) ?? event };
  }
  if (!state.boundaryReached) {
    const response = asRecord(event.response);
    const responseId = typeof response?.id === "string" ? response.id : undefined;
    const item = asRecord(event.item);
    const firstFunctionCallItemId = type === "response.output_item.done" && item?.type === "function_call"
      ? String(item.id ?? "") || undefined
      : undefined;
    const firstFunctionCallCallId = firstFunctionCallItemId && typeof item?.call_id === "string"
      ? item.call_id
      : undefined;
    return { frame: responseFrame, responseId, firstFunctionCallItemId, firstFunctionCallCallId };
  }
  if (type === "response.completed") {
    const response = asRecord(event.response);
    if (!response || !Array.isArray(response.output)) return { frame };
    return {
      frame: replaceSsePayload(frame, JSON.stringify({
        ...event,
        response: {
          ...response,
          ...(state.responseTools ? { tools: state.responseTools } : {}),
          output: throughFirstFunctionCall(response.output, state.firstFunctionCallItemId).map(codexRoutedToolItem),
          parallel_tool_calls: false,
        },
      })),
      boundaryCompleted: true,
    };
  }
  return { frame: undefined };
};

const throughFirstFunctionCall = (items: unknown[], expectedId?: string) => {
  const expectedIndex = expectedId
    ? items.findIndex((item) => asRecord(item)?.id === expectedId)
    : -1;
  const firstFunctionIndex = expectedIndex >= 0
    ? expectedIndex
    : items.findIndex((item) => asRecord(item)?.type === "function_call");
  return firstFunctionIndex >= 0 ? items.slice(0, firstFunctionIndex + 1) : items;
};

const codexRoutedToolItem = (item: unknown) => {
  const record = asRecord(item);
  return record?.type === "function_call" && typeof record.name === "string" && record.name.startsWith("avo_")
    ? { ...record, namespace: "mcp__avo" }
    : item;
};

const qwenContinuation = (input: unknown, responseIdByCallId: Map<string, string>): QwenContinuation | undefined => {
  const parsed = typeof input === "string" ? safeJson(input) : input;
  const body = asRecord(parsed);
  if (!Array.isArray(body?.input)) return undefined;
  for (let index = body.input.length - 1; index >= 0; index -= 1) {
    const item = asRecord(body.input[index]);
    if (item?.type !== "function_call_output" || typeof item.call_id !== "string") continue;
    const responseId = responseIdByCallId.get(item.call_id);
    if (responseId) return { responseId, callId: item.call_id };
  }
  return undefined;
};

const requestBodyRecord = (input: unknown) => {
  const parsed = typeof input === "string" ? safeJson(input) : input;
  return asRecord(parsed) ?? {};
};

const qwenContinuationInput = (input: unknown, callId: string) => {
  if (!Array.isArray(input)) return undefined;
  const callIndex = input.findLastIndex((item) => {
    const record = asRecord(item);
    return record?.type === "function_call" && record.call_id === callId;
  });
  if (callIndex < 0) return undefined;
  const continuation = input.slice(callIndex + 1);
  if (!continuation.some((item) => asRecord(item)?.type === "function_call_output")) return undefined;
  return continuation.map((item) => {
    const record = asRecord(item);
    if (record?.type !== "function_call_output") return item;
    return {
      type: "function_call_output",
      call_id: record.call_id,
      output: record.output,
    };
  });
};

const rememberQwenBoundary = (responseIdByCallId: Map<string, string>, boundary: QwenBoundary) => {
  responseIdByCallId.set(boundary.callId, boundary.responseId);
  if (responseIdByCallId.size <= 2_000) return;
  const oldest = responseIdByCallId.keys().next().value as string | undefined;
  if (oldest) responseIdByCallId.delete(oldest);
};

const safeJson = (value: string): unknown => {
  try { return JSON.parse(value) as unknown; } catch { return undefined; }
};

const qwenResponseError = (value: string) => {
  const body = asRecord(safeJson(value));
  const error = asRecord(body?.error);
  if (!error) return undefined;
  return {
    code: typeof error.code === "string" ? error.code : "qwen_response_error",
    message: typeof error.message === "string" ? error.message.slice(0, 1_000) : "Qwen Responses request failed",
  };
};

const ssePayload = (frame: string) => {
  const data = frame.split(/\r?\n/).flatMap((line) => line.startsWith("data:") ? [line.slice(5).trimStart()] : []);
  return data.length ? data.join("\n") : undefined;
};

const sseEventName = (frame: string) =>
  frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";

const replaceSsePayload = (frame: string, payload: string) => {
  const lines = frame.split(/\r?\n/);
  let replaced = false;
  return lines.flatMap((line) => {
    if (!line.startsWith("data:")) return [line];
    if (replaced) return [];
    replaced = true;
    return [`data: ${payload}`];
  }).join("\n");
};

const frameBoundary = (value: string) => {
  const lf = value.indexOf("\n\n");
  const crlf = value.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return undefined;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
