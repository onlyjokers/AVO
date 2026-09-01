import assert from "node:assert/strict";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { taskManifestSchema } from "@avo/contracts";
import {
  ArtifactStore,
  AvoRunner,
  FakeAgentProvider,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
} from "../src/index.ts";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+3gQ3WQAAAABJRU5ErkJggg==", "base64");

const fixture = async (passAfter = 3) => {
  const directory = await mkdtemp(join(tmpdir(), "avo-core-"));
  const store = new FileStateStore(directory);
  const artifacts = new ArtifactStore(directory);
  const source = await artifacts.put({ bytes: pixel, mimeType: "image/png", originalName: "source.png" });
  const reference = await artifacts.put({ bytes: Buffer.concat([pixel, Buffer.from("ref")]), mimeType: "image/png", originalName: "reference.png" });
  const task = taskManifestSchema.parse({
    schema_version: 1,
    id: "task-test",
    title: "测试任务",
    request: "保留主体，只改变背景颜色。",
    source_artifact_id: source.id,
    references: [{ artifact_id: reference.id, caption: "目标背景" }],
    created_at: new Date().toISOString(),
  });
  await store.saveTask(task);
  const runner = new AvoRunner(store, artifacts, new FakeAgentProvider(), new FakeImageProvider(), new FakeVerifierProvider(passAfter));
  return { directory, store, artifacts, runner, task, source };
};

