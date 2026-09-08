import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";

export const photoRegionSchema = z.object({
  x: z.number().min(0).max(1), y: z.number().min(0).max(1),
  width: z.number().positive().max(1), height: z.number().positive().max(1),
  feather: z.number().min(0).max(0.5).default(0.1),
}).strict().refine((r) => r.x + r.width <= 1 && r.y + r.height <= 1, "region_out_of_bounds");

export const photoRecipeSchema = z.object({
  exposure_ev: z.number().min(-3).max(3).default(0),
  contrast: z.number().min(0.5).max(1.5).default(1),
  shadows: z.number().min(-1).max(1).default(0),
  highlights: z.number().min(-1).max(1).default(0),
  temperature: z.number().min(-1).max(1).default(0),
  tint: z.number().min(-1).max(1).default(0),
  saturation: z.number().min(0).max(2).default(1),
  region: photoRegionSchema.optional(),
}).strict();
export type PhotoRecipe = z.infer<typeof photoRecipeSchema>;
export const PHOTO_ENGINE_REVISION = "linear-srgb-photo-v1";
export const photoRecipeKey = (base: string, recipe: PhotoRecipe) => createHash("sha256")
  .update(JSON.stringify({ engine: PHOTO_ENGINE_REVISION, base, recipe: photoRecipeSchema.parse(recipe) })).digest("hex");

const linear = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const encoded = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const smooth = (v: number) => { const t = clamp(v); return t * t * (3 - 2 * t); };

export async function renderPhoto(bytes: Buffer, input: unknown) {
  const recipe = photoRecipeSchema.parse(input);
  const { data, info } = await sharp(bytes).rotate().toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  const gain = [2 ** (recipe.temperature * 0.25 + recipe.tint * 0.125), 2 ** (-recipe.tint * 0.25), 2 ** (-recipe.temperature * 0.25 + recipe.tint * 0.125)];
  let clipped = 0;
  let affected = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    const pixel = i / 4;
    const x = (pixel % info.width + 0.5) / info.width;
    const y = (Math.floor(pixel / info.width) + 0.5) / info.height;
    let weight = 1;
    if (recipe.region) {
      const r = recipe.region;
      if (x < r.x || x > r.x + r.width || y < r.y || y > r.y + r.height) continue;
      if (r.feather > 0) weight = smooth(Math.min((x - r.x) / r.width, (r.x + r.width - x) / r.width,
        (y - r.y) / r.height, (r.y + r.height - y) / r.height) / r.feather);
    }
    const original = [linear(data[i]! / 255), linear(data[i + 1]! / 255), linear(data[i + 2]! / 255)];
    const luma = 0.2126 * original[0]! + 0.7152 * original[1]! + 0.0722 * original[2]!;
    // Local tone weights depend on the immutable input, never a preceding preview.
    const tone = 2 ** (recipe.exposure_ev + recipe.shadows * (1 - smooth(luma / 0.5))
      + recipe.highlights * smooth((luma - 0.25) / 0.75));
    const rgb = original.map((value, channel) => (value * tone * gain[channel]! - 0.18) * recipe.contrast + 0.18);
    const adjustedLuma = 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
    for (let c = 0; c < 3; c++) {
      const target = adjustedLuma + (rgb[c]! - adjustedLuma) * recipe.saturation;
      const value = original[c]! + weight * (target - original[c]!);
      if (value < 0 || value > 1) clipped++;
      output[i + c] = Math.round(clamp(encoded(clamp(value))) * 255);
    }
    affected++;
  }
  return {
    bytes: await sharp(output, { raw: info }).png().toBuffer(), recipe,
    dimensions: { width: info.width, height: info.height },
    diagnostics: { affected_pixels: affected, clipped_channels: clipped,
      warning: "Clipping is a partial measurement, not a realism or task-success score. Temperature/tint are relative linear RGB gains, not calibrated Kelvin. No content synthesis, denoising or geometric edits are performed." },
  };
}
