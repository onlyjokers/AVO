import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises";
import sharp from "sharp";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { EvaluationFrameRevision } from "@avo/contracts";
import { loadConfig, roleConfig, toolWaitTimeoutMs } from "../src/config.ts";
import { ReviewContext } from "../src/review-context.ts";
import { internalToolRequest } from "../src/internal-tool-request.ts";
import { blockerSignature, responsesBody } from "../src/http-providers.ts";
import { profilesForRun, RoleRouter } from "../src/role-router.ts";
import { AgentToolBroker } from "../src/tool-broker.ts";
import { FileStateStore, type AgentRoundContext, type AgentToolbox, type VerifierProvider } from "@avo/core";
import { runConfigSchema } from "@avo/contracts";

test("role profiles isolate native Astra from Qwen settings and preserve old Run routing", () => {
  const config = loadConfig({ QWEN_BASE_URL: "https://qwen.test/v1", QWEN_API_KEY: "qwen-test", AVO_78CODE_API_KEY: "native-test", AVO_MAIN_PROVIDER: "78code", AVO_VERIFIER_PROVIDER: "qwen" });
  const main = roleConfig(config, "main");
  const verifier = roleConfig(config, "verifier");
  assert.equal(main.AVO_CODEX_MODEL, "gpt-6-astra");
  assert.equal(main.AVO_CODEX_PROVIDER_API_KEY, "native-test");
  assert.equal(main.AVO_CODEX_MODEL_CATALOG, undefined);
  assert.equal(verifier.QWEN_API_KEY, "qwen-test");
  assert.equal(verifier.QWEN_MODEL, "qwen3.8-flash");
  assert.deepEqual(profilesForRun(runConfigSchema.parse({ mode: "avo" })), { main: "qwen", verifier: "qwen", supervisor: "qwen" });
  assert.ok(toolWaitTimeoutMs(config) > 5 * 120_000 + 120_000);
});

