import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { config as dotenv } from "dotenv";
import { ArtifactStore, FileStateStore, SealedEvaluationStore } from "@avo/core";
import type { LineageNode } from "@avo/contracts";
import { loadConfig, roleConfig } from "../src/config.ts";
import { QwenResponsesVerifier } from "../src/http-providers.ts";

dotenv({ path: fileURLToPath(new URL("../../../.env.local", import.meta.url)), quiet: true });
dotenv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
const { values } = parseArgs({ options: { "suite-id": { type: "string" }, execute: { type: "boolean", default: false } } });
if (!values["suite-id"] || !/^[a-zA-Z0-9_-]+$/.test(values["suite-id"])) throw new Error("suite_id_required");
const config = loadConfig();
const directory = join(config.AVO_DATA_DIR, "ablations", values["suite-id"]);
const invalidation = await readFile(join(directory, "invalidation.json"), "utf8").then((text) => JSON.parse(text)).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "ENOENT") return null;
  throw error;
});
const results = JSON.parse(await readFile(join(directory, "results.json"), "utf8")) as {
  manifest: { id: string; controls: { task_id: string }; controls_hash: string };
  rows: Array<{ arm: number; run_id?: string; status: string; terminal_reason?: string; candidate_count?: number; image_provider_candidates?: number; svg_candidates?: number; final_artifact_id?: string | null; final_version?: number | null; elapsed_ms?: number | null; agent_tokens?: number; final_rationale?: string | null; tools?: Record<string, number> }>;
};
const store = new FileStateStore(config.AVO_DATA_DIR), artifacts = new ArtifactStore(config.AVO_DATA_DIR);
const task = await store.getTask(results.manifest.controls.task_id);
const sealed = await new SealedEvaluationStore(config.AVO_DATA_DIR).getForTask(task.id);
const completed = results.rows.filter((row) => row.final_artifact_id);
const distinctFinalImages = new Set(completed.map((row) => row.final_artifact_id)).size;
let review: Record<string, unknown> = invalidation
  ? { status: "invalidated", ...invalidation }
  : { status: "not_requested", note: "No quality ranking inferred from confidence, accepted-version counts or token usage." };
