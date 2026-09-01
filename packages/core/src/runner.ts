import {
  runConfigSchema,
  runSnapshotSchema,
  verificationResultSchema,
  workingMemorySchema,
  type AgentSummary,
  type CandidateAttempt,
  type GenerationInput,
  type RunConfig,
  type RunSnapshot,
  type TaskManifest,
  type VerificationResult,
  type WorkingMemory,
} from "@avo/contracts";
import { ArtifactStore } from "./artifacts.ts";
import { createId } from "./ids.ts";
import type {
  AgentProvider,
  AgentRoundContext,
  AgentToolbox,
  BestOfVariant,
  ImageProvider,
  VerifierProvider,
} from "./providers.ts";
import { FileStateStore } from "./store.ts";

type Submission = { artifactId: string; summary: AgentSummary };

const now = () => new Date().toISOString();

const bestFailure = (attempts: CandidateAttempt[]) => attempts
  .filter((attempt) => attempt.status === "failed" && attempt.verification)
  .sort((left, right) => {
    const score = (right.verification?.overall_score ?? -1) - (left.verification?.overall_score ?? -1);
    if (score !== 0) return score;
    const minLeft = Math.min(...(left.verification?.requirements.map((item) => item.score) ?? [-1]));
    const minRight = Math.min(...(right.verification?.requirements.map((item) => item.score) ?? [-1]));
    if (minRight !== minLeft) return minRight - minLeft;
    return left.created_at.localeCompare(right.created_at);
  })[0];

export class AvoRunner {
  private readonly activeRuns = new Map<string, Promise<RunSnapshot>>();
  private readonly stopRequests = new Set<string>();

  constructor(
    readonly store: FileStateStore,
    readonly artifacts: ArtifactStore,
    readonly agent: AgentProvider,
    readonly images: ImageProvider,
    readonly verifier: VerifierProvider,
  ) {}

  async createRun(taskId: string, configInput: Partial<RunConfig> & Pick<RunConfig, "mode">) {
    const task = await this.store.getTask(taskId);
    const config = runConfigSchema.parse(configInput);
    const createdAt = now();
    const snapshot = runSnapshotSchema.parse({
      schema_version: 1,
      id: createId("run"),
      task_id: task.id,
      config,
      status: "queued",
      prompt: task.request,
      selected_input: {
        base_artifact_id: task.source_artifact_id,
        reference_artifact_ids: task.references.map((reference) => reference.artifact_id),
      },
      attempts: [],
      lineage_attempt_ids: [],
      working_memory: workingMemorySchema.parse({}),
      consecutive_failures: 0,
      generation_count: 0,
      verifier_count: 0,
      created_at: createdAt,
      updated_at: createdAt,
    });
    await this.store.createRun(snapshot);
    return snapshot;
  }

  start(runId: string) {
    const existing = this.activeRuns.get(runId);
    if (existing) return existing;
    const execution = this.execute(runId).finally(() => this.activeRuns.delete(runId));
    this.activeRuns.set(runId, execution);
    return execution;
  }

  requestStop(runId: string) {
    this.stopRequests.add(runId);
    return this.store.commitRun(runId, "run.stop_requested", {}, (current) => {
      if (!current) throw new Error("run_not_found");
      if (["completed", "failed", "stopped", "budget_exhausted"].includes(current.status)) return current;
      return { ...current, status: "stop_requested", updated_at: now() };
    });
  }

  async resume(runId: string) {
    const run = await this.store.getRun(runId);
    if (!["stopped", "interrupted", "failed"].includes(run.status)) throw new Error("run_not_resumable");
    this.stopRequests.delete(runId);
    const queued = await this.store.commitRun(runId, "run.resumed", {}, () => ({
      ...withoutTerminalFields(run),
      status: "queued",
      updated_at: now(),
    }));
    void this.start(runId);
    return queued;
  }

  isActive(runId: string) {
    return this.activeRuns.has(runId);
  }

