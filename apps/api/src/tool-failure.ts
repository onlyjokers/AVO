const scrub = (value: unknown, key = "", depth = 0): unknown => {
  if (/authorization|api.?key|secret|password|^token$/i.test(key)) return "[REDACTED]";
  if (depth > 8) return "[DEPTH_LIMIT]";
  if (typeof value === "string") return value.replace(/sk-[a-zA-Z0-9_.-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/data:[^\s"']+/g, "[MEDIA_REDACTED]").slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => scrub(item, key, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 50)
    .map(([name, item]) => [name, scrub(item, name, depth + 1)]));
  return value;
};

export function toolFailureDiagnostic(item: Record<string, unknown>) {
  const argumentsValue = item.arguments ?? item.input ?? null;
  const args = typeof argumentsValue === "string" ? (() => {
    try { return JSON.parse(argumentsValue); } catch { return { malformed_json: true, length: argumentsValue.length }; }
  })() : argumentsValue;
  const diagnostic = { call_id: scrub(item.id ?? item.callId ?? item.call_id ?? null),
    arguments_type: typeof argumentsValue, arguments: scrub(args), error: scrub(item.error ?? null),
    result: scrub(item.result ?? null),
  };
  const encoded = JSON.stringify(diagnostic);
  return encoded.length <= 12_000 ? diagnostic : {
    call_id: String(diagnostic.call_id).slice(0, 128), arguments_type: diagnostic.arguments_type,
    clipped: true, preview: encoded.slice(0, 1_000),
  };
}