if (!invalidation && distinctFinalImages === 1) {
  review = { status: "identical_final_images", arms_with_identical_final: completed.map((row) => row.arm), distinct_final_images: 1, is_original_source: completed[0]!.final_artifact_id === task.source_artifact_id, note: "Artifact identity establishes equality; no paid model comparison was made. Missing finals are not assigned a quality rank." };
}
if (!invalidation && values.execute && distinctFinalImages >= 2) {
  const reviewer = new QwenResponsesVerifier(roleConfig({ ...config, AVO_VERIFIER_PROVIDER: "78code", AVO_VERIFIER_MODEL: "gpt-6-astra" }, "verifier"));
  const runId = `ablation-review-${randomUUID()}`;
  const sourcePath = (await artifacts.get(task.source_artifact_id)).path;
  const sourceNode: LineageNode = {
    id: `blind-source-${randomUUID()}`, run_id: runId, artifact_id: task.source_artifact_id,
    kind: "seed", version: 0, ancestry_depth: 0, pareto_active: false, committed_at: new Date().toISOString(),
  };
  const publicReferences = await Promise.all(task.references.map(async (item) => ({ path: (await artifacts.get(item.artifact_id)).path, ...(item.caption ? { caption: item.caption } : {}) })));
  const privateInputs = {
    sealedReferences: sealed?.references ?? [],
    ...(sealed?.hiddenTargetPath ? { hiddenTargetPath: sealed.hiddenTargetPath } : {}),
    privateInstructions: [sealed?.privateRubric ?? "", "This is a blinded comparison of independent experimental final images, not successive lineage versions. Every candidate has equal prior status. Compare directly under the human brief and reference direction. Do not infer quality from list order, version, model confidence, or method. If no candidate improves Source, say so explicitly."].join("\n"),
  };
  const frame = await reviewer.createEvaluationFrame({
    runId, attempt: 1, task, sourcePath, publicReferences, ...privateInputs,
    lineage: [sourceNode], archive: [], recentAttempts: [],
  });
  const mapping = [...new Set(completed.map((row) => row.final_artifact_id!))].map((artifactId) => ({
    arms: completed.filter((row) => row.final_artifact_id === artifactId).map((row) => row.arm),
    id: `blind-${randomUUID()}`, artifact_id: artifactId,
  })).sort((a, b) => a.id.localeCompare(b.id));
  const candidates = await Promise.all(mapping.map(async (item) => ({
    node: { ...sourceNode, id: item.id, artifact_id: item.artifact_id, kind: "commit" as const },
    path: (await artifacts.get(item.artifact_id)).path,
  })));
  const forward = await reviewer.selectFinal({ runId, task, frame, sourcePath, candidates, publicReferences, ...privateInputs });
  const reverse = await reviewer.selectFinal({ runId: `${runId}-reverse`, task, frame, sourcePath, candidates: [...candidates].reverse(), publicReferences, ...privateInputs });
  const forwardChoice = mapping.find((item) => item.id === forward.selected_node_id)!;
  const reverseChoice = mapping.find((item) => item.id === reverse.selected_node_id)!;
  const agrees = forwardChoice.artifact_id === reverseChoice.artifact_id;
  review = {
    status: agrees ? "order_consistent" : "order_disagreement",
    preferred_arms: agrees ? forwardChoice.arms : [],
    forward_arms: forwardChoice.arms, reverse_arms: reverseChoice.arms,
    distinct_final_images: mapping.length,
    forward_rationale: forward.rationale, reverse_rationale: reverse.rationale,
    model: "78code:gpt-6-astra", scope: "Final images only; names, treatments, histories and per-run judgments withheld from the reviewer.",
    caveat: "Single task and replicate, same-family automated reviewer, no human preference calibration. Agreement is not proof of a general experimental benefit.",
  };
  // Private audit includes the frozen review frame; it is never sent to a Main Agent.
  await writeFile(join(directory, "blind-review-private.json"), JSON.stringify({ frame, mapping, forward, reverse }, null, 2), { mode: 0o600 });
}
await writeFile(join(directory, "blind-review.json"), JSON.stringify(review, null, 2));
const labels = ["Baseline", "SVG", "SVG + iterative", "SVG + copilot", "SVG + iterative + copilot"];
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
const rows = results.rows.map((row) => `<tr><td>${row.arm} ${labels[row.arm]}</td><td>${escape(row.status)}</td><td>${row.candidate_count ?? "-"}</td><td>${row.image_provider_candidates ?? "-"}</td><td>${row.svg_candidates ?? "-"}</td><td>${row.elapsed_ms ? (row.elapsed_ms / 60_000).toFixed(1) : "-"}</td><td>${row.agent_tokens?.toLocaleString() ?? "-"}</td><td>${escape(row.terminal_reason)}</td></tr>`).join("");
const images = results.rows.map((row) => `<section><h2>${row.arm} ${labels[row.arm]}</h2>${row.final_artifact_id ? `<img src="arm-${row.arm}-final.png" alt="Arm ${row.arm} final image">` : "<p>No final image was selected. This arm must not be treated as a quality win.</p>"}<p>${escape(row.final_rationale)}</p><p>${escape(JSON.stringify(row.tools))}</p>${row.run_id ? `<a href="http://127.0.0.1:4311/runs/${row.run_id}">Run history</a>` : ""}</section>`).join("");
await writeFile(join(directory, "report.html"), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AVO five-arm ablation</title><style>body{font:15px system-ui;margin:24px;background:#fafafa;color:#222;letter-spacing:0}main{max-width:1400px;margin:auto}h1{font-size:26px}h2{font-size:19px}table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}.scroll{overflow:auto}.images{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}section{min-width:0;border-top:1px solid #ccc;padding-top:12px}img{display:block;width:100%;height:auto}p,pre{overflow-wrap:anywhere;white-space:pre-wrap}a{color:#14623a}@media(max-width:750px){.images{grid-template-columns:1fr}body{margin:14px}}</style><main><h1>${escape(task.title)}: five-arm AVO ablation</h1><p>One task, one run per arm. All Main / Verifier / Supervisor calls use 78code gpt-6-astra. Image model unchanged. Confidence is not a quality score.</p><p>Controls hash: ${escape(results.manifest.controls_hash)}</p><div class="scroll"><table><thead><tr><th>Arm</th><th>Status</th><th>Candidates</th><th>Image calls*</th><th>SVG candidates</th><th>Minutes</th><th>Main tokens</th><th>Reason</th></tr></thead><tbody>${rows}</tbody></table></div><p>*Successful provider candidates, excluding transport retries and ambiguous outcomes.</p><h2>Blinded final comparison</h2><pre>${escape(JSON.stringify(review, null, 2))}</pre><h2>Source</h2><img src="source.png" alt="Original source"><div class="images">${images}</div></main></html>`);
console.log(JSON.stringify({ report: join(directory, "report.html"), review }));
