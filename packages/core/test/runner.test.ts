import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runSnapshotSchema, taskManifestSchema } from "@avo/contracts";
import sharp from "sharp";
import type { VerifierProvider } from "../src/providers.ts";
import {
  ArtifactStore,
  AvoRunner,
  detectInStepTrajectoryTriggers,
  detectStepBoundaryTriggers,
  FakeAgentProvider,
  FakeImageProvider,
  FakeVerifierProvider,
  FileStateStore,
} from "../src/index.ts";

const sourcePng = async () => sharp({
  create: { width: 96, height: 64, channels: 3, background: { r: 90, g: 130, b: 180 } },
}).composite([{ input: Buffer.from('<svg width="96" height="64"><circle cx="46" cy="30" r="17" fill="#f1c751"/></svg>') }]).png().toBuffer();

const fixture = async (passAfter = 1) => {
  const directory = await mkdtemp(join(tmpdir(), "avo-core-"));
  const store = new FileStateStore(directory);
  const artifacts = new ArtifactStore(directory);
  const pixels = await sourcePng();
  const source = await artifacts.put({ bytes: pixels, mimeType: "image/png", originalName: "source.png" });
  const referencePixels = await sharp(pixels).modulate({ brightness: 1.03 }).png().toBuffer();
  const reference = await artifacts.put({ bytes: referencePixels, mimeType: "image/png", originalName: "reference.png" });
  const task = taskManifestSchema.parse({
    schema_version: 2,
    id: "task-test",
    title: "测试任务",
    user_brief: "保留主体，只改变背景颜色。",
    source_artifact_id: source.id,
    references: [{ artifact_id: reference.id, caption: "目标背景" }],
    preservation_contract: { color: "allow_change", detail: "preserve", composition: "preserve" },
    has_hidden_evaluation: false,
    created_at: new Date().toISOString(),
  });
  await store.saveTask(task);
  const verifier = new FakeVerifierProvider(passAfter);
  const runner = new AvoRunner(store, artifacts, new FakeAgentProvider(), new FakeImageProvider(), verifier);
  return { directory, store, artifacts, runner, task, source, reference, verifier };
};

