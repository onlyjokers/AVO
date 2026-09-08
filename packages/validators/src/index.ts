import { createHash } from "node:crypto";
import sharp from "sharp";
import type {
  PreservationContract,
  QualityDebtVector,
  QualityMetric,
} from "@avo/contracts";

export type QualityEvaluation = {
  source_quality_debt: QualityDebtVector;
  step_quality_debt: QualityDebtVector;
  hard_blockers: string[];
  warnings: string[];
  analysis: {
    source: { width: number; height: number };
    parent: { width: number; height: number };
    candidate: { width: number; height: number };
    elapsed_ms: number;
    calibration_key: string;
  };
};

type ImageSignals = {
  width: number;
  height: number;
  alphaEmptyRatio: number;
  alphaPartialRatio: number;
  meanLab: [number, number, number];
  colorHistogram: number[];
  temperature: number;
  shadowClip: number;
  highlightClip: number;
  dynamicRange: number;
  sobel: number;
  laplacian: number;
  highFrequency: number;
  banding: number;
  blockiness8: number;
  blockiness16: number;
  luminance: Float32Array;
};

type Calibration = {
  key: string;
  colorWarn: number;
  colorSevere: number;
  detailWarn: number;
  detailSevere: number;
  bandingWarn: number;
  bandingSevere: number;
  blockinessWarn: number;
  blockinessSevere: number;
  clippingWarn: number;
  clippingSevere: number;
};

const emptyDebt = (): QualityDebtVector => ({
  integrity: [],
  color: [],
  clipping: [],
  detail: [],
  banding: [],
  blockiness: [],
  structure: [],
});

const metric = (
  id: string,
  value: number | undefined,
  unit: string,
  severity: QualityMetric["severity"],
  thresholdSource: QualityMetric["threshold_source"],
  detail?: string,
): QualityMetric => ({
  id,
  ...(value === undefined || !Number.isFinite(value) ? {} : { value }),
  unit,
  severity,
  confidence: value === undefined ? 0 : 0.92,
  threshold_source: thresholdSource,
  ...(detail ? { detail } : {}),
});

const severityForHigher = (value: number, warn: number, severe: number): QualityMetric["severity"] =>
  value >= severe ? "severe" : value >= warn ? "warn" : "ok";

const severityForLower = (value: number, warn: number, severe: number): QualityMetric["severity"] =>
  value <= severe ? "severe" : value <= warn ? "warn" : "ok";

export class DeterministicImageValidators {
  private readonly calibrations = new Map<string, Promise<Calibration>>();

  async evaluate(input: {
    source: Buffer;
    parent: Buffer;
    candidate: Buffer;
    preservation: PreservationContract;
  }): Promise<QualityEvaluation> {
    const started = performance.now();
    const calibrationKey = createHash("sha256").update(input.source).digest("hex");
    const calibrationPromise = this.calibrations.get(calibrationKey)
      ?? this.calibrate(input.source, calibrationKey);
    this.calibrations.set(calibrationKey, calibrationPromise);

    const [source, parent, candidate, calibration] = await Promise.all([
      analyseImage(input.source),
      analyseImage(input.parent),
      analyseImage(input.candidate),
      calibrationPromise,
    ]);

    const sourceDebt = compareSignals(source, candidate, calibration, input.preservation, "source");
    const stepDebt = compareSignals(parent, candidate, calibration, input.preservation, "step");
    const hardBlockers = collectGateBlockers(sourceDebt, input.preservation);
    const warnings = collectWarnings(sourceDebt, stepDebt);

    return {
      source_quality_debt: sourceDebt,
      step_quality_debt: stepDebt,
      hard_blockers: hardBlockers,
      warnings,
      analysis: {
        source: { width: source.width, height: source.height },
        parent: { width: parent.width, height: parent.height },
        candidate: { width: candidate.width, height: candidate.height },
        elapsed_ms: Math.round(performance.now() - started),
        calibration_key: calibration.key,
      },
    };
  }