  private async execute(runId: string): Promise<RunSnapshot> {
    let run = await this.store.getRun(runId);
    const task = await this.ensureChecklist(await this.store.getTask(run.task_id));
    run = await this.store.commitRun(runId, "run.started", {}, () => ({
      ...withoutTerminalFields(run),
      status: "running",
      started_at: run.started_at ?? now(),
      updated_at: now(),
    }));

    try {
      if (run.config.mode === "best_of_n") return await this.executeBestOf(task, run);
      while (true) {
        run = await this.store.getRun(runId);
        const terminal = this.terminalStatus(run);
        if (terminal) return await this.finish(run, terminal.status, terminal.reason);
        const context = await this.createRoundContext(task, run);
        const session = new RoundToolSession(this, task, run);
        await this.agent.runRound(context, session);
        const submission = session.submission;
        if (!submission) throw new Error("agent_did_not_submit_candidate");
        run = await this.verifySubmission(task, await this.store.getRun(runId), session, submission);
        if (run.status === "completed") return run;
        if (run.config.mode === "one_shot") return this.finish(run, "completed", "one_shot_finished");
        if (run.consecutive_failures > 0 && run.consecutive_failures % 3 === 0 && run.config.supervisor_enabled) {
          const redirect = await this.agent.supervise(await this.createRoundContext(task, run));
          run = await this.store.commitRun(run.id, "supervisor.completed", { redirect }, () => ({
            ...run,
            pending_supervisor_redirect: redirect,
            updated_at: now(),
          }));
        }
      }
    } catch (error) {
      const current = await this.store.getRun(runId);
      if (this.stopRequests.has(runId)) return this.finish(current, "stopped", "user_stopped");
      return this.finish(current, "failed", (error as Error).message || "run_failed");
    }
  }

  private async executeBestOf(task: TaskManifest, initialRun: RunSnapshot) {
    let run = initialRun;
    const context = await this.createRoundContext(task, run);
    const variants = await this.agent.planBestOf(context, run.config.max_generations);
    if (variants.length !== run.config.max_generations) throw new Error("best_of_variant_count_mismatch");
    const generated: Array<{ session: RoundToolSession; submission: Submission }> = [];
    for (const variant of variants) {
      run = await this.store.getRun(run.id);
      const terminal = this.terminalStatus(run);
      if (terminal) return this.finish(run, terminal.status, terminal.reason);
      const session = new RoundToolSession(this, task, run);
      session.setPrompt(variant.prompt);
      session.selectGenerationInputs(variant.input);
      const artifactId = await session.generateImage();
      session.submitCandidate(artifactId, variant.summary);
      generated.push({ session, submission: session.submission! });
    }
    for (const candidate of generated) {
      run = await this.verifySubmission(task, await this.store.getRun(run.id), candidate.session, candidate.submission);
    }
    return this.finish(run, "completed", "best_of_n_finished");
  }

  private async ensureChecklist(task: TaskManifest) {
    if (task.checklist) return task;
    const source = await this.artifacts.get(task.source_artifact_id);
    const references = await Promise.all(task.references.map(async (reference) => ({
      path: (await this.artifacts.get(reference.artifact_id)).path,
      ...(reference.caption ? { caption: reference.caption } : {}),
    })));
    const checklist = await this.verifier.createChecklist({ task, sourcePath: source.path, references });
    return this.store.saveTask({ ...task, checklist });
  }

  async generateDraft(task: TaskManifest, run: RunSnapshot, prompt: string, input: GenerationInput) {
    this.assertAllowedInput(task, run, input);
    if (run.generation_count >= run.config.max_generations) throw new Error("generation_budget_exhausted");
    const base = await this.artifacts.get(input.base_artifact_id);
    const references = await Promise.all(input.reference_artifact_ids.map((id) => this.artifacts.get(id)));
    const draftId = createId("draft");
    let result: Awaited<ReturnType<ImageProvider["generate"]>>;
    try {
      result = await this.images.generate({
        prompt,
        base: { path: base.path, mimeType: base.artifact.mime_type },
        references: references.map((item) => ({ path: item.path, mimeType: item.artifact.mime_type })),
        idempotencyKey: `${run.id}:${draftId}`,
      });
    } catch (error) {
      const message = (error as Error).message || "image_provider_failed";
      if (!message.startsWith("image_provider_ambiguous:")) throw error;
      await this.store.commitRun(run.id, "generation.ambiguous", {
        draft_id: draftId,
        error: message,
      }, (current) => {
        if (!current) throw new Error("run_not_found");
        return { ...current, generation_count: current.generation_count + 1, updated_at: now() };
      });
      throw error;
    }
    const artifact = await this.artifacts.put({ bytes: result.bytes, mimeType: result.mimeType, originalName: result.originalName });
    const updated = await this.store.commitRun(run.id, "generation.completed", {
      draft_id: draftId,
      artifact_id: artifact.id,
      latency_ms: result.latencyMs,
      usage: result.usage ?? null,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return { ...current, generation_count: current.generation_count + 1, updated_at: now() };
    });
    return { artifactId: artifact.id, usage: result.usage, run: updated };
  }

