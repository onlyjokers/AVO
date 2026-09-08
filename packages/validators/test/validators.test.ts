import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { preservationContractSchema } from "@avo/contracts";
import { DeterministicImageValidators } from "../src/index.ts";

const fixture = async () => sharp({
  create: { width: 320, height: 240, channels: 3, background: { r: 120, g: 155, b: 190 } },
}).composite([
  { input: Buffer.from(`<svg width="320" height="240"><rect x="30" y="30" width="100" height="70" fill="#f7d154"/><circle cx="220" cy="130" r="52" fill="#29344f"/></svg>`) },
]).png().toBuffer();

test("identical image has no severe quality debt", async () => {
  const source = await fixture();
  const validator = new DeterministicImageValidators();
  const result = await validator.evaluate({
    source,
    parent: source,
    candidate: source,
    preservation: preservationContractSchema.parse({}),
  });
  assert.deepEqual(result.hard_blockers, []);
  assert.ok(result.analysis.elapsed_ms < 5_000);
});

test("severe blur is reported as deterministic detail debt", async () => {
  const source = await fixture();
  const blurred = await sharp(source).blur(8).png().toBuffer();
  const validator = new DeterministicImageValidators();
  const result = await validator.evaluate({
    source,
    parent: source,
    candidate: blurred,
    preservation: preservationContractSchema.parse({ detail: "preserve" }),
  });
  assert.ok(result.source_quality_debt.detail.some((metric) => metric.severity !== "ok"));
});

test("new high-frequency texture raises a diagnostic without pretending to detect semantic realism", async () => {
  const source = await fixture();
  const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const changed = Buffer.from(data);
  for (let i = 0; i < changed.length; i++) changed[i] = Math.max(0, Math.min(255,
    data[i]! + ((Math.floor(i / info.channels) % info.width) % 4 < 2 ? 30 : -30)));
  const candidate = await sharp(changed, { raw: info }).png().toBuffer();
  const result = await new DeterministicImageValidators().evaluate({ source, parent: source, candidate,
    preservation: preservationContractSchema.parse({ detail: "preserve" }) });
  const growth = result.source_quality_debt.detail.filter((item) => item.id.endsWith("_growth"));
  assert.equal(growth.length, 2);
  assert.ok(growth.some((item) => item.severity === "warn"));
  assert.ok(growth.every((item) => item.severity !== "severe"));
  assert.ok(growth.every((item) => !result.hard_blockers.includes(item.id)));
});

test("posterization and clipping produce non-ok debt signals", async () => {
  const source = await fixture();
  const raw = await sharp(source).raw().toBuffer({ resolveWithObject: true });
  const damaged = Buffer.from(raw.data.map((value) => value < 40 ? 0 : value > 215 ? 255 : Math.round(value / 32) * 32));
  const candidate = await sharp(damaged, { raw: raw.info }).png().toBuffer();
  const validator = new DeterministicImageValidators();
  const result = await validator.evaluate({
    source,
    parent: source,
    candidate,
    preservation: preservationContractSchema.parse({}),
  });
  const signals = [...result.source_quality_debt.banding, ...result.source_quality_debt.clipping];
  assert.ok(signals.some((metric) => metric.severity !== "ok"));
});

test("large color cast is visible in the Lab drift vector", async () => {
  const source = await fixture();
  const shifted = await sharp(source).tint({ r: 255, g: 105, b: 95 }).png().toBuffer();
  const result = await new DeterministicImageValidators().evaluate({
    source,
    parent: source,
    candidate: shifted,
    preservation: preservationContractSchema.parse({ color: "preserve" }),
  });
  assert.ok(result.source_quality_debt.color.some((metric) => metric.severity !== "ok"));
});

test("provider-native aspect ratio changes remain diagnostic instead of blocking commit", async () => {
  const source = await fixture();
  const candidate = await sharp(source).resize({ width: 320, height: 160, fit: "fill" }).png().toBuffer();
  const result = await new DeterministicImageValidators().evaluate({
    source,
    parent: source,
    candidate,
    preservation: preservationContractSchema.parse({ composition: "preserve" }),
  });
  assert.equal(result.source_quality_debt.structure.find((metric) => metric.id === "aspect_ratio_drift")?.severity, "severe");
  assert.equal(result.hard_blockers.includes("aspect_ratio_drift"), false);
});

test("heavy JPEG damage raises blockiness or detail debt", async () => {
  const source = await fixture();
  const jpeg = await sharp(source).jpeg({ quality: 5, chromaSubsampling: "4:2:0" }).toBuffer();
  const result = await new DeterministicImageValidators().evaluate({
    source,
    parent: source,
    candidate: jpeg,
    preservation: preservationContractSchema.parse({ detail: "preserve" }),
  });
  assert.ok([...result.source_quality_debt.blockiness, ...result.source_quality_debt.detail]
    .some((metric) => metric.severity !== "ok"));
});

test("invalid and nearly transparent inputs fail closed", async () => {
  const source = await fixture();
  const validator = new DeterministicImageValidators();
  await assert.rejects(validator.evaluate({
    source,
    parent: source,
    candidate: Buffer.from("not-an-image"),
    preservation: preservationContractSchema.parse({}),
  }));
  const transparent = await sharp({ create: { width: 320, height: 240, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const result = await validator.evaluate({
    source,
    parent: source,
    candidate: transparent,
    preservation: preservationContractSchema.parse({}),
  });
  assert.ok(result.hard_blockers.includes("transparent_or_empty_ratio"));
});