  private async calibrate(source: Buffer, key: string): Promise<Calibration> {
    const base = await analyseImage(source, 512);
    const fixtures = await createCalibrationFixtures(source);
    const signals = await Promise.all(fixtures.map((fixture) => analyseImage(fixture.bytes, 512)));
    const byLabel = new Map(fixtures.map((fixture, index) => [fixture.label, signals[index]!]));
    const color = (label: string) => deltaE2000(base.meanLab, byLabel.get(label)!.meanLab);
    const detailLoss = (label: string) => ratioLoss(base.highFrequency, byLabel.get(label)!.highFrequency);
    const bandingGain = (label: string) => Math.max(0, byLabel.get(label)!.banding - base.banding);
    const blockinessGain = (label: string) => Math.max(0, byLabel.get(label)!.blockiness8 - base.blockiness8);
    const clipGain = (label: string) => Math.max(0,
      byLabel.get(label)!.shadowClip + byLabel.get(label)!.highlightClip - base.shadowClip - base.highlightClip,
    );
    return {
      key,
      colorWarn: Math.max(2, color("color-moderate") * 0.7),
      colorSevere: Math.max(7, color("color-severe") * 0.8),
      detailWarn: Math.max(0.08, detailLoss("blur-moderate") * 0.65),
      detailSevere: Math.max(0.28, detailLoss("blur-severe") * 0.8),
      bandingWarn: Math.max(0.03, bandingGain("quantize-moderate") * 0.65),
      bandingSevere: Math.max(0.12, bandingGain("quantize-severe") * 0.8),
      blockinessWarn: Math.max(0.08, blockinessGain("jpeg-moderate") * 0.65),
      blockinessSevere: Math.max(0.25, blockinessGain("jpeg-severe") * 0.8),
      clippingWarn: Math.max(0.02, clipGain("clip-moderate") * 0.65),
      clippingSevere: Math.max(0.09, clipGain("clip-severe") * 0.8),
    };
  }
}

