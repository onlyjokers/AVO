import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config as dotenv } from "dotenv";
import { ArtifactStore, FileStateStore, SealedEvaluationStore } from "@avo/core";
import type { ExperimentalFeatures, RunSnapshot } from "@avo/contracts";
import { loadConfig } from "../src/config.ts";
import { SVG_ENGINE_REVISION } from "../src/svg-editor.ts";
import sharp from "sharp";
import { ablationFeatures } from "../src/ablation-presets.ts";
import { PHOTO_ENGINE_REVISION } from "../src/photo-editor.ts";

dotenv({ path: fileURLToPath(new URL("../../../.env.local", import.meta.url)), quiet: true });
dotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
const { values } = parseArgs({ options: {
  execute: { type: "boolean", default: false },
  "suite-id": { type: "string" },
  "task-id": { type: "string", default: "task-53069f06-411e-420a-98ba-cabba26726b9" },
  "base-url": { type: "string", default: "http://127.0.0.1:4310" },
  "max-generations": { type: "string", default: "24" },
  "max-wall-time-ms": { type: "string", default: "5400000" },
  concurrency: { type: "string", default: "3" },
  "implementation-revision": { type: "string", default: "HEAD" },
  treatment: { type: "string", default: "photo" },
} });
const config = loadConfig();
const store = new FileStateStore(config.AVO_DATA_DIR);
const artifacts = new ArtifactStore(config.AVO_DATA_DIR);
const sealedStore = new SealedEvaluationStore(config.AVO_DATA_DIR);
const task = await store.getTask(values["task-id"]!);
const sealed = await sealedStore.getForTask(task.id);
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const gitRevision = (ref: string) => execFileSync("git", ["rev-parse", "--verify", ref], { cwd: config.AVO_ROOT, encoding: "utf8" }).trim();
const suiteId = values["suite-id"] ?? `ablation-${new Date().toISOString().replace(/[:.]/g, "-")}`;
if (!/^[a-zA-Z0-9_-]+$/.test(suiteId)) throw new Error("invalid_suite_id");
const directory = join(config.AVO_DATA_DIR, "ablations", suiteId);
const maxGenerations = Number(values["max-generations"]);
const maxWallTime = Number(values["max-wall-time-ms"]);
const concurrency = Number(values.concurrency);
if (!Number.isInteger(maxGenerations) || maxGenerations < 1 || maxGenerations > 24
  || !Number.isInteger(maxWallTime) || maxWallTime < 60_000 || maxWallTime > 5_400_000
  || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5) throw new Error("invalid_experiment_budget");

if (values.treatment !== "photo" && values.treatment !== "legacy-svg") throw new Error("invalid_treatment");
const features = ablationFeatures(values.treatment);
const provider = values.treatment === "photo" ? "qwen" : "78code";
const model = values.treatment === "photo" ? "qwen3.8-max" : "gpt-6-astra";
const sourceFiles = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "--", "apps/api/src", "apps/api/scripts/run-ablation.ts", "packages", "pnpm-lock.yaml"],
  { cwd: config.AVO_ROOT, encoding: "utf8" }).trim().split("\n").filter(Boolean);
const implementationSourcesHash = hash(JSON.stringify(await Promise.all([...new Set(sourceFiles)].sort().map(async (path) =>
  [path, hash(await readFile(join(config.AVO_ROOT, path)))]))));
