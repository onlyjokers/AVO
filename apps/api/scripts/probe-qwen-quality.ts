import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config as dotenv } from "dotenv";
import { ArtifactStore, FileStateStore, SealedEvaluationStore } from "@avo/core";
import { loadConfig } from "../src/config.ts";
import { QwenResponsesVerifier } from "../src/http-providers.ts";

dotenv({ path: fileURLToPath(new URL("../../../.env.local", import.meta.url)), quiet: true });
dotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
const { values } = parseArgs({ options: {
  execute: { type: "boolean", default: false },
  "run-id": { type: "string", default: "run-416899ce-2822-43e2-a05f-ecd789d9fe1d" },
} });
const config = loadConfig();
if (!values.execute) {
  console.log(JSON.stringify({ model: "qwen3.8-max", run_id: values["run-id"], action: "Read-only re-review of the last accepted candidate with its original frame and images. Writes only a new isolated probe directory. Use --execute for paid model requests." }));
} else {
  const store = new FileStateStore(config.AVO_DATA_DIR);
  const artifacts = new ArtifactStore(config.AVO_DATA_DIR);
  const run = await store.getRun(values["run-id"]!);
  const task = await store.getTask(run.task_id);
  const original = run.comparative_decisions.findLast((decision) => decision.recommendation === "commit");
  if (!original) throw new Error("probe_needs_accepted_comparison");
  const draft = run.drafts.find((item) => item.id === original.draft_id)!;
  const frame = run.evaluation_frame_revisions.find((item) => item.id === original.evaluation_frame_revision_id)!;
  const incumbent = run.lineage_nodes.find((item) => item.id === original.incumbent_node_id)!;
  const sealed = await new SealedEvaluationStore(config.AVO_DATA_DIR).getForTask(task.id);
  const directory = join(config.AVO_ROOT, "tmp", `qwen-quality-probe-${Date.now()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const verifier = new QwenResponsesVerifier({ ...config, AVO_MAIN_PROVIDER: "qwen", QWEN_MODEL: "qwen3.8-max", AVO_DATA_DIR: directory });
  const originalFetch = globalThis.fetch;
  const deadline = AbortSignal.timeout(360_000);
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    const request = ++requests;
    const started = Date.now();
    console.log(JSON.stringify({ phase: "request_started", request, model: "qwen3.8-max" }));
    const response = await originalFetch(url, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline });
    console.log(JSON.stringify({ phase: "headers_received", request, status: response.status, elapsed_ms: Date.now() - started }));
    return response;
  };
  const decision = await verifier.compare({
    runId: `probe-${Date.now()}`, draftId: draft.id, candidateArtifactId: draft.artifact_id, task, frame,
    sourcePath: (await artifacts.get(task.source_artifact_id)).path,
    parentPath: (await artifacts.get(draft.parent_artifact_id)).path,
    candidatePath: (await artifacts.get(draft.artifact_id)).path,
    incumbentNode: incumbent, incumbentPath: (await artifacts.get(incumbent.artifact_id)).path,
    publicReferences: await Promise.all(task.references.map(async (item) => ({ path: (await artifacts.get(item.artifact_id)).path, ...(item.caption ? { caption: item.caption } : {}) }))),
    sealedReferences: sealed?.references ?? [],
    ...(sealed?.hiddenTargetPath ? { hiddenTargetPath: sealed.hiddenTargetPath } : {}),
    ...(sealed?.privateRubric ? { privateInstructions: sealed.privateRubric } : {}),
    history: [], technicalGate: original.technical_gate,
    callTool: async (tool) => original.evidence.find((item) => item.tool === tool) ?? {
      id: `probe-${tool}`, tool, summary: "No cached measurement for this tool in the original review; do not infer zero difference or a clean result.", data: { available: false },
    },
  });
  await writeFile(join(directory, "decision.json"), JSON.stringify({
    provenance: { original_run_id: run.id, original_decision_id: original.id, original_frame_id: frame.id,
      reused_measurements: true, new_matched_detail_sheets: true, not_a_controlled_model_comparison: true }, decision,
  }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ directory, model: decision.model, correctness: decision.correctness,
    recommendation: decision.recommendation, preference: decision.preference,
    candidate_quality: decision.candidate_quality, incumbent_quality: decision.incumbent_quality,
    latency_ms: decision.latency_ms, usage: decision.usage, feedback: decision.feedback_for_main_agent }));
}