const compareSignals = (
  reference: ImageSignals,
  candidate: ImageSignals,
  calibration: Calibration,
  preservation: PreservationContract,
  scope: "source" | "step",
): QualityDebtVector => {
  const debt = emptyDebt();
  const alphaEmpty = candidate.alphaEmptyRatio;
  debt.integrity.push(
    metric("decode_integrity", 1, "boolean", "ok", "absolute"),
    metric("transparent_or_empty_ratio", alphaEmpty, "ratio", severityForHigher(alphaEmpty, 0.05, 0.8), "absolute"),
    metric("partial_alpha_ratio", candidate.alphaPartialRatio, "ratio", severityForHigher(candidate.alphaPartialRatio, 0.05, 0.25), "absolute"),
  );

  const aspectDrift = Math.abs(
    (candidate.width / candidate.height) / (reference.width / reference.height) - 1,
  );
  debt.structure.push(metric(
    "aspect_ratio_drift",
    aspectDrift,
    "ratio",
    preservation.composition === "preserve"
      ? severityForHigher(aspectDrift, 0.015, 0.08)
      : severityForHigher(aspectDrift, 0.08, 0.25),
    "absolute",
  ));

  const colorDelta = deltaE2000(reference.meanLab, candidate.meanLab);
  const histogramDelta = histogramDistance(reference.colorHistogram, candidate.colorHistogram);
  const temperatureDrift = Math.abs(candidate.temperature - reference.temperature);
  const colorMultiplier = preservation.color === "preserve" ? 1 : 2;
  debt.color.push(
    metric("mean_lab_delta_e2000", colorDelta, "delta_e", severityForHigher(
      colorDelta,
      calibration.colorWarn * colorMultiplier,
      calibration.colorSevere * colorMultiplier,
    ), "calibrated"),
    metric("lab_histogram_l1", histogramDelta, "distance", severityForHigher(histogramDelta, 0.16 * colorMultiplier, 0.38 * colorMultiplier), "heuristic"),
    metric("color_temperature_drift", temperatureDrift, "normalized", severityForHigher(temperatureDrift, 0.04 * colorMultiplier, 0.14 * colorMultiplier), "heuristic"),
  );

  const clippingIncrease = Math.max(0,
    candidate.shadowClip + candidate.highlightClip - reference.shadowClip - reference.highlightClip,
  );
  const rangeRetention = retention(reference.dynamicRange, candidate.dynamicRange);
  debt.clipping.push(
    metric("shadow_clipping", candidate.shadowClip, "ratio", severityForHigher(candidate.shadowClip, 0.05, 0.18), "absolute"),
    metric("highlight_clipping", candidate.highlightClip, "ratio", severityForHigher(candidate.highlightClip, 0.05, 0.18), "absolute"),
    metric("clipping_increase", clippingIncrease, "ratio", severityForHigher(clippingIncrease, calibration.clippingWarn, calibration.clippingSevere), "calibrated"),
    metric("dynamic_range_retention", rangeRetention, "ratio", severityForLower(rangeRetention, 0.82, 0.55), "heuristic"),
  );

  const hfRetention = retention(reference.highFrequency, candidate.highFrequency);
  const sobelRetention = retention(reference.sobel, candidate.sobel);
  const laplacianRetention = retention(reference.laplacian, candidate.laplacian);
  const detailMultiplier = preservation.detail === "preserve" ? 1 : 1.7;
  debt.detail.push(
    metric("high_frequency_retention", hfRetention, "ratio", severityForLower(hfRetention, 1 - calibration.detailWarn * detailMultiplier, 1 - calibration.detailSevere * detailMultiplier), "calibrated"),
    metric("sobel_retention", sobelRetention, "ratio", severityForLower(sobelRetention, 0.97 / detailMultiplier, 0.6 / detailMultiplier), "heuristic"),
    metric("laplacian_retention", laplacianRetention, "ratio", severityForLower(laplacianRetention, 0.9 / detailMultiplier, 0.45 / detailMultiplier), "heuristic"),
    metric("high_frequency_growth", hfRetention, "ratio", hfRetention > 1.5 ? "warn" : "ok", "heuristic",
      "High-frequency growth is not recovered detail. It can reflect legitimate contrast, sharpening, noise or invented texture; inspect matched Source/Parent/Candidate crops. Never a hard gate."),
    metric("laplacian_growth", laplacianRetention, "ratio", laplacianRetention > 1.5 ? "warn" : "ok", "heuristic",
      "Edge-energy growth cannot prove realism. Check repeated/embossed patterns visually; this diagnostic is not calibrated as a semantic defect detector."),
  );

  const bandingIncrease = Math.max(0, candidate.banding - reference.banding);
  debt.banding.push(metric("smooth_region_banding", bandingIncrease, "ratio", severityForHigher(
    bandingIncrease,
    calibration.bandingWarn,
    calibration.bandingSevere,
  ), "calibrated"));

  const blockiness8 = Math.max(0, candidate.blockiness8 - reference.blockiness8);
  const blockiness16 = Math.max(0, candidate.blockiness16 - reference.blockiness16);
  debt.blockiness.push(
    metric("blockiness_8px", blockiness8, "ratio", severityForHigher(blockiness8, calibration.blockinessWarn, calibration.blockinessSevere), "calibrated"),
    metric("blockiness_16px", blockiness16, "ratio", severityForHigher(blockiness16, calibration.blockinessWarn, calibration.blockinessSevere), "calibrated"),
  );

  const structural = multiscaleStructuralSimilarity(reference, candidate);
  const edge = edgeConsistency(reference, candidate);
  const stableConfidence = stableRegionConfidence(reference, candidate);
  const preserveStructure = preservation.composition === "preserve";
  debt.structure.push(
    metric("multiscale_structure_similarity", structural, "similarity", severityForLower(structural, preserveStructure ? 0.72 : 0.55, preserveStructure ? 0.42 : 0.3), "heuristic"),
    metric("edge_consistency", edge, "similarity", severityForLower(edge, preserveStructure ? 0.68 : 0.5, preserveStructure ? 0.35 : 0.25), "heuristic"),
    {
      id: "automatic_stable_region_confidence",
      value: stableConfidence,
      unit: "confidence",
      severity: "unavailable",
      confidence: stableConfidence,
      threshold_source: "heuristic",
      detail: "Heuristic diagnostic only; never used as a hard gate without a user or model-provided mask.",
    },
  );

  for (const metrics of Object.values(debt)) {
    for (const item of metrics) {
      if (item.detail === undefined) item.detail = `${scope} comparison`;
    }
  }
  return debt;
};

const collectGateBlockers = (debt: QualityDebtVector, preservation: PreservationContract) => {
  const blockers: string[] = [];
  const severe = (group: keyof QualityDebtVector) => debt[group].filter((item) => item.severity === "severe");
  blockers.push(...severe("integrity").map((item) => item.id));
  if (preservation.detail === "preserve") blockers.push(...severe("detail").map((item) => item.id));
  blockers.push(...severe("clipping").map((item) => item.id));
  blockers.push(...severe("banding").map((item) => item.id));
  blockers.push(...severe("blockiness").map((item) => item.id));
  return [...new Set(blockers)];
};

const collectWarnings = (...vectors: QualityDebtVector[]) => [...new Set(vectors.flatMap((vector) =>
  Object.values(vector).flatMap((metrics) => metrics
    .filter((item) => item.severity === "warn")
    .map((item) => item.id)),
))];