test("all eight role combinations route independently without substituting Qwen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avo-role-routing-"));
  try {
    const store = new FileStateStore(dir);
    const router = new RoleRouter(loadConfig({ AVO_DATA_DIR: dir, QWEN_BASE_URL: "https://qwen.test/v1", QWEN_API_KEY: "qwen-test", AVO_78CODE_API_KEY: "astra-test" }), undefined, new AgentToolBroker(), store, "local-test");
    for (const main of ["qwen", "78code"] as const) for (const verifier of ["qwen", "78code"] as const) for (const supervisor of ["qwen", "78code"] as const) {
      const profiles = { main, verifier, supervisor };
      const config = runConfigSchema.parse({ mode: "avo", role_profiles: profiles,
        main_model: router.configFor(main, "main").AVO_CODEX_MODEL,
        verifier_model: router.configFor(verifier, "verifier").QWEN_MODEL,
        supervisor_model: router.configFor(supervisor, "supervisor").AVO_CODEX_MODEL,
      });
      const context = { run: { id: "routing-test", config } } as AgentRoundContext;
      const calls: string[] = [];
      const selectedAgent = router.agentFor(profiles);
      selectedAgent.runRound = async () => { calls.push(`main:${main}`); };
      selectedAgent.supervise = async () => { calls.push(`supervisor:${supervisor}`); return { intervene: false, diagnosis: "Test routing", branch_strategy: "continue", quality_risks: [], avoid: [], try: [] }; };
      router.verifierFor(verifier).compare = async () => { calls.push(`verifier:${verifier}`); throw new Error("selected_verifier_failure"); };
      store.getRun = async () => context.run;
      await router.agent.runRound(context, {} as AgentToolbox);
      await router.agent.supervise(context, { triggers: [], scope: "in_step" });
      await assert.rejects(router.verifier.compare({ runId: context.run.id } as Parameters<VerifierProvider["compare"]>[0]), /selected_verifier_failure/);
      assert.deepEqual(calls, [`main:${main}`, `supervisor:${supervisor}`, `verifier:${verifier}`]);
      for (const role of ["main", "verifier", "supervisor"] as const) {
        const resolved = router.configFor(profiles[role], role);
        assert.equal(resolved.AVO_CODEX_MODEL, profiles[role] === "78code" ? "gpt-6-astra" : "qwen3.8-flash");
        assert.equal(resolved.AVO_CODEX_PROVIDER_API_KEY, profiles[role] === "78code" ? "astra-test" : "qwen-test");
      }
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("saved Run model IDs remain pinned when Qwen defaults change to Max", async () => {
  const config = loadConfig({ QWEN_MODEL: "qwen3.8-max", AVO_CODEX_MODEL: "qwen3.8-max" });
  const router = new RoleRouter(config, undefined, new AgentToolBroker(), new FileStateStore(config.AVO_DATA_DIR), "test");
  const profiles = { main: "qwen", verifier: "qwen", supervisor: "qwen" } as const;
  assert.equal(router.configFor("qwen", "verifier").QWEN_MODEL, "qwen3.8-max");
  assert.equal(router.configFor("qwen", "verifier", "qwen3.8-flash").QWEN_MODEL, "qwen3.8-flash");
  assert.notEqual(router.verifierFor("qwen"), router.verifierFor("qwen", "qwen3.8-flash"));
  assert.equal(router.verifierFor("qwen"), router.verifierFor("qwen", "qwen3.8-max"));
  assert.notEqual(router.agentFor(profiles), router.agentFor(profiles, { main_model: "qwen3.8-flash", supervisor_model: "qwen3.8-flash" }));
});

test("MCP internal HTTP waits for the complete operation without using fetch's headers timer", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("fetch_headers_timeout"); };
  let received = 0;
  const server = createServer((req, res) => {
    received += 1;
    assert.equal(req.headers["x-avo-tool-token"], "local-token");
    setTimeout(() => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ artifact_id: "finished-after-retries" })); }, 350);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const result = await internalToolRequest(`http://127.0.0.1:${port}/tool`, "local-token", {}, 1000);
    assert.equal(result.artifact_id, "finished-after-retries");
    assert.equal(received, 1);
  } finally { globalThis.fetch = originalFetch; await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("visual review context survives reconstruction, is role/run isolated, bounded and private", async () => {
  const dir = await mkdtemp(join(tmpdir(), "avo-review-context-"));
  try {
    const verifier = new ReviewContext(dir, "verifier", "model-a");
    for (let i = 0; i < 6; i++) await verifier.append("run-1", { prompt: `frame-${i}`, reply: `feedback-${i}`, images: [{ label: "candidate", path: "/controlled/blob.png" }] });
    const restored = await new ReviewContext(dir, "verifier", "model-a").read("run-1");
    assert.equal(restored.length, 4);
    assert.equal(restored[0]?.prompt, "frame-2");
    assert.equal(restored[3]?.images[0]?.path, "/controlled/blob.png");
    assert.deepEqual(await new ReviewContext(dir, "supervisor", "model-a").read("run-1"), []);
    assert.deepEqual(await verifier.read("run-2"), []);
    assert.deepEqual(await new ReviewContext(dir, "verifier", "model-b").read("run-1"), []);
    assert.equal((await stat(join(dir, "sealed", "review-context"))).mode & 0o077, 0);
    const original = await sharp({ create: { width: 2400, height: 1200, channels: 3, background: "#56789a" } }).png().toBuffer();
    const sourcePath = join(dir, "original.png");
    await writeFile(sourcePath, original);
    const previewPath = await verifier.preview(sourcePath);
    assert.equal(previewPath, await verifier.preview(sourcePath));
    const metadata = await sharp(previewPath).metadata();
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 512);
    assert.ok((await readFile(sourcePath)).equals(original));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("reverse agreement includes blocker verdicts rather than preference alone", () => {
  const frame = { axes: [{ id: "texture", importance: "blocker" }, { id: "color", importance: "minor" }] } as EvaluationFrameRevision;
  const pass = { axis_judgments: [{ axis_id: "texture", verdict: "pass" }] };
  const fail = { axis_judgments: [{ axis_id: "texture", verdict: "fail" }] };
  assert.notEqual(blockerSignature(pass, frame), blockerSignature(fail, frame));
});

test("native Responses stream finishes on the completed event and reports non-JSON gateway errors clearly", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n'));
      controller.enqueue(encoder.encode('data: {"type":"response.completed","response":{"id":"native-response","output":[]}}\n\n'));
      // Deliberately stay open; the reader must stop after response.completed.
    },
  });
  const result = await responsesBody(new Response(stream, { headers: { "content-type": "text/event-stream" } }));
  assert.equal(result.id, "native-response");
  await assert.rejects(responsesBody(new Response("<html>gateway timeout</html>", { status: 524, headers: { "content-type": "text/html" } })), /responses_provider_http_524:non_json_response/);
});