const controls = {
  task_id: task.id, task_title: task.title, task_sha256: hash(JSON.stringify(task)),
  source_artifact_id: task.source_artifact_id,
  public_reference_ids: task.references.map((item) => item.artifact_id),
  sealed_revision: sealed?.revision ?? null,
  sealed_asset_hashes: await Promise.all([
    ...(sealed?.references.map((item) => item.path) ?? []), ...(sealed?.hiddenTargetPath ? [sealed.hiddenTargetPath] : []),
  ].map(async (path) => hash(await readFile(path)))),
  treatment: values.treatment, implementation_sources_sha256: implementationSourcesHash,
  qwen_billing_mode: config.QWEN_BILLING_MODE,
  qwen_endpoint_host: config.QWEN_BASE_URL ? new URL(config.QWEN_BASE_URL).host : null,
  role_profiles: { main: provider, verifier: provider, supervisor: provider },
  main_model: model, verifier_model: model, supervisor_model: model,
  generator_model: config.AVO_IMAGE_MODEL,
  efforts: { main: config.AVO_CODEX_EFFORT, verifier: config.AVO_VERIFIER_EFFORT, supervisor: config.AVO_SUPERVISOR_EFFORT },
  max_generations: maxGenerations, max_wall_time_ms: maxWallTime, max_variation_steps: 40,
  max_agent_tokens: config.AVO_AGENT_TOKEN_LIMIT ?? null,
  step_soft_ms: config.AVO_AGENT_STEP_SOFT_TIMEOUT_MS, step_hard_ms: config.AVO_AGENT_STEP_TIMEOUT_MS,
  verifier_request_timeout_ms: config.AVO_VERIFIER_REQUEST_TIMEOUT_MS,
  image_attempt_timeout_ms: config.AVO_IMAGE_ATTEMPT_TIMEOUT_MS, image_max_attempts: config.AVO_IMAGE_MAX_ATTEMPTS,
  preview_max_edge: config.AVO_AGENT_PREVIEW_MAX_EDGE,
  evaluator_revision: "visual-quality-v2", mode: "avo", svg_engine: SVG_ENGINE_REVISION, photo_engine: PHOTO_ENGINE_REVISION,
  accounting: "Every finalized image-provider, photo or SVG candidate consumes one shared slot. Previews do not. New arm 0 uses the SAME model/evaluator as treatments; the archived baseline and old runs are not modified.",
  concurrency, repetitions: 1,
};
const controlsHash = hash(JSON.stringify(controls));
const baselineRevision = gitRevision("codex/ablation-baseline-20260907");
let implementationRevision = values["implementation-revision"]!;
try { implementationRevision = gitRevision(implementationRevision); }
catch (error) { if (values.execute) throw error; }
type Arm = { arm: number; features: ExperimentalFeatures; run_id?: string; status: string; error?: string };
type Manifest = { id: string; created_at: string; baseline_revision: string; implementation_revision: string; controls: typeof controls; controls_hash: string; arms: Arm[] };
let manifest: Manifest = {
  id: suiteId, created_at: new Date().toISOString(), baseline_revision: baselineRevision,
  implementation_revision: implementationRevision, controls, controls_hash: controlsHash,
  arms: features.map((feature, arm) => ({ arm, features: feature, status: "planned" })),
};
try {
  const existing = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Manifest;
  if (existing.controls_hash !== controlsHash || existing.implementation_revision !== implementationRevision) throw new Error("ablation_controls_changed");
  manifest = existing;
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
await mkdir(directory, { recursive: true });
let saveQueue = Promise.resolve();
const save = async () => {
  const content = JSON.stringify(manifest, null, 2);
  saveQueue = saveQueue.then(async () => {
    const temporary = join(directory, "manifest.tmp");
    await writeFile(temporary, content);
    await rename(temporary, join(directory, "manifest.json"));
  });
  await saveQueue;
};
await save();
await writeFile(join(directory, "task.json"), JSON.stringify(task, null, 2));
console.log(JSON.stringify({ suite_id: suiteId, directory, controls, execute: values.execute }));
if (!values.execute) process.exit(0);

const api = async (path: string, body?: unknown) => {
  const response = await fetch(`${values["base-url"]}${path}`, body === undefined ? {} : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(`ablation_http_${response.status}:${JSON.stringify(payload).slice(0, 2000)}`);
  return payload;
};
const health = await api("/api/model-profiles");
const profile = (health.options as Array<{ id: string; model: string; configured: boolean }>).find((item) => item.id === provider);
if (!profile?.configured || profile.model !== model) throw new Error(`ablation_requires_configured_${provider}_${model}`);
if (config.AVO_PROVIDER_MODE !== "live") throw new Error("ablation_live_mode_required");
const terminal = new Set(["completed", "failed", "stopped", "budget_exhausted", "interrupted", "finalization_pending"]);
let nextArm = 0;
const worker = async () => {
  while (nextArm < manifest.arms.length) {
    const arm = manifest.arms[nextArm++]!;
    try {
      if (!arm.run_id) {
        const existing = (await store.listRuns()).filter((run) => run.config.experiment?.suite_id === suiteId && run.config.experiment.arm === arm.arm);
        if (existing.length > 1) throw new Error("duplicate_ablation_arm");
        if (existing[0]) arm.run_id = existing[0].id;
        else {
          // Do not blindly retry this POST on transport uncertainty; recover its run by suite/arm instead.
          const payload = await api("/api/runs", { task_id: task.id, config: {
            mode: "avo", role_profiles: controls.role_profiles,
            main_model: controls.main_model, verifier_model: controls.verifier_model, supervisor_model: controls.supervisor_model,
            generator_model: controls.generator_model, max_generations: maxGenerations,
            max_generations_per_round: maxGenerations, max_wall_time_ms: maxWallTime, max_variation_steps: 40,
            supervisor_enabled: true, stop_on_pass: false, evaluator_revision: controls.evaluator_revision,
            experimental_features: arm.features,
            experiment: { suite_id: suiteId, arm: arm.arm, baseline_revision: baselineRevision, implementation_revision: implementationRevision, controls_hash: controlsHash },
          } });
          arm.run_id = (payload.run as RunSnapshot).id;
        }
        arm.status = "running";
        await save();
        console.log(JSON.stringify({ arm: arm.arm, run_id: arm.run_id, status: arm.status }));
      }
      let last = "";
      for (;;) {
        const run = await store.getRun(arm.run_id);
        if (run.config.main_model !== controls.main_model || run.config.verifier_model !== controls.verifier_model
          || run.config.supervisor_model !== controls.supervisor_model || run.config.generator_model !== controls.generator_model
          || run.config.max_generations !== maxGenerations || run.config.experiment?.controls_hash !== controlsHash) throw new Error("ablation_run_controls_mismatch");
        arm.status = run.status;
        const progress = `${run.status}:${run.generation_count}:${run.active_variation_attempt}`;
        if (progress !== last) {
          console.log(JSON.stringify({ arm: arm.arm, run_id: run.id, status: run.status, candidates: run.generation_count, attempts: run.active_variation_attempt, tokens: run.agent_total_tokens, reason: run.terminal_reason }));
          last = progress;
          await save();
        }
        if (terminal.has(run.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
    } catch (error) {
      arm.status = "experiment_error";
      arm.error = (error as Error).message;
      console.error(JSON.stringify({ arm: arm.arm, error: arm.error }));
      await save();
    }
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));
const rows = [];
for (const arm of manifest.arms) {
  if (!arm.run_id) { rows.push({ ...arm }); continue; }
  const run = await store.getRun(arm.run_id);
  const final = run.final_verifier_decisions.find((decision) => decision.id === run.final_verifier_decision_id);
  const node = final ? run.lineage_nodes.find((item) => item.id === final.selected_node_id) : undefined;
  const events = await store.listRunEvents(run.id);
  const toolNames = events.filter((event) => event.type === "agent.tool_completed").map((event) => String(event.data.tool ?? ""));
  const row = {
    arm: arm.arm, features: arm.features, run_id: run.id, status: run.status, terminal_reason: run.terminal_reason,
    candidate_count: run.generation_count, image_provider_candidates: run.drafts.filter((draft) => !draft.creation_method || draft.creation_method === "image_provider").length,
    photo_candidates: run.drafts.filter((draft) => draft.creation_method === "photo_adjustment").length,
    svg_candidates: run.drafts.filter((draft) => draft.creation_method === "svg_edit").length,
    committed_versions: run.lineage_nodes.filter((item) => item.kind === "commit").length,
    final_artifact_id: node?.artifact_id ?? null, final_version: node?.version ?? null,
    final_rationale: final?.rationale ?? null, agent_tokens: run.agent_total_tokens,
    elapsed_ms: run.started_at && run.finished_at ? Date.parse(run.finished_at) - Date.parse(run.started_at) : null,
    tools: Object.fromEntries([...new Set(toolNames)].map((name) => [name, toolNames.filter((tool) => tool === name).length])),
    supervisor_failures: run.supervisor_failures.length,
  };
  rows.push(row);
  if (node) await writeFile(join(directory, `arm-${arm.arm}-final.png`), await sharp((await artifacts.get(node.artifact_id)).bytes).png().toBuffer());
}
await writeFile(join(directory, "results.json"), JSON.stringify({ manifest, rows, caveat: "One task, one replicate per arm: exploratory ablation, not a statistically established win. Verifier confidence is not image quality." }, null, 2));
await writeFile(join(directory, "source.png"), await sharp((await artifacts.get(task.source_artifact_id)).bytes).png().toBuffer());
console.log(JSON.stringify({ finished: true, suite_id: suiteId, results: resolve(directory, "results.json"), rows }));