const analyseImage = async (bytes: Buffer, maxEdge = 1024): Promise<ImageSignals> => {
  const metadata = await sharp(bytes, { failOn: "error" }).metadata();
  if (!metadata.width || !metadata.height) throw new Error("validator_decode_failed");
  const scale = Math.min(1, maxEdge / Math.max(metadata.width, metadata.height));
  const width = Math.max(1, Math.round(metadata.width * scale));
  const height = Math.max(1, Math.round(metadata.height * scale));
  const raw = await sharp(bytes, { failOn: "error" })
    .rotate()
    .resize(width, height, { fit: "fill", kernel: sharp.kernel.lanczos3 })
    .ensureAlpha()
    .raw()
    .toBuffer();
  const pixels = width * height;
  const luminance = new Float32Array(pixels);
  const histogram = new Array<number>(48).fill(0);
  let alphaEmpty = 0;
  let alphaPartial = 0;
  let red = 0;
  let green = 0;
  let blue = 0;
  let l = 0;
  let a = 0;
  let b = 0;
  let shadow = 0;
  let highlight = 0;
  const lumaBins = new Array<number>(256).fill(0);
  for (let index = 0; index < pixels; index += 1) {
    const offset = index * 4;
    const r = raw[offset]!;
    const g = raw[offset + 1]!;
    const bl = raw[offset + 2]!;
    const alpha = raw[offset + 3]!;
    if (alpha === 0) alphaEmpty += 1;
    else if (alpha < 250) alphaPartial += 1;
    red += r;
    green += g;
    blue += bl;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
    luminance[index] = y;
    const yBin = Math.max(0, Math.min(255, Math.round(y)));
    lumaBins[yBin] = (lumaBins[yBin] ?? 0) + 1;
    if (r <= 3 || g <= 3 || bl <= 3) shadow += 1;
    if (r >= 252 || g >= 252 || bl >= 252) highlight += 1;
    histogram[Math.min(15, r >> 4)]! += 1;
    histogram[16 + Math.min(15, g >> 4)]! += 1;
    histogram[32 + Math.min(15, bl >> 4)]! += 1;
    if (index % 4 === 0) {
      const lab = rgbToLab(r, g, bl);
      l += lab[0];
      a += lab[1];
      b += lab[2];
    }
  }
  const samples = Math.ceil(pixels / 4);
  const gradients = gradientSignals(luminance, width, height);
  return {
    width: metadata.width,
    height: metadata.height,
    alphaEmptyRatio: alphaEmpty / pixels,
    alphaPartialRatio: alphaPartial / pixels,
    meanLab: [l / samples, a / samples, b / samples],
    colorHistogram: histogram.map((value) => value / pixels / 3),
    temperature: ((red - blue) / pixels) / 255,
    shadowClip: shadow / pixels,
    highlightClip: highlight / pixels,
    dynamicRange: percentile(lumaBins, 0.99, pixels) - percentile(lumaBins, 0.01, pixels),
    sobel: gradients.sobel,
    laplacian: gradients.laplacian,
    highFrequency: gradients.highFrequency,
    banding: gradients.banding,
    blockiness8: gradients.blockiness8,
    blockiness16: gradients.blockiness16,
    luminance,
  };
};

const gradientSignals = (luma: Float32Array, width: number, height: number) => {
  let sobel = 0;
  let laplacian = 0;
  let highFrequency = 0;
  let smooth = 0;
  let quantizedSmooth = 0;
  let boundary8 = 0;
  let boundary8Count = 0;
  let nonBoundary8 = 0;
  let nonBoundary8Count = 0;
  let boundary16 = 0;
  let boundary16Count = 0;
  let nonBoundary16 = 0;
  let nonBoundary16Count = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const center = luma[index]!;
      const dx = Math.abs(luma[index + 1]! - luma[index - 1]!);
      const dy = Math.abs(luma[index + width]! - luma[index - width]!);
      const gradient = Math.sqrt(dx * dx + dy * dy);
      sobel += gradient;
      const lap = Math.abs(4 * center - luma[index - 1]! - luma[index + 1]! - luma[index - width]! - luma[index + width]!);
      laplacian += lap * lap;
      highFrequency += Math.abs(center - (luma[index - 1]! + luma[index + 1]! + luma[index - width]! + luma[index + width]!) / 4);
      if (gradient < 6) {
        smooth += 1;
        const nearest16 = Math.round(center / 16) * 16;
        if (Math.abs(center - nearest16) < 0.75) quantizedSmooth += 1;
      }
      const edge = Math.abs(center - luma[index - 1]!);
      if (x % 8 === 0) { boundary8 += edge; boundary8Count += 1; } else { nonBoundary8 += edge; nonBoundary8Count += 1; }
      if (x % 16 === 0) { boundary16 += edge; boundary16Count += 1; } else { nonBoundary16 += edge; nonBoundary16Count += 1; }
    }
  }
  const count = Math.max(1, (width - 2) * (height - 2));
  const normalizedBlock = (boundary: number, boundaryCount: number, rest: number, restCount: number) =>
    Math.max(0, boundary / Math.max(1, boundaryCount) / Math.max(0.01, rest / Math.max(1, restCount)) - 1);
  return {
    sobel: sobel / count,
    laplacian: laplacian / count,
    highFrequency: highFrequency / count,
    banding: quantizedSmooth / Math.max(1, smooth),
    blockiness8: normalizedBlock(boundary8, boundary8Count, nonBoundary8, nonBoundary8Count),
    blockiness16: normalizedBlock(boundary16, boundary16Count, nonBoundary16, nonBoundary16Count),
  };
};

