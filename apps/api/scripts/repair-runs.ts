import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import {
  ArtifactStore,
  AvoRunner,
  FakeAgentProvider,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
} from "@avo/core";
import { loadConfig } from "../src/config.ts";

loadEnv({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const resumeVerification = args.has("--resume-verification");
const runArgument = process.argv.findIndex((value) => value === "--run");
const requestedRunId = runArgument >= 0 ? process.argv[runArgument + 1] : undefined;
if (!requestedRunId && !args.has("--all")) throw new Error("repair_scope_required");
if (resumeVerification) throw new Error("legacy_run_read_only_clone_required");

const config = loadConfig();
const store = new FileStateStore(config.AVO_DATA_DIR);
const artifacts = new ArtifactStore(config.AVO_DATA_DIR);
const runner = new AvoRunner(store, artifacts, new FakeAgentProvider(), new FakeImageProvider(), new FakeVerifierProvider());
const runIds = requestedRunId ? [requestedRunId] : (await store.listRuns()).map((run) => run.id);
const report = [];
for (const runId of runIds) {
  const plan = await runner.planLegacyRecovery(runId);
  if (!apply || plan.generation_count === 0) {
    report.push({ run_id: runId, action: "planned", ...plan });
    continue;
  }
  const repaired = await runner.repairLegacyRun(runId);
  const run = repaired.run;
  report.push({
    run_id: runId,
    action: "legacy_read_only",
    status: run.status,
    drafts: run.drafts.length,
    attempts: run.attempts.length,
    terminal_reason: run.terminal_reason,
    ...plan,
  });
}

process.stdout.write(`${JSON.stringify({ apply, resume_verification: resumeVerification, items: report }, null, 2)}\n`);
