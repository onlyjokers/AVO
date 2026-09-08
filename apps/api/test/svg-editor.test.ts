import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import sharp from "sharp";
import { taskManifestSchema, type RunSnapshot } from "@avo/contracts";
import { ArtifactStore, AvoRunner, FakeAgentProvider, FakeImageProvider, FakeVerifierProvider, FileStateStore, type AgentRoundContext, type AgentToolbox } from "@avo/core";
import { SvgEditor, SVG_OPERATIONS, validateSvgParameters } from "../src/svg-editor.ts";
import { experimentalToolNames, allowedAvoTools } from "../src/experimental-tools.ts";
import { experimentPrompt } from "../src/experiment-runtime.ts";
import { AVO_MCP_TOOL_ALLOWLIST, validateAvoMcpInventory } from "../src/codex-provider.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

test("baseline exposes exactly the original tool inventory and no experimental prompt", () => {
  const context = { run: { config: {} } } as unknown as AgentRoundContext;
  assert.equal(experimentPrompt(context), "");
  assert.deepEqual(experimentalToolNames(), []);
  assert.deepEqual(experimentalToolNames({ svg_editing: false, iterative_search: false, copilot_routing: false }), []);
  const inventory = { data: [{ name: "avo", tools: Object.fromEntries(AVO_MCP_TOOL_ALLOWLIST.map((name) => [name, {}])) }] };
  assert.equal(validateAvoMcpInventory(inventory).length, AVO_MCP_TOOL_ALLOWLIST.length);
  const features = { svg_editing: true, iterative_search: true, copilot_routing: true };
  assert.throws(() => validateAvoMcpInventory(inventory, features), /inventory_violation/);
  for (const name of experimentalToolNames(features)) inventory.data[0]!.tools[name] = {};
  delete inventory.data[0]!.tools.avo_generate_image;
  assert.equal(validateAvoMcpInventory(inventory, features).length, AVO_MCP_TOOL_ALLOWLIST.length + 6);
  assert.throws(() => validateAvoMcpInventory(inventory), /inventory_violation/);
});

test("SVG parameter boundary rejects external resources and raw document/file access", () => {
  for (const value of [
    { href: "https://example.com" }, { path: "/private/target.png" }, { document_id: "other" },
    { data_base64: "xx" }, { style: { fill: "url(file:///secret)" } }, { style: { fill: "url(https://example.com/a)" } },
    { svg: "<svg/>" }, { x: Infinity }, { name: "<!ENTITY x SYSTEM 'file:///etc/passwd'>" },
  ]) assert.throws(() => validateSvgParameters(value));
  validateSvgParameters({ target: "layer-1", opacity: 0.4, style: { fill: "url(#gradient-1)", font_size: 30 }, points: [1, 2, 3] });
  assert.ok(!SVG_OPERATIONS.includes("import_svg" as never));
  assert.ok(!SVG_OPERATIONS.includes("render_svg" as never));
});

test("disabled SVG rejects before launching engine", async () => {
  let launched = false;
  const editor = new SvgEditor({ dataDir: "/unused", command: "/unused", factory: async () => { launched = true; throw new Error("unexpected"); } });
  const tools = { getRunSnapshot: () => ({ config: {} }) } as unknown as AgentToolbox;
  await assert.rejects(editor.capabilities(tools), /svg_editing_disabled/);
  await assert.rejects(editor.open(tools, "source"), /svg_editing_disabled/);
  assert.equal(launched, false);
});

test("real MCP transport advertises each ablation arm's exact tools", async () => {
  const root = fileURLToPath(new URL("../../..", import.meta.url));
  const arms = [
    { svg_editing: false, iterative_search: false, copilot_routing: false },
    { svg_editing: true, iterative_search: false, copilot_routing: false },
    { svg_editing: true, iterative_search: true, copilot_routing: false },
    { svg_editing: true, iterative_search: false, copilot_routing: true },
    { svg_editing: true, iterative_search: true, copilot_routing: true },
  ];
  for (const features of arms) {
    const client = new Client({ name: "ablation-inventory-test", version: "1" });
    const transport = new StdioClientTransport({
      command: join(root, "node_modules/.bin/tsx"), args: [join(root, "apps/api/src/mcp-server.ts")],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", AVO_INTERNAL_API: "http://127.0.0.1:1", AVO_TOOL_TOKEN: "inventory-test-only", AVO_EXPERIMENTAL_FEATURES: JSON.stringify(features) },
      stderr: "pipe",
    });
    try {
      await client.connect(transport);
      const actual = (await client.listTools()).tools.map((tool) => tool.name).sort();
      assert.deepEqual(actual, allowedAvoTools(AVO_MCP_TOOL_ALLOWLIST, features).sort());
    } finally { await client.close(); }
  }
});