const createCalibrationFixtures = async (source: Buffer) => {
  const resized = await sharp(source).rotate().resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true }).png().toBuffer();
  const rawResult = await sharp(resized).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = rawResult.data;
  const width = rawResult.info.width;
  const height = rawResult.info.height;
  const rawFixture = async (label: string, transform: (value: number, channel: number) => number) => {
    const output = Buffer.allocUnsafe(raw.length);
    for (let index = 0; index < raw.length; index += 1) output[index] = clampByte(transform(raw[index]!, index % 3));
    return { label, bytes: await sharp(output, { raw: { width, height, channels: 3 } }).png().toBuffer() };
  };
  return Promise.all([
    sharp(resized).blur(0.5).png().toBuffer().then((bytes) => ({ label: "blur-mild", bytes })),
    sharp(resized).blur(1.5).png().toBuffer().then((bytes) => ({ label: "blur-moderate", bytes })),
    sharp(resized).blur(3).png().toBuffer().then((bytes) => ({ label: "blur-severe", bytes })),
    sharp(resized).jpeg({ quality: 85 }).toBuffer().then((bytes) => ({ label: "jpeg-mild", bytes })),
    sharp(resized).jpeg({ quality: 60 }).toBuffer().then((bytes) => ({ label: "jpeg-moderate", bytes })),
    sharp(resized).jpeg({ quality: 35 }).toBuffer().then((bytes) => ({ label: "jpeg-severe", bytes })),
    rawFixture("quantize-mild", (value) => Math.round(value / 4) * 4),
    rawFixture("quantize-moderate", (value) => Math.round(value / 8) * 8),
    rawFixture("quantize-severe", (value) => Math.round(value / 16) * 16),
    rawFixture("clip-mild", (value) => value < 3 ? 0 : value > 252 ? 255 : value),
    rawFixture("clip-moderate", (value) => value < 13 ? 0 : value > 242 ? 255 : value),
    rawFixture("clip-severe", (value) => value < 38 ? 0 : value > 217 ? 255 : value),
    rawFixture("color-mild", (value, channel) => value + (channel === 0 ? 4 : channel === 2 ? -4 : 0)),
    rawFixture("color-moderate", (value, channel) => value + (channel === 0 ? 12 : channel === 2 ? -12 : 0)),
    rawFixture("color-severe", (value, channel) => value + (channel === 0 ? 28 : channel === 2 ? -28 : 0)),
  ]);
};

const clampByte = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
const retention = (reference: number, candidate: number) => reference < 0.0001
  ? candidate < 0.0001 ? 1 : 1 + candidate
  : candidate / reference;
const ratioLoss = (reference: number, candidate: number) => Math.max(0, 1 - retention(reference, candidate));

const percentile = (histogram: number[], quantile: number, total: number) => {
  const target = total * quantile;
  let accumulated = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    accumulated += histogram[index] ?? 0;
    if (accumulated >= target) return index;
  }
  return histogram.length - 1;
};

const histogramDistance = (left: number[], right: number[]) => left.reduce(
  (sum, value, index) => sum + Math.abs(value - (right[index] ?? 0)),
  0,
);

const rgbToLab = (r: number, g: number, b: number): [number, number, number] => {
  const linear = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  const red = linear(r);
  const green = linear(g);
  const blue = linear(b);
  const x = (red * 0.4124 + green * 0.3576 + blue * 0.1805) / 0.95047;
  const y = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  const z = (red * 0.0193 + green * 0.1192 + blue * 0.9505) / 1.08883;
  const f = (value: number) => value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};