  private async verifySubmission(task: TaskManifest, run: RunSnapshot, session: RoundToolSession, submission: Submission) {
    const candidate = await this.artifacts.get(submission.artifactId);
    const source = await this.artifacts.get(task.source_artifact_id);
    const references = await Promise.all(task.references.map(async (reference) => ({
      path: (await this.artifacts.get(reference.artifact_id)).path,
      ...(reference.caption ? { caption: reference.caption } : {}),
    })));
    let verification: VerificationResult;
    try {
      verification = verificationResultSchema.parse(await this.verifier.verify({
        runId: run.id,
        attemptNumber: run.verifier_count + 1,
        task,
        checklist: task.checklist!,
        sourcePath: source.path,
        references,
        candidatePath: candidate.path,
      }));
    } catch (error) {
      const attempt: CandidateAttempt = {
        id: createId("attempt"),
        run_id: run.id,
        round: run.attempts.length + 1,
        ...(session.parentAttemptId ? { parent_attempt_id: session.parentAttemptId } : {}),
        prompt: session.getPrompt(),
        generation_input: session.selectedInput,
        generated_artifact_id: submission.artifactId,
        ...(session.lastUsage ? { generation_usage: session.lastUsage } : {}),
        agent_summary: submission.summary,
        status: "verification_error",
        created_at: now(),
      };
      await this.store.commitRun(run.id, "candidate.verification_error", {
        attempt_id: attempt.id,
        error: (error as Error).message,
      }, (current) => {
        if (!current) throw new Error("run_not_found");
        return {
          ...current,
          attempts: [...current.attempts, attempt],
          verifier_count: current.verifier_count + 1,
          updated_at: now(),
        };
      });
      throw error;
    }
    this.assertVerifierConsistency(task, verification);
    const attempt: CandidateAttempt = {
      id: createId("attempt"),
      run_id: run.id,
      round: run.attempts.length + 1,
      ...(session.parentAttemptId ? { parent_attempt_id: session.parentAttemptId } : {}),
      prompt: session.getPrompt(),
      generation_input: session.selectedInput,
      generated_artifact_id: submission.artifactId,
      ...(session.lastUsage ? { generation_usage: session.lastUsage } : {}),
      agent_summary: submission.summary,
      verification,
      status: verification.status === "PASS" ? "passed" : "failed",
      created_at: now(),
    };
    return this.store.commitRun(run.id, verification.status === "PASS" ? "candidate.passed" : "candidate.failed", {
      attempt_id: attempt.id,
      verification,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      const attempts = [...current.attempts, attempt];
      const best = bestFailure(attempts);
      const firstPass = verification.status === "PASS" && current.lineage_attempt_ids.length === 0;
      const hasPass = firstPass || current.lineage_attempt_ids.length > 0;
      const { pending_supervisor_redirect: _consumedRedirect, ...currentWithoutRedirect } = current;
      return {
        ...currentWithoutRedirect,
        attempts,
        prompt: attempt.prompt,
        selected_input: verification.status === "FAIL" && best
          ? {
              base_artifact_id: best.generated_artifact_id,
              reference_artifact_ids: best.generation_input.reference_artifact_ids,
            }
          : attempt.generation_input,
        lineage_attempt_ids: firstPass
          ? [...current.lineage_attempt_ids, attempt.id]
          : current.lineage_attempt_ids,
        ...(best ? { best_failed_attempt_id: best.id } : {}),
        consecutive_failures: hasPass ? 0 : current.consecutive_failures + 1,
        verifier_count: current.verifier_count + 1,
        status: hasPass ? "completed" : "running",
        ...(firstPass ? { finished_at: now(), terminal_reason: "verifier_passed" } : {}),
        updated_at: now(),
      };
    });
  }