test("real svg-mcp renders full-size candidate, persists revisions, and passes normal evaluation path", {
  skip: !process.env.AVO_TEST_SVG_MCP_COMMAND,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "avo-svg-live-"));
  const artifacts = new ArtifactStore(directory), store = new FileStateStore(directory);
  const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#516b85" } }).png().toBuffer();
  const source = await artifacts.put({ bytes, mimeType: "image/png", originalName: "source.png" });
  const task = taskManifestSchema.parse({
    schema_version: 2, id: "svg-test", title: "SVG smoke", user_brief: "Add a small white label, retain the image.",
    source_artifact_id: source.id, references: [], has_hidden_evaluation: false, created_at: new Date().toISOString(),
  });
  await store.saveTask(task);
  const editor = new SvgEditor({ dataDir: directory, command: process.env.AVO_TEST_SVG_MCP_COMMAND! });
  let resultRun: RunSnapshot | undefined;
  let runId: string | undefined;
  class SvgAgent extends FakeAgentProvider {
    override async runRound(context: AgentRoundContext, tools: AgentToolbox) {
      await tools.selectParent(source.id, "Deterministic SVG test parent");
      const opened = await editor.open(tools, source.id);
      const added = await editor.edit(tools, opened.document_id, "add_text", {
        x: 20, y: 45, content: "TEST", name: "label", style: { fill: "#ffffff", font_size: "28px" }, themed: false,
      });
      assert.equal(added.revision, 2);
      const preview = await editor.preview(tools, opened.document_id);
      assert.equal(preview.mime_type, "image/png");
      assert.ok(Buffer.from(preview.bytes_base64, "base64").length > 100);
      const result = await editor.finalize(tools, opened.document_id, "Add a small white test label as an SVG text node.");
      const again = await editor.finalize(tools, opened.document_id, "Add a small white test label as an SVG text node.");
      assert.equal(again.artifact_id, result.artifact_id);
      assert.equal(tools.getRunSnapshot().generation_count, 1);
      const candidate = tools.getRunSnapshot().drafts.at(-1)!;
      assert.equal(candidate.viewed_at, undefined);
      assert.equal(candidate.creation_method, "svg_edit");
      assert.deepEqual(candidate.dimensions.final, { width: 320, height: 200 });
      assert.notEqual(candidate.artifact_id, source.id);
      const raster = await sharp((await artifacts.get(candidate.artifact_id)).bytes).removeAlpha().raw().toBuffer();
      let lightPixels = 0;
      for (let i = 0; i < raster.length; i += 3) if (raster[i]! > 220 && raster[i + 1]! > 220 && raster[i + 2]! > 220) lightPixels++;
      assert.ok(lightPixels > 20, "text must render as actual light pixels, not only appear in the SVG source");
      const saved = await readFile(join(directory, "runs", context.run.id, "svg-documents", opened.document_id, "2.svg"), "utf8");
      assert.ok(saved.includes("TEST"));
      await tools.viewImage(result.artifact_id);
      const evaluation = await tools.evaluateDraft(candidate.id);
      assert.equal(evaluation.draft_id, candidate.id);
      await tools.abandonStep("smoke_complete", { observation: "Rendered and evaluated.", hypothesis: "The tool boundary works.", intervention: "SVG edit" });
    }
  }
  try {
    const runner = new AvoRunner(store, artifacts, new SvgAgent(), new FakeImageProvider(), new FakeVerifierProvider(1));
    const run = await runner.createRun(task.id, { mode: "avo", max_generations: 1, supervisor_enabled: false, experimental_features: { svg_editing: true, iterative_search: false, copilot_routing: false } });
    runId = run.id;
    resultRun = await runner.start(run.id);
    assert.notEqual(resultRun.status, "failed", resultRun.terminal_reason);
    assert.equal(resultRun.generation_count, 1);
    assert.equal(resultRun.evaluations.length, 1);
    assert.notEqual(resultRun.status, "failed", resultRun.terminal_reason);
  } finally {
    if (runId) await editor.closeRun(runId);
    await rm(directory, { recursive: true, force: true });
  }
});
