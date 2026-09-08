import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { AgentRoundContext, AgentToolbox } from "@avo/core";
import type { RunSnapshot } from "@avo/contracts";
import { photoRecipeSchema, photoRecipeKey, renderPhoto } from "../src/photo-editor.ts";
import { AgentToolBroker } from "../src/tool-broker.ts";
import { detailSheet } from "../src/visual-detail.ts";

const pixels = async () => {
  const data = Buffer.alloc(32 * 24 * 4);
  for (let i = 0; i < data.length; i++) data[i] = (i * 17 + 63) % 256;
  return { data, png: await sharp(data, { raw: { width: 32, height: 24, channels: 4 } }).png().toBuffer() };
};
const raw = (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer();

test("neutral recipe is pixel-exact, preserves alpha/dimensions and is repeatable from base", async () => {
  const { data, png } = await pixels();
  const neutral = await renderPhoto(png, {});
  assert.deepEqual(await raw(neutral.bytes), data);
  assert.deepEqual(neutral.dimensions, { width: 32, height: 24 });
  const recipe = { exposure_ev: 0.3, temperature: 0.2, shadows: 0.1, highlights: -0.2, saturation: 1.1 };
  const one = await renderPhoto(png, recipe);
  const two = await renderPhoto(png, recipe);
  assert.deepEqual(one.bytes, two.bytes);
  const changed = await raw(one.bytes);
  assert.notDeepEqual(changed, data);
  for (let i = 3; i < data.length; i += 4) assert.equal(changed[i], data[i]);
  assert.deepEqual(await raw((await renderPhoto(png, {})).bytes), data);
  assert.equal(photoRecipeKey("base", photoRecipeSchema.parse({})), photoRecipeKey("base", photoRecipeSchema.parse({ saturation: 1 })));
  assert.notEqual(photoRecipeKey("base", photoRecipeSchema.parse({})), photoRecipeKey("other", photoRecipeSchema.parse({})));
});

test("exposure is applied in linear sRGB, not by doubling encoded bytes", async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: { r: 128, g: 128, b: 128 } } }).png().toBuffer();
  const output = await raw((await renderPhoto(png, { exposure_ev: 1 })).bytes);
  assert.equal(output[0], 176);
  assert.equal(output[1], 176);
  assert.equal(output[2], 176);
});

test("region adjustment preserves every pixel outside the region and rejects invalid controls", async () => {
  const { png, data } = await pixels();
  const result = await renderPhoto(png, { exposure_ev: 1, region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5, feather: 0 } });
  const output = await raw(result.bytes);
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) if (x < 8 || x >= 24 || y < 6 || y >= 18) {
    const i = (y * 32 + x) * 4;
    assert.deepEqual(output.subarray(i, i + 4), data.subarray(i, i + 4));
  }
  await assert.rejects(renderPhoto(png, { exposure_ev: Infinity }));
  await assert.rejects(renderPhoto(png, { region: { x: 0.8, y: 0, width: 0.5, height: 1 } }));
  await assert.rejects(renderPhoto(png, { arbitrary_command: "no" }));
});

test("photo broker requires preview, public base, matching parent and enabled feature", async () => {
  const directory = await mkdtemp(join(tmpdir(), "avo-photo-test-"));
  try {
    const { png } = await pixels();
    const path = join(directory, "source.png");
    await writeFile(path, png);
    const run = { id: "run-photo", status: "running", active_variation_attempt: 1,
      config: { max_generations: 24, max_generations_per_round: 24, max_wall_time_ms: 5_400_000,
        experimental_features: { photo_adjustments: true, svg_editing: false, iterative_search: false, copilot_routing: false } },
      drafts: [], evaluations: [], generation_count: 0, parent_selection: { artifact_id: "source" },
    } as unknown as RunSnapshot;
    let calls = 0;
    const tools = {
      getRunSnapshot: () => run, recordAgentRuntime: async () => {}, setStepDeadline: async () => {},
      listImagePool: async () => [{ artifactId: "source", path }],
      recordEditedDraft: async (input: Parameters<AgentToolbox["recordEditedDraft"]>[0]) => {
        calls++;
        assert.equal(input.photoEdit?.base_artifact_id, "source");
        assert.equal(input.edit, undefined);
        run.drafts.push({ id: "draft-photo", artifact_id: "result", photo_edit: input.photoEdit } as RunSnapshot["drafts"][number]);
        return "result";
      },
    } as unknown as AgentToolbox;
    const broker = new AgentToolBroker();
    const close = broker.register("photo-test", tools, { run, task: { source_artifact_id: "source" } } as AgentRoundContext);
    try {
      const args = { base_artifact_id: "source", recipe: { exposure_ev: 0.2 }, description: "Lift exposure" };
      await assert.rejects(broker.invoke("photo-test", "avo_photo_finalize", args), /must_be_previewed/);
      const preview = await broker.invoke("photo-test", "avo_photo_preview", args) as Record<string, unknown>;
      assert.equal(preview.mime_type, "image/png");
      assert.equal(calls, 0);
      await assert.rejects(broker.invoke("photo-test", "avo_photo_finalize", { ...args, recipe: { exposure_ev: 0.3 } }), /must_be_previewed/);
      assert.equal((await broker.invoke("photo-test", "avo_photo_finalize", args) as Record<string, unknown>).artifact_id, "result");
      assert.equal((await broker.invoke("photo-test", "avo_photo_finalize", args) as Record<string, unknown>).deduplicated, true);
      assert.equal(calls, 1);
      await assert.rejects(broker.invoke("photo-test", "avo_photo_preview", { ...args, base_artifact_id: "hidden" }), /parent_selection/);
      await assert.rejects(broker.invoke("photo-test", "avo_view_detail", { artifact_id: "hidden", region: { x: 0, y: 0, width: 1, height: 1 } }), /public_pool/);
      run.config.experimental_features!.photo_adjustments = false;
      await assert.rejects(broker.invoke("photo-test", "avo_photo_preview", args), /experimental_tool_disabled/);
    } finally { close(); }
    const sheet = await detailSheet([path, path]);
    const metadata = await sharp(sheet).metadata();
    assert.equal(metadata.width, 640);
    assert.equal(metadata.height, 1600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