test("artifact store deduplicates by SHA-256", async () => {
  const context = await fixture();
  try {
    const duplicate = await context.artifacts.put({ bytes: pixel, mimeType: "image/png", originalName: "duplicate.png" });
    assert.equal(duplicate.id, context.source.id);
    assert.equal(await context.artifacts.size(duplicate.id), pixel.byteLength);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("artifact store rejects declared MIME that does not match bytes", async () => {
  const context = await fixture();
  try {
    await assert.rejects(
      context.artifacts.put({ bytes: pixel, mimeType: "image/jpeg", originalName: "forged.jpg" }),
      /artifact_mime_mismatch/,
    );
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("AVO keeps failed attempts out of lineage and stops on verifier PASS", async () => {
  const context = await fixture(3);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 5 });
    const completed = await context.runner.start(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.terminal_reason, "verifier_passed");
    assert.equal(completed.generation_count, 3);
    assert.equal(completed.verifier_count, 3);
    assert.deepEqual(completed.attempts.map((attempt) => attempt.status), ["failed", "failed", "passed"]);
    assert.deepEqual(completed.lineage_attempt_ids, [completed.attempts[2]?.id]);
    assert.equal(completed.best_failed_attempt_id, completed.attempts[1]?.id);
    assert.equal(completed.attempts[2]?.generation_input.base_artifact_id, completed.attempts[1]?.generated_artifact_id);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("generation budget is a hard stop", async () => {
  const context = await fixture(99);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await context.runner.start(run.id);
    assert.equal(completed.status, "budget_exhausted");
    assert.equal(completed.generation_count, 2);
    assert.equal(completed.attempts.length, 2);
    assert.equal(completed.lineage_attempt_ids.length, 0);
    assert.equal(completed.selected_input?.base_artifact_id, completed.attempts[1]?.generated_artifact_id);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("one-shot makes one generation and records a non-passing result", async () => {
  const context = await fixture(99);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "one_shot", max_generations: 1 });
    const completed = await context.runner.start(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.terminal_reason, "one_shot_finished");
    assert.equal(completed.generation_count, 1);
    assert.equal(completed.lineage_attempt_ids.length, 0);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("snapshot can be rebuilt from the event log", async () => {
  const context = await fixture(1);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await context.runner.start(run.id);
    await unlink(join(context.directory, "runs", run.id, "snapshot.json"));
    const rebuilt = await context.store.getRun(run.id);
    assert.deepEqual(rebuilt, completed);
    const events = await context.store.listRunEvents(run.id);
    assert.deepEqual(events.map((event) => event.sequence), Array.from({ length: events.length }, (_, index) => index + 1));
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("unsafe identifiers cannot escape the data directory", async () => {
  const context = await fixture();
  try {
    await assert.rejects(context.store.getTask("../outside"), /invalid_id/);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("unrecoverable verifier output leaves a verification_error attempt", async () => {
  const context = await fixture();
  try {
    class BrokenVerifier extends FakeVerifierProvider {
      override async verify(): Promise<never> { throw new Error("verifier_invalid_json_after_repair"); }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new FakeAgentProvider(), new FakeImageProvider(), new BrokenVerifier());
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await runner.start(run.id);
    assert.equal(completed.status, "failed");
    assert.equal(completed.terminal_reason, "verifier_invalid_json_after_repair");
    assert.equal(completed.attempts[0]?.status, "verification_error");
    assert.equal(completed.lineage_attempt_ids.length, 0);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("agent cannot submit the source image as a generated candidate", async () => {
  const context = await fixture();
  try {
    class MaliciousAgent extends FakeAgentProvider {
      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        tools.submitCandidate(agentContext.task.source_artifact_id, {
          observation: "No generation was made.",
          hypothesis: "Submitting source should be rejected.",
          intervention: "Attempted invalid submit.",
        });
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new MaliciousAgent(), new FakeImageProvider(), new FakeVerifierProvider(1));
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await runner.start(run.id);
    assert.equal(completed.status, "failed");
    assert.equal(completed.terminal_reason, "candidate_must_be_generated_this_round");
    assert.equal(completed.generation_count, 0);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("ambiguous image generation is counted once and never retried automatically", async () => {
  const context = await fixture();
  try {
    let calls = 0;
    class AmbiguousImageProvider extends FakeImageProvider {
      override async generate(): Promise<never> {
        calls += 1;
        throw new Error("image_provider_ambiguous:socket_closed");
      }
    }
    const runner = new AvoRunner(
      context.store,
      context.artifacts,
      new FakeAgentProvider(),
      new AmbiguousImageProvider(),
      new FakeVerifierProvider(),
    );
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await runner.start(run.id);
    assert.equal(calls, 1);
    assert.equal(completed.status, "failed");
    assert.equal(completed.generation_count, 1);
    assert.equal(completed.attempts.length, 0);
    assert.equal((await context.store.listRunEvents(run.id)).filter((event) => event.type === "generation.ambiguous").length, 1);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("deterministic provider failures still consume the per-round request allowance", async () => {
  const context = await fixture();
  try {
    let calls = 0;
    class FailingImageProvider extends FakeImageProvider {
      override async generate(): Promise<never> {
        calls += 1;
        throw new Error("image_provider_task_error:deterministic");
      }
    }
    class RetryingAgent extends FakeAgentProvider {
      override async runRound(_context: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        await assert.rejects(tools.generateImage(), /image_provider_task_error/);
        await assert.rejects(tools.generateImage(), /image_provider_task_error/);
        await assert.rejects(tools.generateImage(), /round_generation_budget_exhausted/);
      }
    }
    const runner = new AvoRunner(
      context.store,
      context.artifacts,
      new RetryingAgent(),
      new FailingImageProvider(),
      new FakeVerifierProvider(),
    );
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 5, max_generations_per_round: 2 });
    const completed = await runner.start(run.id);
    assert.equal(calls, 2);
    assert.equal(completed.status, "failed");
    assert.equal(completed.terminal_reason, "agent_did_not_submit_candidate");
    assert.equal(completed.generation_count, 0);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("agent state reflects successful generation within the current round", async () => {
  const context = await fixture();
  try {
    class StateReadingAgent extends FakeAgentProvider {
      override async runRound(_context: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        assert.equal(tools.getRunSnapshot().generation_count, 0);
        const artifactId = await tools.generateImage();
        assert.equal(tools.getRunSnapshot().generation_count, 1);
        tools.submitCandidate(artifactId, {
          observation: "Generated one draft.",
          hypothesis: "Current state should be fresh.",
          intervention: "Read state after generation.",
        });
      }
    }
    const runner = new AvoRunner(
      context.store,
      context.artifacts,
      new StateReadingAgent(),
      new FakeImageProvider(),
      new FakeVerifierProvider(1),
    );
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await runner.start(run.id);
    assert.equal(completed.status, "completed");
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});

test("supervisor redirect is injected once after each third consecutive failure", async () => {
  const context = await fixture(99);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 4 });
    const completed = await context.runner.start(run.id);
    const events = await context.store.listRunEvents(run.id);
    assert.equal(completed.attempts.length, 4);
    assert.equal(events.filter((event) => event.type === "supervisor.completed").length, 1);
    assert.equal(completed.pending_supervisor_redirect, undefined);
  } finally {
    await rm(context.directory, { recursive: true, force: true });
  }
});
