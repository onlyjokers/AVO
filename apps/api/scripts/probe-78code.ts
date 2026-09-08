import { config as loadEnv } from "dotenv";
import { join } from "node:path";
import { ArtifactStore, FileStateStore, SealedEvaluationStore } from "@avo/core";
import { loadConfig, roleConfig } from "../src/config.ts";
import { prepareCodexRuntime } from "../src/codex-runtime.ts";
import { CodexAppServerAgentProvider } from "../src/codex-provider.ts";
import { AgentToolBroker } from "../src/tool-broker.ts";
import { QwenResponsesVerifier } from "../src/http-providers.ts";

loadEnv({ path: "../../.env.local", quiet: true });
loadEnv({ path: "../../.env", quiet: true });
const base = loadConfig();
const config = roleConfig({ ...base, AVO_MAIN_PROVIDER: "78code", AVO_VERIFIER_PROVIDER: "78code", AVO_SUPERVISOR_PROVIDER: "78code" }, "main");
const runtime = await prepareCodexRuntime(config);
console.log(JSON.stringify({ harness: runtime.codexRevision, model: config.AVO_CODEX_MODEL }));
const agent = new CodexAppServerAgentProvider({ ...runtime.config, AVO_DATA_DIR: join(base.AVO_ROOT, "tmp", "78code-probe") }, new AgentToolBroker(), undefined, "probe-local-token");
console.log(JSON.stringify({ main_agent: await agent.probe() }));

const runId = process.argv[2];
if (!runId) throw new Error("Supply an existing Run ID for read-only visual reassessment");
const run = await new FileStateStore(base.AVO_DATA_DIR).getRun(runId);
const task = await new FileStateStore(base.AVO_DATA_DIR).getTask(run.task_id);
const artifacts = new ArtifactStore(base.AVO_DATA_DIR);
const sealed = await new SealedEvaluationStore(base.AVO_DATA_DIR).getForTask(task.id);
const node = run.lineage_nodes.at(-1)!;
const frame = run.evaluation_frame_revisions.at(-1)!;
const verifier = new QwenResponsesVerifier({ ...roleConfig(config, "verifier"), AVO_DATA_DIR: join(base.AVO_ROOT, "tmp", "78code-probe") });
if (!process.argv.includes("--supervisor-only")) {
const review = await verifier.reviewLineage({
  runId: `probe-${runId}`, task, frame, node,
  sourcePath: (await artifacts.get(task.source_artifact_id)).path,
  nodePath: (await artifacts.get(node.artifact_id)).path,
  earlierImages: await Promise.all(run.lineage_nodes.slice(0, 3).map(async (node) => ({ node, path: (await artifacts.get(node.artifact_id)).path }))),
  references: sealed?.references ?? [],
  ...(sealed?.hiddenTargetPath ? { hiddenTargetPath: sealed.hiddenTargetPath } : {}),
  ...(sealed?.privateRubric ? { privateInstructions: sealed.privateRubric } : {}),
});
console.log(JSON.stringify({ historical_node: node.id, review }));
}
if (process.argv.includes("--supervisor") || process.argv.includes("--supervisor-only")) {
  const imagePool = await Promise.all([...new Set([task.source_artifact_id, ...run.lineage_nodes.map((node) => node.artifact_id), ...run.drafts.slice(-2).map((draft) => draft.artifact_id)])]
    .map(async (artifactId) => ({ artifactId, path: (await artifacts.get(artifactId)).path, kind: "candidate" as const })));
  const advice = await agent.supervise({ task, checklist: task.checklist!, run, imagePool, recentAttempts: run.attempts.slice(-3) }, { triggers: ["three_attempts_without_new_version"], scope: "step_boundary" });
  console.log(JSON.stringify({ supervisor: advice }));
}