test("artifact store deduplicates and rejects forged MIME", async () => {
  const context = await fixture();
  try {
    const source = await context.artifacts.get(context.source.id);
    const duplicate = await context.artifacts.put({ bytes: source.bytes, mimeType: "image/png", originalName: "duplicate.png" });
    assert.equal(duplicate.id, context.source.id);
    await assert.rejects(context.artifacts.put({ bytes: source.bytes, mimeType: "image/jpeg", originalName: "forged.jpg" }), /artifact_mime_mismatch/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("a changed frame reassesses incumbent without rewriting its historical acceptance", async () => {
  const context = await fixture();
  try {
    class ReviewingVerifier extends FakeVerifierProvider {
      reviews = 0;
      override async createEvaluationFrame(input: Parameters<VerifierProvider["createEvaluationFrame"]>[0]) {
        const frame = await super.createEvaluationFrame(input);
        return { ...frame, axes: frame.axes.map((axis) => ({ ...axis, criterion: `${axis.criterion} Revision ${input.attempt}` })) };
      }
      async reviewLineage(input: Parameters<NonNullable<VerifierProvider["reviewLineage"]>>[0]) {
        this.reviews += 1;
        assert.equal(input.node.kind, "commit");
        assert.ok(input.earlierImages.length > 0);
        return { evaluation_frame_revision_id: input.frame.id, correctness: "fail" as const, feedback_for_main_agent: ["Inherited texture defect; compare with Source."], reviewed_at: new Date().toISOString() };
      }
    }
    const verifier = new ReviewingVerifier(1);
    const runner = new AvoRunner(context.store, context.artifacts, new FakeAgentProvider(), new FakeImageProvider(), verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const done = await runner.start(run.id);
    assert.equal(verifier.reviews, 1);
    const first = done.lineage_nodes.find((node) => node.version === 1)!;
    assert.equal(first.current_review?.correctness, "fail");
    assert.ok(first.accepted_evaluation_id);
    assert.notEqual(first.evaluation_frame_revision_id, first.current_review?.evaluation_frame_revision_id);
    assert.equal((await context.store.listRunEvents(run.id)).filter((event) => event.type === "lineage.reviewed").length, 1);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("Supervisor cannot invent a tested alternative parent", async () => {
  const context = await fixture();
  try {
    class UnsupportedAdvice extends FakeAgentProvider {
      override async supervise() {
        return { intervene: true, diagnosis: "All alternatives failed.", branch_strategy: "diversify" as const, quality_risks: [], avoid: [], try: ["Another branch"],
          search_assessment: { tested_parent_ids: ["node-never-tested"], untested_alternatives: [], conclusion_scope: "tested_alternatives" as const, strategy_change: "Restore history" } };
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new UnsupportedAdvice(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const result = await runner.maybeRunSupervisor(context.task, run, ["same_branch_three_times"], "in_step");
    assert.equal(result.supervisor_decisions.length, 0);
    assert.equal(result.supervisor_failures.at(-1)?.code, "invalid_structured_output");
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("new V4 run starts at x0 without a generation prompt or automatic parent", async () => {
  const context = await fixture();
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    assert.equal(run.schema_version, 4);
    assert.equal(run.generation_prompt, undefined);
    assert.equal(run.parent_selection, undefined);
    assert.equal(run.prompt, "");
    assert.equal(run.lineage_nodes[0]?.kind, "seed");
    assert.equal(run.lineage_nodes[0]?.version, 0);
    assert.equal(run.active_evolution_version, 0);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("the first Attempt uses a deterministic evaluation frame when Verifier frame generation fails", async () => {
  const context = await fixture(1);
  try {
    class InvalidInitialFrameVerifier extends FakeVerifierProvider {
      override async createEvaluationFrame(): Promise<never> {
        throw new Error("verifier_invalid_json_after_repair:evaluation_frame_invalid_axis_coverage");
      }
    }
    const runner = new AvoRunner(
      context.store,
      context.artifacts,
      new FakeAgentProvider(),
      new FakeImageProvider(),
      new InvalidInitialFrameVerifier(1),
    );
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const completed = await runner.start(run.id);
    const frame = completed.evaluation_frame_revisions[0]!;
    assert.equal(completed.status, "budget_exhausted", completed.terminal_reason);
    assert.equal(frame.provenance, "deterministic_baseline");
    assert.match(frame.fallback_reason ?? "", /evaluation_frame_invalid_axis_coverage/);
    assert.equal(frame.model, "controller-deterministic-frame-v1");
    assert.ok(frame.axes.some((axis) => axis.mode === "preserve_source"));
    const axisIds = new Set(frame.axes.map((axis) => axis.id));
    assert.ok(frame.coverage.every((item) => item.axis_ids.every((axisId) => axisIds.has(axisId))));
    const events = await context.store.listRunEvents(run.id);
    assert.equal(events.some((event) => event.type === "evaluation_frame.fallback"
      && event.data.provenance === "deterministic_baseline"), true);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("a later Attempt reuses the previous evaluation frame after Verifier repair is exhausted", async () => {
  const context = await fixture(1);
  try {
    class InvalidSecondFrameVerifier extends FakeVerifierProvider {
      private calls = 0;
      override async createEvaluationFrame(input: Parameters<FakeVerifierProvider["createEvaluationFrame"]>[0]) {
        this.calls += 1;
        if (this.calls === 2) throw new Error("verifier_invalid_json_after_repair:evaluation_frame_duplicate_axis_ids");
        return super.createEvaluationFrame(input);
      }
    }
    const runner = new AvoRunner(
      context.store,
      context.artifacts,
      new FakeAgentProvider(),
      new FakeImageProvider(),
      new InvalidSecondFrameVerifier(1),
    );
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await runner.start(run.id);
    const [first, second] = completed.evaluation_frame_revisions;
    assert.equal(completed.status, "budget_exhausted", completed.terminal_reason);
    assert.equal(first?.provenance, "verifier");
    assert.equal(second?.provenance, "reused_previous");
    assert.equal(second?.supersedes_id, first?.id);
    assert.deepEqual(second?.axes, first?.axes);
    assert.deepEqual(second?.coverage, first?.coverage);
    assert.deepEqual(second?.axis_diff, { added: [], removed: [], changed: [] });
    const events = await context.store.listRunEvents(run.id);
    assert.equal(events.some((event) => event.type === "evaluation_frame.fallback"
      && event.data.provenance === "reused_previous"
      && event.data.source_frame_id === first?.id), true);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("legacy V1/V2 runs without lineage nodes project a read-only official lineage", async () => {
  const context = await fixture();
  try {
    const createdAt = new Date().toISOString();
    const projected = runSnapshotSchema.parse({
      schema_version: 2,
      id: "run-legacy-v2",
      task_id: context.task.id,
      config: {
        mode: "avo",
        main_model: "legacy-agent",
        generator_model: "legacy-generator",
        verifier_model: "legacy-verifier",
        max_generations: 1,
        max_wall_time_ms: 60_000,
        max_generations_per_round: 1,
        stop_on_pass: true,
        evaluator_revision: "legacy-verifier-v1",
        supervisor_enabled: false,
        provider_revisions: { codex: "legacy", generator: "legacy", verifier: "legacy" },
      },
      status: "completed",
      prompt: "Legacy prompt",
      current_prompt: "Legacy prompt",
      selected_generation_input: { base_artifact_id: context.source.id, reference_artifact_ids: [] },
      active_round: 1,
      drafts: [],
      attempts: [{
        id: "attempt-legacy-pass",
        run_id: "run-legacy-v2",
        round: 1,
        prompt: "Legacy prompt",
        generation_input: { base_artifact_id: context.source.id, reference_artifact_ids: [] },
        generated_artifact_id: context.reference.id,
        agent_summary: { observation: "Legacy observation", hypothesis: "Legacy hypothesis", intervention: "Legacy intervention" },
        status: "passed",
        created_at: createdAt,
      }],
      lineage_attempt_ids: ["attempt-legacy-pass"],
      working_memory: { useful_findings: [], failed_directions: [], current_hypotheses: [], preservation_constraints: [] },
      consecutive_failures: 0,
      generation_count: 1,
      verifier_count: 1,
      created_at: createdAt,
      updated_at: createdAt,
    });
    assert.equal(projected.schema_version, 4);
    assert.equal(projected.legacy_read_only, true);
    assert.deepEqual(projected.lineage_nodes.map((node) => node.version), [0, 1]);
    assert.equal(projected.variation_attempts.length, 1);
    assert.equal(projected.variation_attempts[0]?.committed_lineage_node_id, projected.lineage_nodes[1]?.id);
    assert.equal(projected.incumbent_node_id, projected.lineage_nodes[1]?.id);
    assert.equal(projected.lineage_nodes[1]?.previous_version_node_id, projected.lineage_nodes[0]?.id);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("AVO continues after PASS and consumes the full run budget", async () => {
  const context = await fixture(1);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 3 });
    const completed = await context.runner.start(run.id);
    assert.equal(completed.status, "budget_exhausted", completed.terminal_reason);
    assert.equal(completed.generation_count, 3);
    assert.equal(completed.verifier_count, 3);
    assert.equal(completed.evaluations.length, 3);
    assert.equal(completed.attempts.length, 3);
    assert.ok(completed.lineage_nodes.some((node) => node.kind === "commit"));
    assert.ok(completed.drafts.every((draft) => draft.parent_artifact_id === context.task.source_artifact_id));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("one autonomous variation step can inspect, evaluate, revise, and generate again before submit", async () => {
  const context = await fixture(1);
  try {
    class AutonomousStepAgent extends FakeAgentProvider {
      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        const source = agentContext.run.lineage_nodes.find((node) => node.kind === "seed")!;
        await tools.selectParent(source.artifact_id, "Start from the lowest-debt source using its artifact ID.");
        await tools.setPrompt("Agent prompt revision one: repair the background while preserving the subject.");
        const firstArtifact = await tools.generateImage();
        await tools.viewImage(firstArtifact);
        const firstDraft = tools.getRunSnapshot().drafts.at(-1)!;
        const firstEvaluation = await tools.evaluateDraft(firstDraft.id);

        await tools.setPrompt("Agent prompt revision two: retain the successful background repair and restore source detail.");
        const secondArtifact = await tools.generateImage();
        await tools.viewImage(secondArtifact);
        const secondDraft = tools.getRunSnapshot().drafts.at(-1)!;
        const secondEvaluation = await tools.evaluateDraft(secondDraft.id);
        await tools.submitCandidate(secondDraft.id, secondEvaluation.comparative_decision_id!, {
          observation: `The first evaluation scored ${firstEvaluation.public_verification.overall_score}.`,
          hypothesis: "A focused second revision can preserve more source detail.",
          intervention: "Revised the prompt and generated a second draft in the same autonomous step.",
        }, {
          useful_findings: ["A focused second revision preserved more source detail."],
          failed_directions: [],
          current_hypotheses: ["Use the source as the preservation anchor."],
          preservation_constraints: ["Keep the subject unchanged."],
        });
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new AutonomousStepAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2, max_generations_per_round: 2 });
    const completed = await runner.start(run.id);
    assert.equal(completed.generation_count, 2);
    assert.equal(completed.evaluations.length, 2);
    assert.equal(completed.evaluation_frame_revisions.length, 1);
    assert.ok(completed.evaluations.every((evaluation) => evaluation.evaluation_frame_revision_id === completed.evaluation_frame_revisions[0]?.id));
    assert.equal(completed.attempts.length, 1);
    assert.equal(completed.attempts[0]?.draft_id, completed.drafts[1]?.id);
    assert.equal(completed.drafts[0]?.status, "abandoned");
    assert.equal(completed.drafts[1]?.status, "verified");
    assert.equal(completed.variation_attempts[0]?.memory_pending, false);
    assert.ok(completed.variation_attempts[0]?.memory_revision_id);
    assert.deepEqual(completed.working_memory.useful_findings, ["A focused second revision preserved more source detail."]);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("historical V3 snapshots project Evolution records without rewriting events", async () => {
  const context = await fixture(1);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await context.runner.start(run.id);
    const eventCount = (await context.store.listRunEvents(run.id)).length;
    const {
      human_intent_revision: _humanIntentRevision,
      active_evolution_version: _activeEvolutionVersion,
      active_variation_attempt: _activeVariationAttempt,
      evaluation_frame_revisions: _evaluationFrameRevisions,
      variation_attempts: _variationAttempts,
      comparative_decisions: _comparativeDecisions,
      search_archive: _searchArchive,
      incumbent_node_id: _incumbentNodeId,
      final_verifier_decisions: _finalVerifierDecisions,
      final_verifier_decision_id: _finalVerifierDecisionId,
      ...legacyFields
    } = completed;
    await writeFile(
      join(context.directory, "runs", run.id, "snapshot.json"),
      `${JSON.stringify({ ...legacyFields, schema_version: 3 }, null, 2)}\n`,
    );
    const projected = await context.store.getRun(run.id);
    assert.equal(projected.variation_steps.length, 2);
    assert.equal(projected.variation_attempts.length, 2);
    assert.deepEqual(projected.variation_attempts.map((attempt) => attempt.attempt), [1, 2]);
    assert.deepEqual(projected.variation_steps.flatMap((step) => step.draft_ids), completed.drafts.map((draft) => draft.id));
    assert.equal((await context.store.listRunEvents(run.id)).length, eventCount);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("an abandoned variation step preserves trajectory state and continues with a fresh step budget", async () => {
  const context = await fixture(1);
  try {
    class AbandoningAgent extends FakeAgentProvider {
      override async runRound(_agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        await tools.abandonStep("measured_regression", {
          observation: "The explored direction regressed preservation quality.",
          hypothesis: "A different parent or intervention is required.",
          intervention: "Ended the step without submitting a candidate.",
        });
        await tools.recordAgentRuntime({ totalTokens: 123_456, toolCalls: 1 });
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new AbandoningAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2, max_variation_steps: 2 });
    const completed = await runner.start(run.id);
    assert.equal(completed.status, "budget_exhausted");
    assert.equal(completed.terminal_reason, "variation_attempt_budget_exhausted");
    assert.equal(completed.active_variation_step, 3);
    assert.equal(completed.generation_count, 0);
    assert.equal(completed.active_evolution_version, 0);
    assert.equal(completed.lineage_nodes.length, 1);
    const events = await context.store.listRunEvents(run.id);
    assert.equal(events.filter((event) => event.type === "variation_attempt.recorded").length, 2);
    assert.deepEqual(completed.variation_steps.map((step) => step.status), ["abandoned", "abandoned"]);
    assert.equal(completed.variation_steps[0]?.usage_delta.total_tokens, 123_456);
    assert.equal(completed.variation_steps[0]?.usage_delta.tool_calls, 1);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("a user stop signal reaches the active autonomous step immediately", async () => {
  const context = await fixture(1);
  try {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    class StopAwareAgent extends FakeAgentProvider {
      override async runRound(_agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        signalStarted();
        await tools.waitForStop();
        await tools.abandonStep("user_stopped", {
          observation: "The user stopped the active autonomous Step.",
          hypothesis: "No further generation should run.",
          intervention: "Persist the Step and return control immediately.",
        });
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new StopAwareAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const execution = runner.start(run.id);
    await started;
    await runner.requestStop(run.id);
    const completed = await execution;
    assert.equal(completed.status, "stopped");
    assert.equal(completed.terminal_reason, "user_stopped");
    assert.equal(completed.generation_count, 0);
    assert.equal(completed.variation_steps[0]?.status, "abandoned");
    assert.equal(completed.variation_steps[0]?.terminal_reason, "user_stopped");
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("generation budget terminal state skips any post-submission supervisor call", async () => {
  const context = await fixture(1);
  try {
    class TerminalAgent extends FakeAgentProvider {
      override async supervise(): Promise<never> {
        throw new Error("supervisor_must_not_run_after_terminal_budget");
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new TerminalAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const completed = await runner.start(run.id);
    assert.equal(completed.status, "budget_exhausted");
    assert.equal(completed.terminal_reason, "generation_budget_exhausted");
    assert.equal(completed.lineage_attempt_ids.length, 1);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("source, historical commit, and safe draft can each be selected as explicit parents", async () => {
  const context = await fixture(1);
  try {
    class BranchingAgent extends FakeAgentProvider {
      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        const step = agentContext.run.attempts.length;
        await tools.setPrompt(`Agent branch prompt revision ${step + 1}`);
        const parentId = step === 0
          ? agentContext.run.lineage_nodes.find((node) => node.kind === "seed")!.id
          : step === 1
            ? agentContext.run.lineage_nodes.find((node) => node.kind === "commit")!.id
            : agentContext.run.drafts[0]!.id;
        await tools.selectParent(parentId, `Exercise explicit parent kind at step ${step + 1}.`);
        const artifactId = await tools.generateImage();
        await tools.viewImage(artifactId);
        const draft = tools.getRunSnapshot().drafts.at(-1)!;
        const evaluation = await tools.evaluateDraft(draft.id);
        await tools.submitCandidate(draft.id, evaluation.comparative_decision_id!, {
          observation: "Selected parent explicitly.", hypothesis: "Branch selection remains auditable.", intervention: `Branch step ${step + 1}.`,
        });
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new BranchingAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 3 });
    await runner.start(run.id);
    const events = await context.store.listRunEvents(run.id);
    assert.deepEqual(events.filter((event) => event.type === "parent.selected").map((event) =>
      (event.data.selection as { kind: string }).kind), ["source", "commit", "draft"]);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("trajectory monitor reacts to in-step debt regression and branch repetition", async () => {
  const context = await fixture(1);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 4 });
    const completed = await context.runner.start(run.id);
    const trends = completed.validator_trends.slice(0, 3).map((trend, index) => ({
      ...trend,
      source_warn: index + 1,
      semantic_gain: index + 1,
    }));
    const sameStepDrafts = completed.drafts.slice(0, 3).map((draft) => ({ ...draft, round: 1, origin_step: 1 }));
    const triggers = detectInStepTrajectoryTriggers({
      ...completed,
      active_variation_step: 1,
      drafts: [...sameStepDrafts, ...completed.drafts.slice(3)],
      validator_trends: trends,
    }, 1);
    assert.ok(triggers.includes("source_debt_three_generation_regression"));
    assert.ok(triggers.includes("same_branch_three_times"));
    assert.equal(triggers.includes("budget_seventy_five_percent"), false);
    const boundary = detectStepBoundaryTriggers({
      ...completed,
      variation_attempts: completed.variation_attempts.slice(0, 3).map(({ committed_lineage_node_id: _lineageNodeId, ...attempt }) => ({ ...attempt, status: "abandoned" as const })),
    });
    assert.ok(boundary.includes("three_attempts_without_new_version"));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("supervisor failure is advisory and does not fail a committed run", async () => {
  const context = await fixture(1);
  try {
    class InvalidSupervisorAgent extends FakeAgentProvider {
      calls = 0;
      override async supervise(): Promise<never> {
        this.calls += 1;
        throw new Error("codex_supervisor_invalid_output");
      }
    }
    const agent = new InvalidSupervisorAgent();
    const runner = new AvoRunner(context.store, context.artifacts, agent, new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const supervised = await runner.maybeRunSupervisor(context.task, run, ["three_steps_without_new_best"], "step_boundary");
    const completed = await runner.start(supervised.id);
    assert.equal(completed.status, "budget_exhausted");
    assert.equal(completed.generation_count, 1);
    assert.ok(completed.lineage_nodes.some((node) => node.kind === "commit"));
    assert.equal(agent.calls, 1);
    const events = await context.store.listRunEvents(run.id);
    const failure = events.find((event) => event.type === "supervisor.failed");
    assert.equal((failure?.data.failure as { code?: string } | undefined)?.code, "invalid_structured_output");
    assert.equal(completed.supervisor_failures[0]?.code, "invalid_structured_output");
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("Supervisor cannot continue an unchanged branch after three Attempts without a new version", async () => {
  const context = await fixture(1);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 3 });
    const completed = await context.runner.start(run.id);
    const stagnated = {
      ...completed,
      variation_attempts: completed.variation_attempts.slice(0, 3).map(({ committed_lineage_node_id: _commit, ...attempt }) => ({
        ...attempt,
        status: "abandoned" as const,
      })),
    };
    class ContinuingSupervisor extends FakeAgentProvider {
      calls = 0;
      override async supervise() {
        this.calls += 1;
        return {
          intervene: false,
          diagnosis: "Continue the same branch despite the measured plateau.",
          branch_strategy: "continue" as const,
          quality_risks: [],
          avoid: [],
          try: ["Continue"],
        };
      }
    }
    const agent = new ContinuingSupervisor();
    const runner = new AvoRunner(context.store, context.artifacts, agent, new FakeImageProvider(), context.verifier);
    const supervised = await runner.maybeRunSupervisor(
      context.task,
      stagnated,
      ["three_attempts_without_new_version"],
      "step_boundary",
    );
    assert.equal(agent.calls, 2);
    assert.equal(supervised.pending_supervisor_decision, undefined);
    assert.equal(supervised.supervisor_failures.at(-1)?.code, "invalid_structured_output");
    assert.match(supervised.supervisor_failures.at(-1)?.detail ?? "", /stagnation_requires_strategy_change/);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("supervisor can stop a converged search while the Verifier selects Final", async () => {
  const context = await fixture(1);
  try {
    class ConvergingAgent extends FakeAgentProvider {
      roundCalls = 0;
      supervisorCalls = 0;

      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        this.roundCalls += 1;
        if (agentContext.run.active_variation_attempt === 1) {
          await tools.selectParent(agentContext.run.lineage_nodes[0]!.id, "Create the first measured candidate from Source.");
          await tools.setPrompt("Agent-authored prompt for the converged lineage candidate.");
          const artifactId = await tools.generateImage();
          await tools.viewImage(artifactId);
          const draft = tools.getRunSnapshot().drafts.at(-1)!;
          const evaluation = await tools.evaluateDraft(draft.id);
          await tools.submitCandidate(draft.id, evaluation.comparative_decision_id!, {
            observation: "The candidate passes the correctness gate.",
            hypothesis: "This is the strongest measured candidate.",
            intervention: "Commit the candidate before exploring alternatives.",
          });
          return;
        }
        await tools.abandonStep(`attempt_${agentContext.run.active_variation_attempt}_measured_no_improvement`, {
          observation: "No remaining direction has positive measured value.",
          hypothesis: "The committed candidate is a stable local optimum.",
          intervention: "Close this Attempt without spending another generation.",
        });
      }

      override async supervise(agentContext: Parameters<FakeAgentProvider["supervise"]>[0], request: Parameters<FakeAgentProvider["supervise"]>[1]) {
        this.supervisorCalls += 1;
        assert.equal(request.scope, "step_boundary");
        assert.ok(request.triggers.includes("three_attempts_without_new_version"));
        return {
          intervene: true,
          diagnosis: "Three completed Attempts produced no new official version; the measured search has converged.",
          branch_strategy: "stop_search" as const,
          quality_risks: [],
          avoid: ["Spending generation budget on measured regressions"],
          try: ["Stop search and let the terminal Verifier select Final"],
        };
      }
    }

    const agent = new ConvergingAgent();
    const runner = new AvoRunner(context.store, context.artifacts, agent, new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 8, max_variation_steps: 10 });
    const completed = await runner.start(run.id);
    const finalNode = completed.lineage_nodes.find((node) => node.id === completed.final_lineage_node_id);
    const finalEvaluation = completed.evaluations.find((evaluation) => evaluation.id === finalNode?.evaluation_id);

    assert.equal(completed.status, "completed");
    assert.equal(completed.terminal_reason, "supervisor_stopped_search");
    assert.equal(completed.generation_count, 1);
    assert.equal(completed.variation_attempts.length, 4);
    assert.equal(agent.roundCalls, 4);
    assert.equal(agent.supervisorCalls, 1);
    assert.equal(finalNode?.kind, "commit");
    assert.equal(finalNode?.version, 1);
    assert.equal(finalEvaluation?.correctness_gate.passed, true);
    assert.equal(completed.supervisor_decisions.at(-1)?.branch_strategy, "stop_search");
    assert.ok(completed.final_verifier_decision_id);
    assert.ok(completed.supervisor_decisions.at(-1)?.consumed_at);
    assert.equal(completed.terminal_supervisor_decision_id, completed.supervisor_decisions.at(-1)?.id);
    const events = await context.store.listRunEvents(run.id);
    const terminalEvent = events.findLast((event) => event.type === "run.completed");
    assert.equal(terminalEvent?.data.final_lineage_node_id, finalNode?.id);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("a malformed Final Verifier result is recoverable without restarting autonomous search", async () => {
  const context = await fixture(1);
  try {
    class CountingAgent extends FakeAgentProvider {
      roundCalls = 0;

      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        this.roundCalls += 1;
        return super.runRound(agentContext, tools);
      }
    }
    class RecoveringFinalVerifier extends FakeVerifierProvider {
      finalCalls = 0;

      override async selectFinal(input: Parameters<FakeVerifierProvider["selectFinal"]>[0]) {
        this.finalCalls += 1;
        if (this.finalCalls === 1) throw new Error("verifier_invalid_json_after_repair:evidence_refs[4]");
        return super.selectFinal(input);
      }
    }

    const agent = new CountingAgent();
    const verifier = new RecoveringFinalVerifier(1);
    const runner = new AvoRunner(context.store, context.artifacts, agent, new FakeImageProvider(), verifier);
    const run = await runner.createRun(context.task.id, { mode: "one_shot", max_generations: 1 });
    const pending = await runner.start(run.id);

    assert.equal(pending.status, "finalization_pending");
    assert.equal(pending.terminal_reason, "finalization_pending");
    assert.equal(pending.pending_finalization?.requested_status, "completed");
    assert.equal(pending.pending_finalization?.terminal_reason, "one_shot_finished");
    assert.equal(pending.pending_finalization?.failure_code, "invalid_structured_output");
    assert.equal(pending.pending_finalization?.attempts, 1);
    assert.equal(pending.generation_count, 1);
    assert.equal(agent.roundCalls, 1);
    const pendingEvents = await context.store.listRunEvents(run.id);
    assert.equal(pendingEvents.some((event) => event.type === "verifier.final_selection_failed"), true);
    assert.equal(pendingEvents.some((event) => event.type === "run.failed"), false);

    const queued = await runner.resume(run.id);
    assert.equal(queued.status, "queued");
    let completed = await context.store.getRun(run.id);
    for (let attempt = 0; attempt < 100 && ["queued", "running"].includes(completed.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      completed = await context.store.getRun(run.id);
    }
    assert.equal(completed.status, "completed", completed.terminal_reason);
    assert.equal(completed.terminal_reason, "one_shot_finished");
    assert.equal(completed.pending_finalization, undefined);
    assert.ok(completed.final_verifier_decision_id);
    assert.equal(completed.generation_count, 1);
    assert.equal(agent.roundCalls, 1);
    assert.equal(verifier.finalCalls, 2);
    const completedEvents = await context.store.listRunEvents(run.id);
    assert.equal(completedEvents.some((event) => event.type === "run.finalization_resumed"), true);
    assert.equal(completedEvents.some((event) => event.type === "run.finalization_started"), true);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("unsafe Supervisor terminal advice is recorded as advisory failure", async () => {
  const context = await fixture(1);
  try {
    class UnsafeTerminalAgent extends FakeAgentProvider {
      override async supervise(agentContext: Parameters<FakeAgentProvider["supervise"]>[0]) {
        return {
          intervene: true,
          diagnosis: "Stop without a measured convergence window.",
          branch_strategy: "stop_search" as const,
          quality_risks: [],
          avoid: [],
          try: ["Stop"],
        };
      }
    }
    const agent = new UnsafeTerminalAgent();
    const runner = new AvoRunner(context.store, context.artifacts, agent, new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 8 });
    const supervised = await runner.maybeRunSupervisor(context.task, run, ["three_attempts_without_new_version"], "step_boundary");
    assert.equal(supervised.pending_supervisor_decision, undefined);
    assert.equal(supervised.final_lineage_node_id, undefined);
    assert.equal(supervised.supervisor_failures[0]?.code, "invalid_structured_output");
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("one-shot still uses an agent-authored prompt, parent and evaluation", async () => {
  const context = await fixture(1);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "one_shot", max_generations: 1 });
    const completed = await context.runner.start(run.id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.prompt_revisions[0]?.origin, "agent");
    assert.equal(completed.evaluations.length, 1);
    assert.ok(completed.drafts[0]?.viewed_at);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("the immutable user brief is never used directly as the provider prompt", async () => {
  const context = await fixture(1);
  try {
    let providerPrompt = "";
    class RecordingProvider extends FakeImageProvider {
      override async generate(input: Parameters<FakeImageProvider["generate"]>[0]) {
        providerPrompt = input.prompt;
        return super.generate(input);
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new FakeAgentProvider(), new RecordingProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "one_shot", max_generations: 1 });
    await runner.start(run.id);
    assert.notEqual(providerPrompt.trim(), context.task.user_brief.trim());
    assert.ok(providerPrompt.includes("Iteration 1"));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("generate requires both agent prompt and explicit parent selection", async () => {
  const context = await fixture();
  try {
    class InvalidAgent extends FakeAgentProvider {
      override async runRound(_context: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        await tools.generateImage();
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new InvalidAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const completed = await runner.start(run.id);
    assert.equal(completed.status, "failed");
    assert.equal(completed.terminal_reason, "agent_generation_prompt_required");
    assert.equal(completed.generation_count, 0);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("an unevaluated draft cannot be submitted", async () => {
  const context = await fixture();
  try {
    class InvalidSubmitAgent extends FakeAgentProvider {
      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        await tools.setPrompt("Agent-authored generation prompt");
        await tools.selectParent(agentContext.run.lineage_nodes[0]!.id, "Restart from source.");
        const artifactId = await tools.generateImage();
        await tools.viewImage(artifactId);
        const draft = tools.getRunSnapshot().drafts.at(-1)!;
        await tools.submitCandidate(draft.id, "evaluation-missing", {
          observation: "Draft exists.", hypothesis: "Bypass evaluation.", intervention: "Submit directly.",
        });
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new InvalidSubmitAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const completed = await runner.start(run.id);
    assert.equal(completed.status, "failed");
    assert.equal(completed.terminal_reason, "comparative_decision_required");
    assert.equal(completed.verifier_count, 0);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("an Agentic Verifier blocker failure closes the correctness gate and prevents commit", async () => {
  const context = await fixture(1);
  try {
    const sourcePath = (await context.artifacts.get(context.source.id)).path;
    class SplitVerifier extends FakeVerifierProvider {
      override async compare(input: Parameters<FakeVerifierProvider["compare"]>[0]) {
        const result = await super.compare(input);
        return {
          ...result,
          correctness: "fail" as const,
          preference: "worse" as const,
          target_progress: "regressed" as const,
          recommendation: "archive" as const,
          axis_judgments: result.axis_judgments.map((judgment) => ({
            ...judgment,
            verdict: "fail" as const,
            candidate_score: 45,
            incumbent_score: 80,
            evidence: "The hidden target exposes a blocker regression.",
          })),
          feedback_for_main_agent: ["The target-critical direction regressed."],
        };
      }
    }
    const runner = new AvoRunner(
      context.store,
      context.artifacts,
      new FakeAgentProvider(),
      new FakeImageProvider(),
      new SplitVerifier(1),
      { getForTask: async () => ({ revision: "sealed-test-v1", references: [], hiddenTargetPath: sourcePath }) },
    );
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const completed = await runner.start(run.id);
    assert.equal(completed.evaluations[0]?.public_verification.status, "FAIL");
    assert.equal(completed.comparative_decisions[0]?.preference, "worse");
    assert.equal(completed.evaluations[0]?.correctness_gate.passed, false);
    assert.match(completed.evaluations[0]?.correctness_gate.blockers[0] ?? "", /^frame:/);
    assert.equal(completed.search_archive[0]?.outcome, "worse");
    assert.equal(completed.lineage_nodes.filter((node) => node.kind === "commit").length, 0);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("an equivalent candidate is archived and never increments the official lineage", async () => {
  const context = await fixture(1);
  try {
    class EquivalentVerifier extends FakeVerifierProvider {
      override async compare(input: Parameters<FakeVerifierProvider["compare"]>[0]) {
        const result = await super.compare(input);
        return {
          ...result,
          preference: "equivalent" as const,
          target_progress: "unchanged" as const,
          recommendation: "archive" as const,
          confidence: 0.9,
          feedback_for_main_agent: ["The candidate is equivalent to the incumbent."],
        };
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new FakeAgentProvider(), new FakeImageProvider(), new EquivalentVerifier(1));
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const completed = await runner.start(run.id);
    assert.equal(completed.active_evolution_version, 0);
    assert.equal(completed.lineage_nodes.filter((node) => node.kind === "commit").length, 0);
    assert.equal(completed.search_archive[0]?.outcome, "equivalent");
    assert.equal(completed.final_lineage_node_id, completed.lineage_nodes[0]?.id);
    assert.ok(completed.final_verifier_decision_id);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("Verifier confidence is uncertainty telemetry and does not veto a holistic better decision", async () => {
  const context = await fixture(1);
  try {
    class LowConfidenceVerifier extends FakeVerifierProvider {
      override async compare(input: Parameters<FakeVerifierProvider["compare"]>[0]) {
        const result = await super.compare(input);
        return { ...result, confidence: 0.51 };
      }
    }
    const runner = new AvoRunner(
      context.store,
      context.artifacts,
      new FakeAgentProvider(),
      new FakeImageProvider(),
      new LowConfidenceVerifier(1),
    );
    const run = await runner.createRun(context.task.id, { mode: "one_shot", max_generations: 1 });
    const completed = await runner.start(run.id);
    assert.equal(completed.status, "completed", completed.terminal_reason);
    assert.equal(completed.comparative_decisions[0]?.confidence, 0.51);
    assert.equal(completed.comparative_decisions[0]?.recommendation, "commit");
    assert.equal(completed.lineage_nodes.filter((node) => node.kind === "commit").length, 1);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("Final Verifier can promote an eligible unsubmitted Archive finalist", async () => {
  const context = await fixture(1);
  try {
    class ArchiveAgent extends FakeAgentProvider {
      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        await tools.selectParent(agentContext.run.lineage_nodes[0]!.id, "Generate one measured terminal finalist from Source.");
        await tools.setPrompt("Create a candidate that should be considered by terminal verification.");
        const artifactId = await tools.generateImage();
        await tools.viewImage(artifactId);
        const draft = tools.getRunSnapshot().drafts.at(-1)!;
        await tools.evaluateDraft(draft.id);
        await tools.abandonStep("defer_to_final_verifier", {
          observation: "The measured candidate was intentionally not submitted during the Attempt.",
          hypothesis: "Terminal holistic comparison can still reconsider it.",
          intervention: "Preserve it in the Search Archive.",
        });
      }
    }
    class ArchiveSelectingVerifier extends FakeVerifierProvider {
      override async selectFinal(input: Parameters<FakeVerifierProvider["selectFinal"]>[0]) {
        const result = await super.selectFinal(input);
        const selected = input.candidates.find((candidate) => candidate.origin === "archive");
        assert.ok(selected, "eligible Archive finalist was not offered to Final Verifier");
        return {
          ...result,
          candidate_node_ids: input.candidates.map((candidate) => candidate.node.id),
          selected_node_id: selected.node.id,
          rationale: "The Archive finalist is the strongest image under direct terminal comparison.",
          evidence_refs: selected.acceptedDecision?.evidence_refs ?? [],
        };
      }
    }
    const verifier = new ArchiveSelectingVerifier(1);
    const runner = new AvoRunner(context.store, context.artifacts, new ArchiveAgent(), new FakeImageProvider(), verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 1 });
    const completed = await runner.start(run.id);
    const selected = completed.lineage_nodes.find((node) => node.id === completed.final_lineage_node_id);
    assert.equal(completed.status, "budget_exhausted", completed.terminal_reason);
    assert.equal(selected?.kind, "commit");
    assert.equal(selected?.version, 1);
    assert.equal(selected?.draft_id, completed.drafts[0]?.id);
    assert.equal(completed.incumbent_node_id, selected?.id);
    assert.equal(completed.search_archive.some((entry) => entry.draft_id === selected?.draft_id), false);
    const events = await context.store.listRunEvents(run.id);
    const finalEvent = events.findLast((event) => event.type === "verifier.final_selected");
    assert.equal(finalEvent?.data.selected_origin, "archive");
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("a later step can submit a carried draft without rewriting its origin step", async () => {
  const context = await fixture(1);
  try {
    class CarryDecisionAgent extends FakeAgentProvider {
      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        if (agentContext.run.active_variation_attempt === 1) {
          await tools.setPrompt("Create one measured candidate before the runtime boundary.");
          await tools.selectParent(agentContext.run.lineage_nodes[0]!.id, "Use source for the first measured direction.");
          const artifactId = await tools.generateImage();
          await tools.viewImage(artifactId);
          const draft = tools.getRunSnapshot().drafts.at(-1)!;
          await tools.evaluateDraft(draft.id);
          await tools.abandonStep("agent_step_timeout", {
            observation: "The draft was measured before cutoff.",
            hypothesis: "A fresh Step can make the durable decision.",
            intervention: "Carry the evaluated draft forward.",
          }, undefined, "runtime_cutoff");
          return;
        }
        const pending = agentContext.run.pending_decision!;
        const draft = agentContext.run.drafts.find((item) => item.id === pending.draft_ids[0])!;
        const evaluation = await tools.evaluateDraft(draft.id);
        await tools.submitCandidate(draft.id, evaluation.comparative_decision_id!, {
          observation: "Reviewed the carried candidate.",
          hypothesis: "The prior measured candidate remains the strongest option.",
          intervention: "Submitted it from the current decision Step.",
        });
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new CarryDecisionAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2, max_variation_steps: 2 });
    const completed = await runner.start(run.id);
    assert.equal(completed.variation_attempts[0]?.status, "runtime_cutoff");
    assert.equal(completed.variation_attempts[1]?.status, "submitted", completed.terminal_reason);
    assert.equal(completed.variation_steps[1]?.selected_draft_origin_step, 1);
    assert.equal(completed.attempts[0]?.origin_step, 1);
    assert.equal(completed.attempts[0]?.decision_step, 2);
    assert.equal(completed.drafts[0]?.status, "verified");
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("repeated evaluation of the same draft is cached", async () => {
  const context = await fixture(1);
  try {
    class CacheAgent extends FakeAgentProvider {
      override async runRound(agentContext: Parameters<FakeAgentProvider["runRound"]>[0], tools: Parameters<FakeAgentProvider["runRound"]>[1]) {
        await tools.setPrompt("Agent-authored generation prompt");
        await tools.selectParent(agentContext.run.lineage_nodes[0]!.id, "Use source.");
        const artifactId = await tools.generateImage();
        await tools.viewImage(artifactId);
        const draft = tools.getRunSnapshot().drafts.at(-1)!;
        const first = await tools.evaluateDraft(draft.id);
        const second = await tools.evaluateDraft(draft.id);
        assert.equal(second.id, first.id);
        await tools.submitCandidate(draft.id, first.comparative_decision_id!, {
          observation: "Evaluation cached.", hypothesis: "No duplicate VLM call.", intervention: "Submit evaluated draft.",
        });
      }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new CacheAgent(), new FakeImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "one_shot", max_generations: 1 });
    const completed = await runner.start(run.id);
    assert.equal(completed.verifier_count, 1);
    assert.equal(completed.evaluations.length, 1);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("snapshot rebuild preserves V3 evaluations and lineage", async () => {
  const context = await fixture(1);
  try {
    const run = await context.runner.createRun(context.task.id, { mode: "one_shot", max_generations: 1 });
    const completed = await context.runner.start(run.id);
    await unlink(join(context.directory, "runs", run.id, "snapshot.json"));
    const rebuilt = await context.store.getRun(run.id);
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(completed)));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("run events append compact patches and rebuild the exact snapshot", async () => {
  const context = await fixture(1);
  try {
    const created = await context.runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    let expected = created;
    for (let revision = 1; revision <= 20; revision += 1) {
      expected = await context.store.commitRun(created.id, "test.prompt_updated", { revision }, (current) => ({
        ...current!,
        prompt: `Agent prompt revision ${revision}: 保持主体不变。`,
        updated_at: new Date(Date.now() + revision).toISOString(),
      }));
    }

    const eventPath = join(context.directory, "runs", created.id, "events.jsonl");
    const serialized = await readFile(eventPath, "utf8");
    const persisted = serialized.trim().split("\n").map((line) => JSON.parse(line) as { data: Record<string, unknown> });
    assert.equal(persisted.length, 21);
    assert.ok(persisted[0]?.data._snapshot);
    assert.ok(persisted.slice(1).every((event) => Array.isArray(event.data._snapshot_patch)));
    assert.ok(persisted.slice(1).every((event) => !("_snapshot" in event.data)));
    const repeatedSnapshotSize = JSON.stringify(expected).length * persisted.length;
    assert.ok(serialized.length < repeatedSnapshotSize / 4, `event log unexpectedly large: ${serialized.length}`);

    const publicEvents = await context.store.listRunEvents(created.id);
    assert.ok(publicEvents.every((event) => !("_snapshot" in event.data) && !("_snapshot_patch" in event.data)));
    const tail = await context.store.listRunEvents(created.id, { afterSequence: 19 });
    assert.deepEqual(tail.map((event) => event.sequence), [20, 21]);

    await writeFile(
      join(context.directory, "runs", created.id, "snapshot.json"),
      `${JSON.stringify({ ...created, _event_sequence: 1 }, null, 2)}\n`,
    );
    const recoveredFromStaleSnapshot = await context.store.getRun(created.id);
    assert.deepEqual(JSON.parse(JSON.stringify(recoveredFromStaleSnapshot)), JSON.parse(JSON.stringify(expected)));

    await unlink(join(context.directory, "runs", created.id, "snapshot.json"));
    const rebuilt = await context.store.getRun(created.id);
    assert.deepEqual(JSON.parse(JSON.stringify(rebuilt)), JSON.parse(JSON.stringify(expected)));
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("ambiguous image generation is counted once and never retried", async () => {
  const context = await fixture();
  try {
    let calls = 0;
    class AmbiguousImageProvider extends FakeImageProvider {
      override async generate(): Promise<never> { calls += 1; throw new Error("image_provider_ambiguous:socket_closed"); }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new FakeAgentProvider(), new AmbiguousImageProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "avo", max_generations: 2 });
    const completed = await runner.start(run.id);
    assert.equal(calls, 1);
    assert.equal(completed.generation_count, 1);
    assert.equal(completed.evaluations.length, 0);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("provider output bytes and dimensions remain unchanged", async () => {
  const context = await fixture(1);
  try {
    const output = await sharp({ create: { width: 80, height: 80, channels: 3, background: "#336699" } }).png().toBuffer();
    class SquareProvider extends FakeImageProvider {
      override async generate() { return { bytes: Buffer.from(output), mimeType: "image/png" as const, originalName: "square.png", latencyMs: 1, usage: { total_tokens: 0, unpriced: true } }; }
    }
    const runner = new AvoRunner(context.store, context.artifacts, new FakeAgentProvider(), new SquareProvider(), context.verifier);
    const run = await runner.createRun(context.task.id, { mode: "one_shot", max_generations: 1 });
    const completed = await runner.start(run.id);
    assert.deepEqual(completed.drafts[0]?.dimensions.final, { width: 80, height: 80 });
    assert.equal(completed.drafts[0]?.dimensions.normalized, false);
  } finally { await rm(context.directory, { recursive: true, force: true }); }
});

test("unsafe identifiers cannot escape the data directory", async () => {
  const context = await fixture();
  try { await assert.rejects(context.store.getTask("../outside"), /invalid_id/); }
  finally { await rm(context.directory, { recursive: true, force: true }); }
});