// CIEDE2000 for averaged Lab signals. It is deterministic and used as a drift signal,
// not as a semantic or task-correctness score.
const deltaE2000 = (lab1: [number, number, number], lab2: [number, number, number]) => {
  const [l1, a1, b1] = lab1;
  const [l2, a2, b2] = lab2;
  const c1 = Math.sqrt(a1 * a1 + b1 * b1);
  const c2 = Math.sqrt(a2 * a2 + b2 * b2);
  const cBar = (c1 + c2) / 2;
  const g = 0.5 * (1 - Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.sqrt(a1Prime ** 2 + b1 ** 2);
  const c2Prime = Math.sqrt(a2Prime ** 2 + b2 ** 2);
  const h = (a: number, bValue: number) => {
    const degrees = Math.atan2(bValue, a) * 180 / Math.PI;
    return degrees >= 0 ? degrees : degrees + 360;
  };
  const h1 = h(a1Prime, b1);
  const h2 = h(a2Prime, b2);
  const deltaL = l2 - l1;
  const deltaC = c2Prime - c1Prime;
  const deltaHAngle = Math.abs(h2 - h1) <= 180 ? h2 - h1 : h2 <= h1 ? h2 - h1 + 360 : h2 - h1 - 360;
  const deltaH = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin((deltaHAngle / 2) * Math.PI / 180);
  const lBar = (l1 + l2) / 2;
  const cPrimeBar = (c1Prime + c2Prime) / 2;
  const hBar = Math.abs(h1 - h2) <= 180 ? (h1 + h2) / 2 : (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2;
  const t = 1 - 0.17 * Math.cos((hBar - 30) * Math.PI / 180)
    + 0.24 * Math.cos(2 * hBar * Math.PI / 180)
    + 0.32 * Math.cos((3 * hBar + 6) * Math.PI / 180)
    - 0.2 * Math.cos((4 * hBar - 63) * Math.PI / 180);
  const sl = 1 + 0.015 * (lBar - 50) ** 2 / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cPrimeBar;
  const sh = 1 + 0.015 * cPrimeBar * t;
  const rt = -2 * Math.sqrt(cPrimeBar ** 7 / (cPrimeBar ** 7 + 25 ** 7))
    * Math.sin(60 * Math.exp(-(((hBar - 275) / 25) ** 2)) * Math.PI / 180);
  return Math.sqrt((deltaL / sl) ** 2 + (deltaC / sc) ** 2 + (deltaH / sh) ** 2 + rt * (deltaC / sc) * (deltaH / sh));
};

const multiscaleStructuralSimilarity = (left: ImageSignals, right: ImageSignals) => {
  const count = Math.min(left.luminance.length, right.luminance.length);
  if (count === 0) return 0;
  let meanLeft = 0;
  let meanRight = 0;
  for (let index = 0; index < count; index += 1) {
    meanLeft += left.luminance[index]!;
    meanRight += right.luminance[index]!;
  }
  meanLeft /= count;
  meanRight /= count;
  let varianceLeft = 0;
  let varianceRight = 0;
  let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const l = left.luminance[index]! - meanLeft;
    const r = right.luminance[index]! - meanRight;
    varianceLeft += l * l;
    varianceRight += r * r;
    covariance += l * r;
  }
  varianceLeft /= count;
  varianceRight /= count;
  covariance /= count;
  const c1 = 6.5025;
  const c2 = 58.5225;
  return Math.max(0, Math.min(1,
    ((2 * meanLeft * meanRight + c1) * (2 * covariance + c2))
      / ((meanLeft ** 2 + meanRight ** 2 + c1) * (varianceLeft + varianceRight + c2)),
  ));
};

const edgeConsistency = (left: ImageSignals, right: ImageSignals) => {
  const max = Math.max(left.sobel, right.sobel, 0.0001);
  return Math.max(0, Math.min(1, 1 - Math.abs(left.sobel - right.sobel) / max));
};

const stableRegionConfidence = (left: ImageSignals, right: ImageSignals) => {
  const count = Math.min(left.luminance.length, right.luminance.length);
  if (count === 0) return 0;
  let stable = 0;
  for (let index = 0; index < count; index += 4) {
    if (Math.abs(left.luminance[index]! - right.luminance[index]!) < 4) stable += 1;
  }
  return stable / Math.max(1, Math.ceil(count / 4));
};
