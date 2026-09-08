import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { ArtifactStore, FileStateStore } from "@avo/core";
import { loadConfig } from "../src/config.ts";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const config = loadConfig();
const store = new FileStateStore(config.AVO_DATA_DIR);
const artifacts = new ArtifactStore(config.AVO_DATA_DIR);
const apply = process.argv.includes("--apply");
const [tasks, runs, artifactIds] = await Promise.all([store.listTasks(), store.listRuns(), artifacts.listIds()]);
const referenced = new Set([
  ...tasks.flatMap((task) => [task.source_artifact_id, ...task.references.map((reference) => reference.artifact_id)]),
  ...runs.flatMap((run) => [
    ...run.drafts.flatMap((draft) => [draft.raw_artifact_id, draft.artifact_id, draft.parent_artifact_id]),
    ...run.attempts.map((attempt) => attempt.generated_artifact_id),
  ]),
]);
const orphanIds = artifactIds.filter((id) => !referenced.has(id));
const batchId = new Date().toISOString().replaceAll(/[^0-9A-Za-z.-]/g, "-");
if (apply) {
  for (const id of orphanIds) await artifacts.quarantine(id, batchId);
}
process.stdout.write(`${JSON.stringify({
  apply,
  artifact_count: artifactIds.length,
  referenced_count: referenced.size,
  orphan_count: orphanIds.length,
  orphan_ids: orphanIds,
  ...(apply ? { quarantine_batch: batchId } : {}),
}, null, 2)}\n`);
