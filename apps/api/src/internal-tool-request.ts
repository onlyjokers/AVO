import { request } from "node:http";

// Node fetch has an independent 300s headers timeout. A local tool operation can
// legitimately take longer while the image provider completes its retry budget.
export const internalToolRequest = (url: string, token: string, args: unknown, timeoutMs: number): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    const body = JSON.stringify(args);
    const req = request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), "x-avo-tool-token": token },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
          if ((res.statusCode ?? 500) >= 400) reject(new Error(String(result.error ?? `tool_http_${res.statusCode}`)));
          else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("internal_tool_wait_timeout")));
    req.on("error", reject);
    req.end(body);
  });