  private assertVerifierConsistency(task: TaskManifest, verification: ReturnType<typeof verificationResultSchema.parse>) {
    const expected = new Set(task.checklist?.requirements.map((item) => item.id));
    const actual = new Set(verification.requirements.map((item) => item.requirement_id));
    if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) throw new Error("verifier_requirement_mismatch");
    if (verification.status === "PASS" && verification.requirements.some((item) => item.verdict !== "PASS")) {
      throw new Error("verifier_inconsistent_pass");
    }
  }

  private assertAllowedInput(task: TaskManifest, run: RunSnapshot, input: GenerationInput) {
    const allowed = new Set([
      task.source_artifact_id,
      ...task.references.map((reference) => reference.artifact_id),
      ...run.attempts.map((attempt) => attempt.generated_artifact_id),
    ]);
    if (!allowed.has(input.base_artifact_id)) throw new Error("generation_base_not_allowed");
    if (input.reference_artifact_ids.some((id) => !allowed.has(id))) throw new Error("generation_reference_not_allowed");
  }

  private async createRoundContext(task: TaskManifest, run: RunSnapshot): Promise<AgentRoundContext> {
    const pool = [
      { artifactId: task.source_artifact_id, path: (await this.artifacts.get(task.source_artifact_id)).path, kind: "source" as const },
      ...await Promise.all(task.references.map(async (reference) => ({
        artifactId: reference.artifact_id,
        path: (await this.artifacts.get(reference.artifact_id)).path,
        ...(reference.caption ? { caption: reference.caption } : {}),
        kind: "reference" as const,
      }))),
      ...await Promise.all(run.attempts.map(async (attempt) => ({
        artifactId: attempt.generated_artifact_id,
        path: (await this.artifacts.get(attempt.generated_artifact_id)).path,
        caption: `Attempt ${attempt.round}: ${attempt.status}`,
        kind: "candidate" as const,
      }))),
    ];
    return {
      task,
      checklist: task.checklist!,
      run,
      imagePool: pool,
      recentAttempts: run.attempts.slice(-5),
      ...(run.pending_supervisor_redirect ? { supervisorRedirect: run.pending_supervisor_redirect } : {}),
    };
  }

  private terminalStatus(run: RunSnapshot): { status: "stopped" | "budget_exhausted"; reason: string } | undefined {
    if (this.stopRequests.has(run.id) || run.status === "stop_requested") return { status: "stopped", reason: "user_stopped" };
    if (run.generation_count >= run.config.max_generations) return { status: "budget_exhausted", reason: "generation_budget_exhausted" };
    if (run.started_at && Date.now() - Date.parse(run.started_at) >= run.config.max_wall_time_ms) {
      return { status: "budget_exhausted", reason: "wall_time_budget_exhausted" };
    }
    return undefined;
  }

  private finish(run: RunSnapshot, status: RunSnapshot["status"], reason: string) {
    this.stopRequests.delete(run.id);
    return this.store.commitRun(run.id, `run.${status}`, { reason }, () => ({
      ...run,
      status,
      finished_at: now(),
      terminal_reason: reason,
      updated_at: now(),
    }));
  }
}

const withoutTerminalFields = (run: RunSnapshot) => {
  const { finished_at: _finishedAt, terminal_reason: _terminalReason, ...rest } = run;
  return rest;
};

class RoundToolSession implements AgentToolbox {
  private prompt: string;
  selectedInput: GenerationInput;
  submission?: Submission;
  parentAttemptId: string | undefined;
  generatedThisRound = 0;
  private readonly generatedArtifactIds = new Set<string>();
  lastUsage: CandidateAttempt["generation_usage"] | undefined;

  constructor(
    private readonly runner: AvoRunner,
    private readonly task: TaskManifest,
    private run: RunSnapshot,
  ) {
    this.prompt = run.prompt || task.request;
    this.selectedInput = run.selected_input ?? {
      base_artifact_id: task.source_artifact_id,
      reference_artifact_ids: task.references.map((reference) => reference.artifact_id),
    };
    this.parentAttemptId = run.best_failed_attempt_id;
  }

  getPrompt() { return this.prompt; }
  getRunSnapshot() { return this.run; }
  setPrompt(prompt: string) { if (!prompt.trim()) throw new Error("prompt_required"); this.prompt = prompt; }
  appendPrompt(fragment: string) { this.setPrompt(`${this.prompt}${fragment}`); }
  replacePrompt(oldText: string, newText: string) {
    if (!this.prompt.includes(oldText)) throw new Error("prompt_fragment_not_found");
    this.setPrompt(this.prompt.replace(oldText, newText));
  }
  deletePromptFragment(fragment: string) { this.replacePrompt(fragment, ""); }
  selectGenerationInputs(input: GenerationInput) { this.selectedInput = input; }

  async generateImage() {
    if (this.generatedThisRound >= this.run.config.max_generations_per_round) throw new Error("round_generation_budget_exhausted");
    this.generatedThisRound += 1;
    const generated = await this.runner.generateDraft(this.task, this.run, this.prompt, this.selectedInput);
    this.run = generated.run;
    this.lastUsage = generated.usage;
    this.generatedArtifactIds.add(generated.artifactId);
    return generated.artifactId;
  }

  async restoreAttempt(attemptId: string) {
    const attempt = this.run.attempts.find((item) => item.id === attemptId);
    if (!attempt) throw new Error("attempt_not_found");
    this.prompt = attempt.prompt;
    this.selectedInput = {
      base_artifact_id: attempt.generated_artifact_id,
      reference_artifact_ids: attempt.generation_input.reference_artifact_ids,
    };
    this.parentAttemptId = attempt.id;
  }

  async updateWorkingMemory(memory: WorkingMemory) {
    const parsed = workingMemorySchema.parse(memory);
    this.run = await this.runner.store.commitRun(this.run.id, "working_memory.updated", {}, (current) => {
      if (!current) throw new Error("run_not_found");
      return { ...current, working_memory: parsed, updated_at: now() };
    });
  }

  submitCandidate(artifactId: string, summary: AgentSummary) {
    if (!this.generatedArtifactIds.has(artifactId)) throw new Error("candidate_must_be_generated_this_round");
    this.submission = { artifactId, summary };
  }
}
