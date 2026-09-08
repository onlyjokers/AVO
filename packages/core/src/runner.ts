import {
  agentSummarySchema,
  comparativeVerifierDecisionSchema,
  evaluationFrameRevisionSchema,
  hypothesisSchema,
  lineageReviewSchema,
  parentSelectionSchema,
  promptRevisionSchema,
  runConfigSchema,
  runSnapshotSchema,
  searchArchiveEntrySchema,
  variationAttemptRecordSchema,
  variationStepRecordSchema,
  verificationResultSchema,
  workingMemorySchema,
  type AgentSummary,
  type CandidateAttempt,
  type CandidateDraft,
  type ComparativeVerifierDecision,
  type DraftEvaluation,
  type EvaluationFrameRevision,
  type FinalVerifierDecision,
  type GenerationInput,
  type Hypothesis,
  type LineageNode,
  type ParentSelection,
  type PendingFinalization,
  type PromptRevision,
  type QualityDebtVector,
  type RunConfig,
  type RunSnapshot,
  type StepDeadline,
  type SupervisorDecision,
  type TaskManifest,
  type VariationAttemptRecord,
  type VariationStepRecord,
  type VerificationResult,
  type WorkingMemory,
} from "@avo/contracts";
import { DeterministicImageValidators, type QualityEvaluation } from "@avo/validators";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { ArtifactStore } from "./artifacts.ts";
import { createId } from "./ids.ts";
import type {
  AgentProvider,
  AgentRoundContext,
  AgentStepAbandonment,
  AgentSubmission,
  AgentToolbox,
  ImageProvider,
  SupervisorAdvice,
  VerifierEvidence,
  VerifierProvider,
  VerifierToolName,
} from "./providers.ts";
import { FileStateStore } from "./store.ts";
import { assertReferenceUsage, assertTrialClaim } from "./trial-evidence.ts";

const now = () => new Date().toISOString();
const CURRENT_EVALUATOR_REVISION = "visual-quality-v2";
const CURRENT_DECISION_POLICY_REVISION = "image-avo-v6-contextual-review";

export type SealedEvaluationInputs = {
  revision: string;
  references: Array<{ path: string; caption?: string }>;
  hiddenTargetPath?: string;
  privateRubric?: string;
};

export interface SealedEvaluationResolver {
  getForTask(taskId: string): Promise<SealedEvaluationInputs | undefined>;
}

type Submission = AgentSubmission;
type StepAbandonment = AgentStepAbandonment;

export class AvoRunner {
  private readonly activeRuns = new Map<string, Promise<RunSnapshot>>();
  private readonly activeSessions = new Map<string, VariationToolSession>();
  private readonly stopRequests = new Set<string>();

  constructor(
    readonly store: FileStateStore,
    readonly artifacts: ArtifactStore,
    readonly agent: AgentProvider,
    readonly images: ImageProvider,
    readonly verifier: VerifierProvider,
    readonly sealed?: SealedEvaluationResolver,
    readonly validators = new DeterministicImageValidators(),
  ) {}

  async createRun(taskId: string, configInput: Partial<RunConfig> & Pick<RunConfig, "mode">) {
    const task = await this.store.getTask(taskId);
    const sealed = await this.sealed?.getForTask(taskId);
    const config = runConfigSchema.parse(configInput);
    const createdAt = now();
    const runId = createId("run");
    const seedNode: LineageNode = {
      id: createId("node"),
      run_id: runId,
      kind: "seed",
      artifact_id: task.source_artifact_id,
      ancestry_depth: 0,
      pareto_active: false,
      version: 0,
      committed_at: createdAt,
    };
    const snapshot = runSnapshotSchema.parse({
      schema_version: 4,
      id: runId,
      task_id: task.id,
      config,
      status: "queued",
      prompt: "",
      current_prompt: "",
      prompt_revisions: [],
      selected_reference_artifact_ids: [],
      active_round: 1,
      active_variation_step: 1,
      drafts: [],
      evaluations: [],
      recovery_warnings: [],
      attempts: [],
      lineage_attempt_ids: [],
      lineage_nodes: [seedNode],
      pareto_node_ids: [],
      human_intent_revision: `${task.id}:${sealed?.revision ?? "public"}`,
      active_evolution_version: 0,
      active_variation_attempt: 1,
      evaluation_frame_revisions: [],
      variation_attempts: [],
      comparative_decisions: [],
      search_archive: [],
      incumbent_node_id: seedNode.id,
      final_verifier_decisions: [],
      working_memory: workingMemorySchema.parse({}),
      memory_revisions: [],
      hypotheses: [],
      supervisor_decisions: [],
      supervisor_failures: [],
      deferred_supervisor_triggers: [],
      variation_steps: [],
      memory_pending: false,
      validator_trends: [],
      consecutive_failures: 0,
      generation_count: 0,
      verifier_count: 0,
      tool_call_count: 0,
      agent_total_tokens: 0,
      context_compactions: 0,
      decision_policy_revision: CURRENT_DECISION_POLICY_REVISION,
      mixed_policy_revision: false,
      legacy_read_only: false,
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
    this.activeSessions.get(runId)?.signalStop();
    return this.store.commitRun(runId, "run.stop_requested", {}, (current) => {
      if (!current) throw new Error("run_not_found");
      if (["completed", "failed", "stopped", "budget_exhausted", "finalization_pending"].includes(current.status)) return current;
      return { ...current, status: "stop_requested", updated_at: now() };
    });
  }

  async resume(runId: string) {
    let run = await this.store.getRun(runId);
    if (run.legacy_read_only) throw new Error("legacy_run_read_only_clone_required");
    if (!["stopped", "interrupted", "failed", "finalization_pending"].includes(run.status)) throw new Error("run_not_resumable");
    const pendingFinalization = run.pending_finalization ?? recoverPendingFinalization(run);
    if (pendingFinalization) {
      this.stopRequests.delete(runId);
      const queued = await this.store.commitRun(runId, "run.finalization_resumed", {
        attempts: pendingFinalization.attempts,
        recovered_from_failed: run.status === "failed" && !run.pending_finalization,
      }, () => ({
        ...withoutTerminalFields(run),
        status: "queued",
        pending_finalization: pendingFinalization,
        updated_at: now(),
      }));
      void this.start(runId);
      return queued;
    }
    const upgradeEvaluationPolicy = run.config.evaluator_revision !== CURRENT_EVALUATOR_REVISION;
    const upgradeDecisionPolicy = run.decision_policy_revision !== CURRENT_DECISION_POLICY_REVISION;
    if (upgradeEvaluationPolicy || upgradeDecisionPolicy) {
      const benchmarks = await this.store.listBenchmarks();
      if (benchmarks.some((benchmark) => benchmark.run_ids.includes(runId))) {
        throw new Error("benchmark_run_evaluator_revision_locked");
      }
    }
    const latestFinishedStep = [...run.variation_attempts]
      .filter((attempt) => attempt.status !== "running")
      .sort((left, right) => right.attempt - left.attempt)[0];
    const pendingDrafts = latestFinishedStep
      ? run.drafts.filter((draft) => draft.round === latestFinishedStep.attempt && draft.viewed_at
        && run.evaluations.some((evaluation) => evaluation.draft_id === draft.id))
      : [];
    const shouldRecoverDecision = !run.pending_decision
      && Boolean(latestFinishedStep)
      && /timeout|runtime_cutoff/i.test(latestFinishedStep?.terminal_reason ?? run.terminal_reason ?? "")
      && pendingDrafts.length > 0;
    if (upgradeEvaluationPolicy || upgradeDecisionPolicy || shouldRecoverDecision) {
      run = await this.store.commitRun(runId, "run.policy_upgraded", {
        from_evaluator_revision: run.config.evaluator_revision,
        to_evaluator_revision: upgradeEvaluationPolicy ? CURRENT_EVALUATOR_REVISION : run.config.evaluator_revision,
        from_decision_policy_revision: run.decision_policy_revision,
        to_decision_policy_revision: CURRENT_DECISION_POLICY_REVISION,
        pending_decision_recovered: shouldRecoverDecision,
      }, (current) => {
        if (!current) throw new Error("run_not_found");
        return {
          ...current,
          config: upgradeEvaluationPolicy
            ? { ...current.config, evaluator_revision: CURRENT_EVALUATOR_REVISION }
            : current.config,
          decision_policy_revision: CURRENT_DECISION_POLICY_REVISION,
          mixed_policy_revision: current.mixed_policy_revision || upgradeEvaluationPolicy || upgradeDecisionPolicy,
          ...(shouldRecoverDecision && latestFinishedStep ? {
            pending_decision: {
              source_step: latestFinishedStep.attempt,
              draft_ids: pendingDrafts.map((draft) => draft.id),
              evaluation_ids: current.evaluations
                .filter((evaluation) => pendingDrafts.some((draft) => draft.id === evaluation.draft_id))
                .map((evaluation) => evaluation.id),
              reason: latestFinishedStep.terminal_reason ?? current.terminal_reason ?? "runtime_cutoff",
              created_at: now(),
            },
          } : {}),
          updated_at: now(),
        };
      });
    }
    this.stopRequests.delete(runId);
    const currentStep = run.variation_attempts.find((attempt) => attempt.attempt === run.active_variation_attempt);
    const nextStep = currentStep && currentStep.status !== "running" ? run.active_variation_attempt + 1 : run.active_variation_attempt;
    const queued = await this.store.commitRun(runId, "run.resumed", {}, () => ({
      ...withoutTerminalFields(run),
      status: "queued",
      active_round: Math.max(run.active_round, nextStep),
      active_variation_step: nextStep,
      active_variation_attempt: nextStep,
      updated_at: now(),
    }));
    void this.start(runId);
    return queued;
  }

  isActive(runId: string) {
    return this.activeRuns.has(runId);
  }

  async planLegacyRecovery(runId: string) {
    const [run, events] = await Promise.all([this.store.getRun(runId), this.store.listRunEvents(runId)]);
    const generationEvents = events.filter((event) => event.type === "generation.completed" || event.type === "draft.generated");
    return {
      run_id: run.id,
      already_repaired: run.drafts.length > 0,
      generation_count: generationEvents.length,
      generated_artifact_ids: generationEvents.flatMap((event) => artifactIdsInEvent(event.data)),
      submit_sequence: events.findLast((event) => event.type === "candidate.submitted")?.sequence ?? null,
      submitted_artifact_id: run.drafts.find((draft) => draft.id === run.submitted_draft_id)?.artifact_id ?? null,
      recovery_possible: false,
      warnings: ["legacy_run_read_only_clone_required"],
    };
  }

  async repairLegacyRun(runId: string) {
    const run = await this.store.getRun(runId);
    return { run, plan: await this.planLegacyRecovery(runId) };
  }

  async resumeRecoveredVerification() {
    throw new Error("legacy_run_read_only_clone_required");
  }

  private async execute(runId: string): Promise<RunSnapshot> {
    let run = await this.store.getRun(runId);
    if (run.legacy_read_only) throw new Error("legacy_run_read_only_clone_required");
    if (run.pending_finalization) {
      const pending = run.pending_finalization;
      run = await this.store.commitRun(runId, "run.finalization_started", {
        attempt: pending.attempts + 1,
      }, (current) => {
        if (!current) throw new Error("run_not_found");
        return { ...current, status: "running", updated_at: now() };
      });
      return this.finish(run, pending.requested_status, pending.terminal_reason, {
        ...(pending.supervisor_decision_id ? { supervisorDecisionId: pending.supervisor_decision_id } : {}),
      });
    }
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
        if (terminal) return await this.finish(run, terminal.status, terminal.reason, terminal);
        run = await this.ensureVariationAttemptStarted(task, run);
        const session = new VariationToolSession(this, task, run);
        this.activeSessions.set(runId, session);
        if (this.stopRequests.has(runId)) session.signalStop();
        let agentError: Error | undefined;
        try {
          await this.agent.runRound(await this.createRoundContext(task, run), session);
        } catch (error) {
          agentError = error as Error;
        } finally {
          if (this.activeSessions.get(runId) === session) this.activeSessions.delete(runId);
        }
        const submission = session.submission;
        if (!submission) {
          if (!session.abandonment) {
            const reason = agentError?.message || "agent_did_not_submit_candidate";
            await session.abandonStep(reason, systemStepSummary(reason), undefined, "failed");
          }
          if (session.abandonment?.status === "failed") throw agentError ?? new Error(session.abandonment.reason);
          if (run.config.mode === "one_shot") throw agentError ?? new Error("agent_abandoned_one_shot");
          run = await this.store.getRun(runId);
          const terminalAfterAbandonment = this.terminalStatus(run);
          if (terminalAfterAbandonment) {
            return this.finish(run, terminalAfterAbandonment.status, terminalAfterAbandonment.reason, terminalAfterAbandonment);
          }
          if (run.config.supervisor_enabled) {
            const triggers = detectStepBoundaryTriggers(run);
            if (triggers.length > 0) run = await this.maybeRunSupervisor(task, run, triggers, "step_boundary");
          }
          continue;
        }
        run = await this.finalizeSubmission(task, await this.store.getRun(runId), submission);
        if (run.config.mode === "one_shot") return this.finish(run, "completed", "one_shot_finished");
        const terminalAfterSubmission = this.terminalStatus(run);
        if (terminalAfterSubmission) {
          return this.finish(run, terminalAfterSubmission.status, terminalAfterSubmission.reason, terminalAfterSubmission);
        }
        if (run.config.supervisor_enabled) {
          const triggers = detectStepBoundaryTriggers(run);
          if (triggers.length > 0) run = await this.maybeRunSupervisor(task, run, triggers, "step_boundary");
        }
      }
    } catch (error) {
      const current = await this.store.getRun(runId);
      if (this.stopRequests.has(runId)) return this.finish(current, "stopped", "user_stopped");
      return this.finish(current, "failed", (error as Error).message || "run_failed");
    }
  }

  private async executeBestOf(task: TaskManifest, initialRun: RunSnapshot) {
    let run = await this.ensureVariationAttemptStarted(task, initialRun);
    const variants = await this.agent.planBestOf(await this.createRoundContext(task, run), run.config.max_generations);
    if (variants.length !== run.config.max_generations) throw new Error("best_of_variant_count_mismatch");
    const generated: Array<{ draftId: string; summary: AgentSummary }> = [];
    for (const variant of variants) {
      run = await this.store.getRun(run.id);
      const terminal = this.terminalStatus(run);
      if (terminal) return this.finish(run, terminal.status, terminal.reason, terminal);
      const session = new VariationToolSession(this, task, run, true);
      await session.setPrompt(variant.prompt);
      await session.selectGenerationInputs(variant.input);
      const artifactId = await session.generateImage();
      await session.viewImage(artifactId);
      const draft = session.getRunSnapshot().drafts.findLast((item) => item.artifact_id === artifactId)!;
      generated.push({ draftId: draft.id, summary: variant.summary });
    }
    for (const candidate of generated) {
      run = await this.store.getRun(run.id);
      run = await this.ensureVariationAttemptStarted(task, run);
      const evaluation = await this.evaluateDraft(task, run, candidate.draftId);
      if (!evaluation.comparative_decision_id) throw new Error("comparative_decision_required");
      run = await this.store.getRun(run.id);
      const decision = run.comparative_decisions.find((item) => item.id === evaluation.comparative_decision_id)!;
      if (decision.recommendation === "commit") {
        run = await this.persistSubmission(run, candidate.draftId, evaluation.id, decision.id, candidate.summary, run.active_variation_attempt);
        run = await this.finalizeSubmission(task, run, {
          draftId: candidate.draftId,
          artifactId: run.drafts.find((draft) => draft.id === candidate.draftId)!.artifact_id,
          evaluationId: evaluation.id,
          decisionId: decision.id,
          summary: candidate.summary,
          decisionStep: run.active_variation_attempt,
        });
      } else {
        run = await this.completeVariationStep(run, {
          step: run.active_variation_attempt,
          status: "abandoned",
          summary: candidate.summary,
          terminalReason: `verifier_${decision.preference}`,
        });
      }
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

  async generateDraft(task: TaskManifest, run: RunSnapshot, prompt: PromptRevision, parent: ParentSelection, references: string[], referenceUsage?: GenerationInput["reference_usage"]) {
    run = await this.store.getRun(run.id);
    if (run.generation_count >= run.config.max_generations) throw new Error("generation_budget_exhausted");
    if (run.drafts.filter((draft) => draft.round === run.active_variation_attempt).length >= run.config.max_generations_per_round) {
      throw new Error("variation_attempt_generation_budget_exhausted");
    }
    if (prompt.origin !== "agent") throw new Error("agent_generation_prompt_required");
    const input: GenerationInput = { base_artifact_id: parent.artifact_id, reference_artifact_ids: references,
      ...(referenceUsage ? { reference_usage: referenceUsage } : {}) };
    assertReferenceUsage(input);
    this.assertAllowedInput(task, run, input);
    const base = await this.artifacts.get(input.base_artifact_id);
    const source = await this.artifacts.get(task.source_artifact_id);
    const referenceArtifacts = await Promise.all(references.map((id) => this.artifacts.get(id)));
    const draftId = createId("draft");
    let result: Awaited<ReturnType<ImageProvider["generate"]>>;
    try {
      result = await this.images.generate({
        prompt: prompt.value,
        base: { path: base.path, mimeType: base.artifact.mime_type },
        references: referenceArtifacts.map((item) => ({ path: item.path, mimeType: item.artifact.mime_type })),
        idempotencyKey: `${run.id}:${draftId}`,
      });
    } catch (error) {
      const message = (error as Error).message || "image_provider_failed";
      const providerAttempts = (error as { providerAttempts?: unknown }).providerAttempts;
      if (!message.startsWith("image_provider_ambiguous:")) throw error;
      await this.store.commitRun(run.id, "generation.ambiguous", {
        draft_id: draftId,
        error: message,
        ...(Array.isArray(providerAttempts) ? { provider_attempts: providerAttempts } : {}),
      }, (current) => {
        if (!current) throw new Error("run_not_found");
        return { ...current, generation_count: current.generation_count + 1, updated_at: now() };
      });
      throw error;
    }
    const rawArtifact = await this.artifacts.put({ bytes: result.bytes, mimeType: result.mimeType, originalName: result.originalName });
    const [sourceDimensions, providerDimensions] = await Promise.all([
      readImageDimensions(source.bytes),
      readImageDimensions(result.bytes),
    ]);
    const createdAt = now();
    const draft: CandidateDraft = {
      id: draftId,
      round: run.active_variation_attempt,
      origin_step: run.active_variation_attempt,
      status: "generated",
      raw_artifact_id: rawArtifact.id,
      artifact_id: rawArtifact.id,
      parent_artifact_id: parent.artifact_id,
      prompt: prompt.value,
      generation_input: input,
      dimensions: { source: sourceDimensions, provider: providerDimensions, final: providerDimensions, normalized: false },
      ...(result.providerRequestId ? { provider_request_id: result.providerRequestId } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
      latency_ms: result.latencyMs,
      created_at: createdAt,
    };
    const updated = await this.store.commitRun(run.id, "draft.generated", {
      draft,
      prompt_revision: prompt.revision,
      parent_selection: parent,
      ...(result.providerAttempts ? { provider_attempts: result.providerAttempts } : {}),
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        prompt: prompt.value,
        current_prompt: prompt.value,
        generation_prompt: prompt,
        parent_selection: parent,
        selected_reference_artifact_ids: references,
        selected_input: input,
        selected_generation_input: input,
        drafts: [...current.drafts, draft],
        variation_attempts: current.variation_attempts.map((attempt) => attempt.attempt === current.active_variation_attempt
          ? variationAttemptRecordSchema.parse({ ...attempt, draft_ids: [...new Set([...attempt.draft_ids, draft.id])] })
          : attempt),
        generation_count: current.generation_count + 1,
        updated_at: now(),
      };
    });
    return { draft, artifactId: draft.artifact_id, usage: result.usage, run: updated };
  }

  async evaluateDraft(task: TaskManifest, run: RunSnapshot, draftId: string): Promise<DraftEvaluation> {
    run = await this.store.getRun(run.id);
    const draft = run.drafts.find((item) => item.id === draftId);
    if (!draft) throw new Error("draft_not_found");
    if (!draft.viewed_at && run.config.mode === "avo") throw new Error("draft_must_be_viewed_before_evaluation");
    const sealed = await this.sealed?.getForTask(task.id);
    const frame = run.evaluation_frame_revisions.find((item) => item.attempt === run.active_variation_attempt);
    if (!frame) throw new Error("evaluation_frame_required");
    const incumbentNode = run.lineage_nodes.find((node) => node.id === run.incumbent_node_id);
    if (!incumbentNode) throw new Error("incumbent_node_not_found");
    const cacheKey = `${draft.artifact_id}:${incumbentNode.artifact_id}:${frame.id}:${run.config.evaluator_revision}:${sealed?.revision ?? "public"}`;
    const cached = run.evaluations.find((evaluation) => evaluation.cache_key === cacheKey);
    if (cached) return cached;
    const [source, parent, incumbent, candidate] = await Promise.all([
      this.artifacts.get(task.source_artifact_id),
      this.artifacts.get(draft.parent_artifact_id),
      this.artifacts.get(incumbentNode.artifact_id),
      this.artifacts.get(draft.artifact_id),
    ]);
    const references = await Promise.all(task.references.map(async (reference) => ({
      path: (await this.artifacts.get(reference.artifact_id)).path,
      ...(reference.caption ? { caption: reference.caption } : {}),
    })));
    const quality = await this.validators.evaluate({ source: source.bytes, parent: parent.bytes, candidate: candidate.bytes, preservation: task.preservation_contract });
    const targetArtifact = sealed?.hiddenTargetPath ? await readFile(sealed.hiddenTargetPath) : undefined;
    const targetQuality = targetArtifact ? await this.validators.evaluate({
      source: targetArtifact,
      parent: targetArtifact,
      candidate: candidate.bytes,
      preservation: {
        color: "allow_change",
        detail: "allow_change",
        text: "unspecified",
        composition: "allow_change",
        identity: "unspecified",
        edit_scope: "global",
        additional_invariants: [],
      },
    }) : undefined;
    const technicalBlockers = objectiveTechnicalBlockers(quality.source_quality_debt);
    const technicalGate = {
      passed: technicalBlockers.length === 0,
      blockers: technicalBlockers,
      warnings: quality.warnings,
    };
    const evidenceCache = new Map<VerifierToolName, VerifierEvidence>();
    const callTool = async (tool: VerifierToolName) => {
      const existing = evidenceCache.get(tool);
      if (existing) return existing;
      const evidence = verifierEvidenceFor(tool, run, draft, quality, targetQuality);
      evidenceCache.set(tool, evidence);
      return evidence;
    };
    const decision = comparativeVerifierDecisionSchema.parse(await this.verifier.compare({
      runId: run.id,
      draftId: draft.id,
      candidateArtifactId: draft.artifact_id,
      task,
      frame,
      sourcePath: source.path,
      parentPath: parent.path,
      incumbentNode,
      incumbentPath: incumbent.path,
      candidatePath: candidate.path,
      publicReferences: references,
      sealedReferences: sealed?.references ?? [],
      ...(sealed?.hiddenTargetPath ? { hiddenTargetPath: sealed.hiddenTargetPath } : {}),
      ...(sealed?.privateRubric ? { privateInstructions: sealed.privateRubric } : {}),
      history: run.comparative_decisions,
      technicalGate,
      callTool,
    }));
    assertComparativeDecision(frame, draft, incumbentNode, decision);
    const publicVerification = legacyVerificationFromDecision(frame, decision);
    const blockers = [...new Set([
      ...technicalBlockers,
      ...decision.axis_judgments
        .filter((judgment) => frame.axes.some((axis) => axis.id === judgment.axis_id && axis.importance === "blocker")
          && judgment.verdict !== "pass")
        .map((judgment) => `frame:${judgment.axis_id}:${judgment.verdict}`),
    ])];
    const evaluation: DraftEvaluation = {
      id: createId("evaluation"),
      run_id: run.id,
      draft_id: draft.id,
      artifact_id: draft.artifact_id,
      evaluator_revision: run.config.evaluator_revision,
      source_quality_debt: quality.source_quality_debt,
      step_quality_debt: quality.step_quality_debt,
      public_verification: publicVerification,
      validator_elapsed_ms: quality.analysis.elapsed_ms,
      agent_feedback: decision.feedback_for_main_agent,
      semantic_gain: decision.preference === "better" ? 1 : decision.preference === "worse" ? -1 : 0,
      correctness_gate: { passed: blockers.length === 0, blockers, warnings: quality.warnings },
      comparative_decision_id: decision.id,
      evaluation_frame_revision_id: frame.id,
      cache_key: cacheKey,
      created_at: now(),
    };
    const archive = searchArchiveEntrySchema.parse({
      id: `archive-${draft.id}-${decision.id}`,
      draft_id: draft.id,
      evaluation_id: evaluation.id,
      comparative_decision_id: decision.id,
      attempt: run.active_variation_attempt,
      outcome: decision.technical_gate.passed
        ? decision.preference === "equivalent" ? "equivalent"
          : decision.preference === "worse" ? "worse"
            : decision.preference === "uncertain" ? "uncertain"
              : "not_submitted"
        : "gate_blocked",
      created_at: evaluation.created_at,
    });
    await this.store.commitRun(run.id, "draft.evaluated", {
      evaluation_id: evaluation.id,
      comparative_decision_id: decision.id,
      evaluation_frame_revision_id: frame.id,
      preference: decision.preference,
      recommendation: decision.recommendation,
      validator_elapsed_ms: quality.analysis.elapsed_ms,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        evaluations: [...current.evaluations, evaluation],
        comparative_decisions: [...current.comparative_decisions, decision],
        lineage_nodes: decision.incumbent_correctness ? current.lineage_nodes.map((node) => node.id === incumbentNode.id ? {
          ...node,
          current_review: {
            evaluation_frame_revision_id: frame.id,
            correctness: decision.incumbent_correctness!,
            feedback_for_main_agent: decision.feedback_for_main_agent,
            reviewed_at: decision.created_at,
          },
        } : node) : current.lineage_nodes,
        search_archive: [...current.search_archive, archive],
        validator_trends: [...current.validator_trends, summarizeEvaluationTrend(evaluation)],
        verifier_count: current.verifier_count + 1,
        variation_attempts: current.variation_attempts.map((attempt) => attempt.attempt === current.active_variation_attempt
          ? variationAttemptRecordSchema.parse({
              ...attempt,
              evaluation_ids: [...new Set([...attempt.evaluation_ids, evaluation.id])],
              comparative_decision_ids: [...new Set([...attempt.comparative_decision_ids, decision.id])],
            })
          : attempt),
        updated_at: now(),
      };
    });
    return evaluation;
  }

  async persistSubmission(run: RunSnapshot, draftId: string, evaluationId: string, decisionId: string, summary: AgentSummary, decisionStep: number) {
    const draft = run.drafts.find((item) => item.id === draftId);
    const evaluation = run.evaluations.find((item) => item.id === evaluationId);
    const decision = run.comparative_decisions.find((item) => item.id === decisionId);
    if (!draft || !evaluation || !decision || evaluation.artifact_id !== draft.artifact_id
      || decision.draft_id !== draft.id || evaluation.comparative_decision_id !== decision.id) throw new Error("evaluated_draft_required");
    if (decision.recommendation !== "commit" || decision.preference !== "better" || decision.correctness !== "pass"
      || !decision.technical_gate.passed) throw new Error("verifier_commit_recommendation_required");
    const submittedAt = now();
    return this.store.commitRun(run.id, "candidate.submitted", {
      draft_id: draft.id,
      artifact_id: draft.artifact_id,
      evaluation_id: evaluation.id,
      comparative_decision_id: decision.id,
      summary,
      origin_step: draft.origin_step ?? draft.round,
      decision_step: decisionStep,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        submitted_draft_id: draft.id,
        submitted_evaluation_id: evaluation.id,
        drafts: current.drafts.map((item) => item.id === draft.id
          ? { ...item, status: "submitted" as const, submitted_at: submittedAt }
          : item),
        updated_at: submittedAt,
      };
    });
  }

  private async finalizeSubmission(_task: TaskManifest, run: RunSnapshot, submission: Submission) {
    const draft = run.drafts.find((item) => item.id === submission.draftId);
    const evaluation = run.evaluations.find((item) => item.id === submission.evaluationId);
    const decision = run.comparative_decisions.find((item) => item.id === submission.decisionId);
    if (!draft || !evaluation || !decision || evaluation.artifact_id !== draft.artifact_id
      || draft.artifact_id !== submission.artifactId || decision.draft_id !== draft.id
      || evaluation.comparative_decision_id !== decision.id) throw new Error("persisted_evaluated_submission_required");
    const incumbent = run.lineage_nodes.find((node) => node.id === run.incumbent_node_id);
    if (!incumbent || decision.incumbent_node_id !== incumbent.id) throw new Error("submission_incumbent_changed");
    if (decision.recommendation !== "commit" || decision.preference !== "better" || decision.correctness !== "pass"
      || !decision.technical_gate.passed || !evaluation.correctness_gate.passed) {
      throw new Error("verifier_commit_recommendation_required");
    }
    const duplicateCommit = run.lineage_nodes.some((node) => node.artifact_id === draft.artifact_id);
    if (duplicateCommit) throw new Error("duplicate_lineage_commit");
    const attempt: CandidateAttempt = {
      id: createId("attempt"),
      run_id: run.id,
      round: run.attempts.length + 1,
      origin_step: draft.origin_step ?? draft.round,
      decision_step: submission.decisionStep,
      draft_id: draft.id,
      ...parentAttemptForDraft(run, draft),
      prompt: draft.prompt,
      generation_input: draft.generation_input,
      generated_artifact_id: draft.artifact_id,
      ...(draft.usage ? { generation_usage: draft.usage } : {}),
      agent_summary: submission.summary,
      verification: evaluation.public_verification,
      status: "passed",
      commit_outcome: "committed",
      created_at: now(),
    };
    const parentNode = resolveParentNode(run, draft.parent_artifact_id);
    const parentDraft = run.drafts.findLast((item) => item.artifact_id === draft.parent_artifact_id);
    const commitNode: LineageNode = {
      id: createId("node"),
      run_id: run.id,
      kind: "commit",
      artifact_id: draft.artifact_id,
      ...(parentNode || parentDraft ? { parent_node_id: parentNode?.id ?? parentDraft!.id } : {}),
      draft_id: draft.id,
      evaluation_id: evaluation.id,
      ...(run.prompt_revisions.findLast((prompt) => prompt.value === draft.prompt)
        ? { prompt_revision: run.prompt_revisions.findLast((prompt) => prompt.value === draft.prompt)!.revision }
        : {}),
      ancestry_depth: parentDraft ? ancestryDepthForDraft(run, parentDraft) + 1 : (parentNode?.ancestry_depth ?? 0) + 1,
      pareto_active: false,
      version: run.active_evolution_version + 1,
      previous_version_node_id: incumbent.id,
      derived_from_node_id: parentNode?.id ?? parentDraft?.id ?? incumbent.id,
      accepted_evaluation_id: evaluation.id,
      evaluation_frame_revision_id: decision.evaluation_frame_revision_id,
      committed_at: now(),
    };
    const finalized = await this.store.commitRun(run.id, "lineage.committed", {
      attempt_id: attempt.id,
      draft_id: draft.id,
      evaluation_id: evaluation.id,
      comparative_decision_id: decision.id,
      committed: true,
      commit_outcome: "committed",
      version: commitNode.version,
      previous_version_node_id: incumbent.id,
      origin_step: draft.origin_step ?? draft.round,
      decision_step: submission.decisionStep,
      lineage_node_id: commitNode.id,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        attempts: [...current.attempts, attempt],
        drafts: current.drafts.map((item) => {
          if (item.id === draft.id) return { ...item, status: "verified" as const };
          if (item.round === submission.decisionStep && item.status !== "ambiguous" && item.status !== "rejected_preverify") {
            return { ...item, status: "abandoned" as const };
          }
          return item;
        }),
        lineage_attempt_ids: [...current.lineage_attempt_ids, attempt.id],
        lineage_nodes: [...current.lineage_nodes, commitNode],
        pareto_node_ids: [],
        incumbent_node_id: commitNode.id,
        active_evolution_version: commitNode.version ?? current.active_evolution_version + 1,
        search_archive: current.search_archive.filter((item) => item.draft_id !== draft.id),
        best_failed_attempt_id: bestFailure([...current.attempts, attempt])?.id,
        consecutive_failures: 0,
        status: "running",
        updated_at: now(),
      };
    });
    return this.completeVariationStep(finalized, {
      step: submission.decisionStep,
      status: "submitted",
      summary: submission.summary,
      ...(submission.memoryUpdate ? { memoryUpdate: submission.memoryUpdate } : {}),
      selectedDraftId: draft.id,
      selectedDraftOriginStep: draft.origin_step ?? draft.round,
      lineageNodeId: commitNode.id,
    });
  }

  private async ensureVariationAttemptStarted(task: TaskManifest, run: RunSnapshot) {
    const attemptNumber = run.active_variation_attempt;
    const existingAttempt = run.variation_attempts.find((attempt) => attempt.attempt === attemptNumber);
    if (existingAttempt?.status === "running") return run;
    const sealed = await this.sealed?.getForTask(task.id);
    const source = await this.artifacts.get(task.source_artifact_id);
    const publicReferences = await Promise.all(task.references.map(async (reference) => ({
      path: (await this.artifacts.get(reference.artifact_id)).path,
      ...(reference.caption ? { caption: reference.caption } : {}),
    })));
    const previousFrame = run.evaluation_frame_revisions.at(-1);
    const existingFrame = run.evaluation_frame_revisions.find((item) => item.attempt === attemptNumber);
    let frame = existingFrame;
    if (!frame) {
      try {
        frame = evaluationFrameRevisionSchema.parse(await this.verifier.createEvaluationFrame({
          runId: run.id,
          attempt: attemptNumber,
          task,
          sourcePath: source.path,
          publicReferences,
          sealedReferences: sealed?.references ?? [],
          ...(sealed?.hiddenTargetPath ? { hiddenTargetPath: sealed.hiddenTargetPath } : {}),
          ...(sealed?.privateRubric ? { privateInstructions: sealed.privateRubric } : {}),
          ...(previousFrame ? { previousFrame } : {}),
          lineage: run.lineage_nodes,
          archive: run.search_archive,
          recentAttempts: run.variation_attempts,
        }));
      } catch (error) {
        frame = fallbackEvaluationFrame({
          run,
          task,
          attempt: attemptNumber,
          ...(previousFrame ? { previousFrame } : {}),
          publicReferenceCount: publicReferences.length,
          sealedReferenceCount: sealed?.references.length ?? 0,
          hasHiddenTarget: Boolean(sealed?.hiddenTargetPath),
          hasPrivateInstructions: Boolean(sealed?.privateRubric),
          reason: boundedErrorMessage(error),
        });
      }
    }
    if (!existingFrame) {
      const fallback = frame.provenance !== "verifier";
      run = await this.store.commitRun(run.id, fallback ? "evaluation_frame.fallback" : "evaluation_frame.created", {
        evaluation_frame_revision_id: frame.id,
        attempt: attemptNumber,
        revision: frame.revision,
        provenance: frame.provenance,
        ...(frame.fallback_reason ? { reason: frame.fallback_reason } : {}),
        ...(fallback && frame.supersedes_id ? { source_frame_id: frame.supersedes_id } : {}),
      }, (current) => {
        if (!current) throw new Error("run_not_found");
        return {
          ...current,
          evaluation_frame_revisions: [...current.evaluation_frame_revisions, frame],
          updated_at: now(),
        };
      });
    }
    if (run.incumbent_node_id && this.verifier.reviewLineage
      && (JSON.stringify(previousFrame?.axes) !== JSON.stringify(frame.axes)
        || JSON.stringify(previousFrame?.target_interpretation) !== JSON.stringify(frame.target_interpretation))) {
      run = await this.reviewHistoricalNodes(task, run, [run.incumbent_node_id]);
    }
    const record = variationStepRecordSchema.parse({
      id: `variation-step-${attemptNumber}`,
      step: attemptNumber,
      status: "running",
      reference_artifact_ids: [],
      prompt_revision_ids: [],
      draft_ids: [],
      evaluation_ids: [],
      summary: systemStepSummary("variation_attempt_running"),
      memory_pending: false,
      ...(run.pending_supervisor_decision ? { supervisor_decision_id: run.pending_supervisor_decision.id } : {}),
      usage_delta: {},
      started_at: now(),
    });
    const variationAttempt = variationAttemptRecordSchema.parse({
      id: `variation-attempt-${attemptNumber}`,
      attempt: attemptNumber,
      target_version: run.active_evolution_version + 1,
      status: "running",
      evaluation_frame_revision_id: frame.id,
      reference_artifact_ids: [],
      prompt_revision_ids: [],
      draft_ids: [],
      evaluation_ids: [],
      comparative_decision_ids: [],
      summary: systemStepSummary("variation_attempt_running"),
      memory_pending: false,
      usage_delta: {},
      started_at: record.started_at,
    });
    return this.store.commitRun(run.id, "variation_attempt.started", { record: variationAttempt }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        active_variation_step: attemptNumber,
        variation_steps: [...current.variation_steps.filter((step) => step.step !== record.step), record],
        variation_attempts: [...current.variation_attempts.filter((item) => item.attempt !== attemptNumber), variationAttempt],
        updated_at: now(),
      };
    });
  }

  async completeVariationStep(run: RunSnapshot, input: {
    step: number;
    status: Exclude<VariationStepRecord["status"], "running">;
    summary: AgentSummary;
    memoryUpdate?: WorkingMemory;
    selectedDraftId?: string;
    selectedDraftOriginStep?: number;
    lineageNodeId?: string;
    terminalReason?: string;
  }) {
    const completedAt = now();
    return this.store.commitRun(run.id, "variation_attempt.recorded", {
      variation_attempt: input.step,
      status: input.status,
      terminal_reason: input.terminalReason,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      const existing = current.variation_steps.find((step) => step.step === input.step);
      const existingAttempt = current.variation_attempts.find((attempt) => attempt.attempt === input.step);
      const memory = memoryUpdateForStep(current, input.memoryUpdate, existing?.started_at ?? completedAt);
      const draftIds = current.drafts.filter((draft) => draft.round === input.step).map((draft) => draft.id);
      const draftIdSet = new Set(draftIds);
      const evaluatedDraftIds = current.evaluations
        .filter((evaluation) => draftIdSet.has(evaluation.draft_id))
        .map((evaluation) => evaluation.draft_id);
      const latestStepSupervisor = current.supervisor_decisions.findLast((decision) => decision.variation_step === input.step);
      const record = variationStepRecordSchema.parse({
        ...(existing ?? {
          id: `variation-step-${input.step}`,
          step: input.step,
          status: "running",
          summary: systemStepSummary("variation_attempt_recovered"),
          usage_delta: {},
          started_at: completedAt,
        }),
        status: input.status,
        parent_selection: current.parent_selection ?? existing?.parent_selection,
        reference_artifact_ids: current.selected_reference_artifact_ids.length
          ? current.selected_reference_artifact_ids
          : existing?.reference_artifact_ids ?? [],
        prompt_revision_ids: current.prompt_revisions
          .filter((prompt) => prompt.created_at >= (existing?.started_at ?? completedAt))
          .map((prompt) => `prompt-${prompt.revision}`),
        draft_ids: draftIds,
        evaluation_ids: current.evaluations.filter((evaluation) => draftIdSet.has(evaluation.draft_id)).map((evaluation) => evaluation.id),
        ...(input.selectedDraftId ? { selected_draft_id: input.selectedDraftId } : {}),
        ...(input.selectedDraftOriginStep ? { selected_draft_origin_step: input.selectedDraftOriginStep } : {}),
        ...(input.lineageNodeId ? { lineage_node_id: input.lineageNodeId } : {}),
        summary: input.summary,
        ...(memory.revision ? { memory_revision_id: memory.revision.id } : existing?.memory_revision_id ? { memory_revision_id: existing.memory_revision_id } : {}),
        memory_pending: !memory.revision && !memory.updatedDuringStep,
        ...(latestStepSupervisor ? { supervisor_decision_id: latestStepSupervisor.id } : {}),
        finished_at: completedAt,
        ...(input.terminalReason ? { terminal_reason: input.terminalReason } : {}),
      });
      const comparativeDecisionIds = current.comparative_decisions
        .filter((decision) => draftIdSet.has(decision.draft_id))
        .map((decision) => decision.id);
      const attemptRecord = variationAttemptRecordSchema.parse({
        ...(existingAttempt ?? {
          id: `variation-attempt-${input.step}`,
          attempt: input.step,
          target_version: current.active_evolution_version + 1,
          evaluation_frame_revision_id: current.evaluation_frame_revisions.find((frame) => frame.attempt === input.step)?.id,
          started_at: completedAt,
          usage_delta: {},
        }),
        status: input.status,
        parent_selection: current.parent_selection ?? existingAttempt?.parent_selection,
        reference_artifact_ids: current.selected_reference_artifact_ids.length
          ? current.selected_reference_artifact_ids
          : existingAttempt?.reference_artifact_ids ?? [],
        prompt_revision_ids: record.prompt_revision_ids,
        draft_ids: draftIds,
        evaluation_ids: record.evaluation_ids,
        comparative_decision_ids: comparativeDecisionIds,
        ...(input.selectedDraftId ? { selected_draft_id: input.selectedDraftId } : {}),
        ...(input.lineageNodeId ? { committed_lineage_node_id: input.lineageNodeId } : {}),
        summary: input.summary,
        ...(record.memory_revision_id ? { memory_revision_id: record.memory_revision_id } : {}),
        memory_pending: record.memory_pending,
        ...(latestStepSupervisor ? { supervisor_decision_id: latestStepSupervisor.id } : {}),
        finished_at: completedAt,
        ...(input.terminalReason ? { terminal_reason: input.terminalReason } : {}),
      });
      return {
        ...current,
        drafts: current.drafts.map((draft) => {
          if (draft.round !== input.step || input.status === "submitted"
            || draft.status === "ambiguous" || draft.status === "rejected_preverify") return draft;
          if (input.status === "runtime_cutoff" && evaluatedDraftIds.includes(draft.id)) {
            return { ...draft, status: "carried_forward" as const };
          }
          return { ...draft, status: "abandoned" as const };
        }),
        working_memory: memory.value,
        memory_revisions: memory.revision ? [...current.memory_revisions, memory.revision] : current.memory_revisions,
        memory_pending: record.memory_pending,
        variation_steps: current.variation_steps.some((step) => step.step === input.step)
          ? current.variation_steps.map((step) => step.step === input.step ? record : step)
          : [...current.variation_steps, record],
        variation_attempts: current.variation_attempts.some((attempt) => attempt.attempt === input.step)
          ? current.variation_attempts.map((attempt) => attempt.attempt === input.step ? attemptRecord : attempt)
          : [...current.variation_attempts, attemptRecord],
        pending_decision: input.status === "runtime_cutoff" && evaluatedDraftIds.length > 0
          ? {
              source_step: input.step,
              draft_ids: [...new Set(evaluatedDraftIds)],
              evaluation_ids: current.evaluations
                .filter((evaluation) => evaluatedDraftIds.includes(evaluation.draft_id))
                .map((evaluation) => evaluation.id),
              reason: input.terminalReason ?? "runtime_cutoff",
              created_at: completedAt,
            }
          : undefined,
        step_deadline: undefined,
        active_round: Math.max(current.active_round, input.step + 1),
        active_variation_step: Math.max(current.active_variation_step, input.step + 1),
        active_variation_attempt: Math.max(current.active_variation_attempt, input.step + 1),
        consecutive_failures: input.status === "submitted" ? current.consecutive_failures : current.consecutive_failures + 1,
        prompt: "",
        current_prompt: "",
        generation_prompt: undefined,
        parent_selection: undefined,
        selected_input: undefined,
        selected_generation_input: undefined,
        selected_reference_artifact_ids: [],
        submitted_draft_id: undefined,
        submitted_evaluation_id: undefined,
        pending_supervisor_decision: undefined,
        pending_supervisor_redirect: undefined,
        updated_at: completedAt,
      };
    });
  }

  async maybeRunSupervisor(
    task: TaskManifest,
    run: RunSnapshot,
    triggers: string[],
    scope: "in_step" | "step_boundary",
  ) {
    if (triggers.length === 0) return run;
    const triggerFingerprint = [...new Set(triggers)].sort().join("|");
    const alreadyHandled = run.supervisor_decisions.some((decision) => decision.variation_step === run.active_variation_attempt
      && decision.scope === scope && decision.trigger_fingerprint === triggerFingerprint)
      || run.supervisor_failures.some((failure) => failure.variation_step === run.active_variation_attempt
        && failure.scope === scope && failure.trigger_fingerprint === triggerFingerprint);
    if (alreadyHandled) return run;
    const remainingMs = run.step_deadline ? Date.parse(run.step_deadline.hard_deadline_at) - Date.now() : Number.POSITIVE_INFINITY;
    if (scope === "in_step" && remainingMs < 120_000) {
      return this.store.commitRun(run.id, "supervisor.deferred", { triggers, trigger_fingerprint: triggerFingerprint }, (current) => {
        if (!current) throw new Error("run_not_found");
        return {
          ...current,
          deferred_supervisor_triggers: [...new Set([...current.deferred_supervisor_triggers, ...triggers])],
          updated_at: now(),
        };
      });
    }
    const started = Date.now();
    let advice: SupervisorAdvice | undefined;
    let lastError: unknown;
    let attempts = 0;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      attempts = attempt;
      try {
        advice = await this.agent.supervise(await this.createRoundContext(task, run), { triggers, scope });
        assertValidSupervisorAdvice(run, advice, triggers, scope);
        break;
      } catch (error) {
        advice = undefined;
        lastError = error;
        if (attempt === 2 || !isRetryableSupervisorError(error)) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    if (!advice) {
      const failure = supervisorFailure(lastError, run, triggers, attempts, Date.now() - started, scope, triggerFingerprint);
      return this.store.commitRun(run.id, "supervisor.failed", { failure }, (current) => {
        if (!current) throw new Error("run_not_found");
        return { ...current, supervisor_failures: [...current.supervisor_failures, failure], updated_at: now() };
      });
    }
    const decision = supervisorDecision(advice, triggers, run.active_variation_attempt, scope, triggerFingerprint);
    run = await this.store.commitRun(run.id, "supervisor.completed", { decision }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        supervisor_decisions: [...current.supervisor_decisions, decision],
        pending_supervisor_decision: decision.intervene ? decision : undefined,
        pending_supervisor_redirect: decision.intervene ? {
          diagnosis: decision.diagnosis,
          avoid: decision.avoid.slice(0, 10),
          try: decision.try.slice(0, 10),
        } : undefined,
        deferred_supervisor_triggers: current.deferred_supervisor_triggers.filter((trigger) => !triggers.includes(trigger)),
        updated_at: now(),
      };
    });
    if (advice.review_node_ids?.length) run = await this.reviewHistoricalNodes(task, run, advice.review_node_ids);
    return run;
  }

  private async reviewHistoricalNodes(task: TaskManifest, run: RunSnapshot, nodeIds: string[]) {
    if (!this.verifier.reviewLineage) return run;
    const frame = run.evaluation_frame_revisions.at(-1);
    if (!frame) return run;
    const sealed = await this.sealed?.getForTask(task.id);
    for (const nodeId of [...new Set(nodeIds)]) {
      const node = run.lineage_nodes.find((item) => item.id === nodeId);
      if (!node || node.kind === "seed") continue;
      let review: NonNullable<LineageNode["current_review"]>;
      try {
        review = lineageReviewSchema.parse(await this.verifier.reviewLineage({
          runId: run.id, task, frame, node,
          sourcePath: (await this.artifacts.get(task.source_artifact_id)).path,
          nodePath: (await this.artifacts.get(node.artifact_id)).path,
          earlierImages: await Promise.all(run.lineage_nodes.filter((item) => (item.version ?? 0) < (node.version ?? 0)).slice(-3)
            .map(async (item) => ({ node: item, path: (await this.artifacts.get(item.artifact_id)).path }))),
          references: [...await Promise.all(task.references.map(async (item) => ({ path: (await this.artifacts.get(item.artifact_id)).path, ...(item.caption ? { caption: item.caption } : {}) }))), ...(sealed?.references ?? [])],
          ...(sealed?.hiddenTargetPath ? { hiddenTargetPath: sealed.hiddenTargetPath } : {}),
          ...(sealed?.privateRubric ? { privateInstructions: sealed.privateRubric } : {}),
        }));
      } catch {
        review = { evaluation_frame_revision_id: frame.id, correctness: "unclear", feedback_for_main_agent: ["Historical-node reassessment unavailable; prior acceptance is not a current-frame guarantee. Inspect earlier clean parents or explicitly justify reuse."], reviewed_at: now() };
      }
      run = await this.store.commitRun(run.id, "lineage.reviewed", { node_id: node.id, review }, (current) => {
        if (!current) throw new Error("run_not_found");
        return { ...current, lineage_nodes: current.lineage_nodes.map((item) => item.id === node.id ? { ...item, current_review: review } : item), updated_at: now() };
      });
    }
    return run;
  }

  private assertVerifierConsistency(task: TaskManifest, verification: VerificationResult) {
    const expected = new Set(task.checklist?.requirements.map((item) => item.id));
    const actual = new Set(verification.requirements.map((item) => item.requirement_id));
    if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) throw new Error("verifier_requirement_mismatch");
    if (verification.status === "PASS" && verification.requirements.some((item) => item.verdict !== "PASS")) throw new Error("verifier_inconsistent_pass");
  }

  assertAllowedInput(task: TaskManifest, run: RunSnapshot, input: GenerationInput) {
    const allowed = new Set([
      task.source_artifact_id,
      ...task.references.map((reference) => reference.artifact_id),
      ...run.attempts.map((attempt) => attempt.generated_artifact_id),
      ...run.drafts.flatMap((draft) => [draft.artifact_id, draft.raw_artifact_id]),
      ...run.lineage_nodes.map((node) => node.artifact_id),
    ]);
    if (!allowed.has(input.base_artifact_id)) throw new Error("generation_base_not_allowed");
    if (input.reference_artifact_ids.some((id) => !allowed.has(id))) throw new Error("generation_reference_not_allowed");
  }

  private async createRoundContext(task: TaskManifest, run: RunSnapshot): Promise<AgentRoundContext> {
    return {
      task,
      checklist: task.checklist!,
      run,
      imagePool: await this.getImagePool(task, run),
      recentAttempts: run.attempts.slice(-8),
      ...(run.pending_supervisor_redirect ? { supervisorRedirect: run.pending_supervisor_redirect } : {}),
      ...(run.pending_supervisor_decision ? { supervisorDecision: run.pending_supervisor_decision } : {}),
    };
  }

  async getImagePool(task: TaskManifest, run: RunSnapshot) {
    return [
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
      ...await Promise.all(run.drafts.map(async (draft) => ({
        artifactId: draft.artifact_id,
        path: (await this.artifacts.get(draft.artifact_id)).path,
        caption: `Draft ${draft.round}: ${draft.status}`,
        kind: "draft" as const,
        draft,
      }))),
    ];
  }

  private terminalStatus(run: RunSnapshot): {
    status: "stopped" | "completed" | "budget_exhausted";
    reason: string;
    finalLineageNodeId?: string;
    supervisorDecisionId?: string;
  } | undefined {
    if (this.stopRequests.has(run.id) || run.status === "stop_requested") return { status: "stopped", reason: "user_stopped" };
    const convergence = acceptedSupervisorConvergence(run);
    if (convergence) return {
      status: "completed",
      reason: "supervisor_stopped_search",
      supervisorDecisionId: convergence.decision.id,
    };
    if (run.generation_count >= run.config.max_generations) return { status: "budget_exhausted", reason: "generation_budget_exhausted" };
    const iterative = run.config.experimental_features?.iterative_search ? run.experimental_state?.iterative as { extra_generation_charges?: number } | undefined : undefined;
    if (typeof iterative?.extra_generation_charges === "number" && run.generation_count + iterative.extra_generation_charges >= run.config.max_generations) {
      return { status: "budget_exhausted", reason: "generation_budget_exhausted" };
    }
    if (run.active_variation_attempt > run.config.max_variation_steps) return { status: "budget_exhausted", reason: "variation_attempt_budget_exhausted" };
    if (run.config.max_agent_tokens && run.agent_total_tokens >= run.config.max_agent_tokens) return { status: "budget_exhausted", reason: "agent_token_budget_exhausted" };
    if (run.started_at && Date.now() - Date.parse(run.started_at) >= run.config.max_wall_time_ms) return { status: "budget_exhausted", reason: "wall_time_budget_exhausted" };
    return undefined;
  }

  private async finish(
    run: RunSnapshot,
    status: RunSnapshot["status"],
    reason: string,
    terminal?: { finalLineageNodeId?: string; supervisorDecisionId?: string },
  ) {
    this.stopRequests.delete(run.id);
    let finalizedRun = run;
    let finalLineageNodeId = terminal?.finalLineageNodeId;
    if (reason === "user_stopped") {
      finalLineageNodeId = run.incumbent_node_id;
    } else if (status !== "failed") {
      try {
        finalizedRun = await this.ensureFinalVerifierDecision(run);
      } catch (error) {
        const message = boundedErrorMessage(error);
        const timestamp = now();
        const pending = pendingFinalizationFor(run, status, reason, terminal?.supervisorDecisionId, message, timestamp);
        const pendingRun = await this.store.commitRun(run.id, "verifier.final_selection_failed", {
          failure_code: pending.failure_code,
          error: pending.last_error,
          attempt: pending.attempts,
          requested_status: pending.requested_status,
          terminal_reason: pending.terminal_reason,
        }, (current) => {
          if (!current) throw new Error("run_not_found");
          return {
            ...current,
            status: "finalization_pending",
            pending_finalization: pending,
            finished_at: undefined,
            terminal_reason: "finalization_pending",
            updated_at: timestamp,
          };
        });
        await this.agent.closeRun?.(run.id);
        return pendingRun;
      }
      finalLineageNodeId = finalizedRun.final_lineage_node_id ?? finalizedRun.incumbent_node_id;
    }
    const finishedAt = now();
    const finished = await this.store.commitRun(run.id, `run.${status}`, {
      reason,
      ...(finalLineageNodeId ? { final_lineage_node_id: finalLineageNodeId } : {}),
      ...(terminal?.supervisorDecisionId ? { supervisor_decision_id: terminal.supervisorDecisionId } : {}),
    }, () => ({
      ...finalizedRun,
      status,
      ...(finalLineageNodeId ? { final_lineage_node_id: finalLineageNodeId } : {}),
      ...(terminal?.supervisorDecisionId ? { terminal_supervisor_decision_id: terminal.supervisorDecisionId } : {}),
      supervisor_decisions: terminal?.supervisorDecisionId
        ? finalizedRun.supervisor_decisions.map((decision) => decision.id === terminal.supervisorDecisionId
          ? { ...decision, consumed_at: finishedAt }
          : decision)
        : finalizedRun.supervisor_decisions,
      pending_supervisor_decision: undefined,
      pending_supervisor_redirect: undefined,
      pending_finalization: undefined,
      finished_at: finishedAt,
      terminal_reason: reason,
      updated_at: finishedAt,
    }));
    await this.agent.closeRun?.(run.id);
    return finished;
  }

  private async ensureFinalVerifierDecision(run: RunSnapshot) {
    if (run.final_verifier_decision_id) return run;
    const frame = run.evaluation_frame_revisions.at(-1);
    if (!frame) throw new Error("final_verifier_frame_missing");
    const task = await this.store.getTask(run.task_id);
    const sealed = await this.sealed?.getForTask(task.id);
    const source = await this.artifacts.get(task.source_artifact_id);
    const publicReferences = await Promise.all(task.references.map(async (reference) => ({
      path: (await this.artifacts.get(reference.artifact_id)).path,
      ...(reference.caption ? { caption: reference.caption } : {}),
    })));
    const lineageCandidates = await Promise.all(run.lineage_nodes
      .filter((node) => node.kind === "seed" || node.version !== undefined)
      .sort((left, right) => (left.version ?? 0) - (right.version ?? 0))
      .map(async (node) => {
        const acceptedEvaluation = node.accepted_evaluation_id
          ? run.evaluations.find((evaluation) => evaluation.id === node.accepted_evaluation_id)
          : undefined;
        const acceptedDecision = acceptedEvaluation?.comparative_decision_id
          ? run.comparative_decisions.find((decision) => decision.id === acceptedEvaluation.comparative_decision_id)
          : undefined;
        return {
          node,
          path: (await this.artifacts.get(node.artifact_id)).path,
          origin: "lineage" as const,
          ...(acceptedDecision ? { acceptedDecision } : {}),
        };
      }));
    const lineageArtifacts = new Set(lineageCandidates.map((candidate) => candidate.node.artifact_id));
    const archiveFinalists = (await Promise.all(run.search_archive.map(async (entry) => {
      const draft = run.drafts.find((item) => item.id === entry.draft_id);
      const evaluation = run.evaluations.find((item) => item.id === entry.evaluation_id);
      const acceptedDecision = run.comparative_decisions.find((item) => item.id === entry.comparative_decision_id);
      if (!draft || !evaluation || !acceptedDecision || lineageArtifacts.has(draft.artifact_id)
        || acceptedDecision.preference !== "better" || acceptedDecision.correctness !== "pass"
        || !acceptedDecision.technical_gate.passed || !evaluation.correctness_gate.passed) return undefined;
      const parentNode = resolveParentNode(run, draft.parent_artifact_id);
      const parentDraft = run.drafts.findLast((item) => item.artifact_id === draft.parent_artifact_id);
      const node: LineageNode = {
        id: `archive-finalist-${draft.id}`,
        run_id: run.id,
        kind: "commit",
        artifact_id: draft.artifact_id,
        ...(parentNode || parentDraft ? { parent_node_id: parentNode?.id ?? parentDraft!.id } : {}),
        draft_id: draft.id,
        evaluation_id: evaluation.id,
        ancestry_depth: parentDraft ? ancestryDepthForDraft(run, parentDraft) + 1 : (parentNode?.ancestry_depth ?? 0) + 1,
        pareto_active: false,
        derived_from_node_id: parentNode?.id ?? parentDraft?.id ?? run.incumbent_node_id,
        accepted_evaluation_id: evaluation.id,
        evaluation_frame_revision_id: acceptedDecision.evaluation_frame_revision_id,
        committed_at: evaluation.created_at,
      };
      return {
        node,
        path: (await this.artifacts.get(draft.artifact_id)).path,
        origin: "archive" as const,
        acceptedDecision,
      };
    }))).filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const candidates = [...lineageCandidates, ...archiveFinalists];
    const decision = await this.verifier.selectFinal({
      runId: run.id,
      task,
      frame,
      sourcePath: source.path,
      candidates,
      publicReferences,
      sealedReferences: sealed?.references ?? [],
      ...(sealed?.hiddenTargetPath ? { hiddenTargetPath: sealed.hiddenTargetPath } : {}),
      ...(sealed?.privateRubric ? { privateInstructions: sealed.privateRubric } : {}),
    });
    const selectedArchive = archiveFinalists.find((candidate) => candidate.node.id === decision.selected_node_id);
    const promotedAt = now();
    const promotedNode = selectedArchive ? {
      ...selectedArchive.node,
      version: run.active_evolution_version + 1,
      previous_version_node_id: run.incumbent_node_id,
      committed_at: promotedAt,
    } : undefined;
    return this.store.commitRun(run.id, "verifier.final_selected", {
      final_verifier_decision_id: decision.id,
      selected_node_id: decision.selected_node_id,
      confidence: decision.confidence,
      selected_origin: selectedArchive ? "archive" : "lineage",
      ...(promotedNode ? { promoted_draft_id: promotedNode.draft_id, promoted_version: promotedNode.version } : {}),
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        ...(promotedNode ? {
          lineage_nodes: [...current.lineage_nodes, promotedNode],
          incumbent_node_id: promotedNode.id,
          active_evolution_version: promotedNode.version!,
          search_archive: current.search_archive.filter((item) => item.draft_id !== promotedNode.draft_id),
          drafts: current.drafts.map((draft) => draft.id === promotedNode.draft_id
            ? { ...draft, status: "verified" as const }
            : draft),
        } : {}),
        final_verifier_decisions: [...current.final_verifier_decisions, decision],
        final_verifier_decision_id: decision.id,
        final_lineage_node_id: decision.selected_node_id,
        updated_at: now(),
      };
    });
  }
}

class VariationToolSession implements AgentToolbox {
  submission?: Submission;
  abandonment?: StepAbandonment;
  private run: RunSnapshot;
  private prompt: PromptRevision | undefined;
  private parent: ParentSelection | undefined;
  private references: string[];
  private referenceUsage: GenerationInput["reference_usage"];
  private readonly submissionPromise: Promise<Submission>;
  private resolveSubmission!: (submission: Submission) => void;
  private readonly abandonmentPromise: Promise<StepAbandonment>;
  private resolveAbandonment!: (abandonment: StepAbandonment) => void;
  private readonly budgetExceededPromise: Promise<string>;
  private resolveBudgetExceeded!: (reason: string) => void;
  private readonly stopPromise: Promise<void>;
  private resolveStop!: () => void;
  private budgetExceeded = false;
  private stopSignaled = false;
  private readonly variationStep: number;
  private readonly tokenBase: number;

  constructor(
    private readonly runner: AvoRunner,
    private readonly task: TaskManifest,
    run: RunSnapshot,
    private readonly baselineMode = false,
  ) {
    this.run = run;
    this.variationStep = run.active_variation_attempt;
    this.tokenBase = run.agent_total_tokens;
    this.prompt = run.generation_prompt;
    this.parent = run.parent_selection;
    this.references = run.selected_reference_artifact_ids;
    this.referenceUsage = run.selected_generation_input?.reference_usage;
    this.submissionPromise = new Promise((resolve) => { this.resolveSubmission = resolve; });
    this.abandonmentPromise = new Promise((resolve) => { this.resolveAbandonment = resolve; });
    this.budgetExceededPromise = new Promise((resolve) => { this.resolveBudgetExceeded = resolve; });
    this.stopPromise = new Promise((resolve) => { this.resolveStop = resolve; });
  }

  getRunSnapshot() { return this.run; }
  getLineage() { return this.run.lineage_nodes; }
  getMemory() { return { current: this.run.working_memory, revisions: this.run.memory_revisions, hypotheses: this.run.hypotheses }; }
  getEvaluation(evaluationId: string) {
    const evaluation = this.run.evaluations.find((item) => item.id === evaluationId);
    if (!evaluation) throw new Error("evaluation_not_found");
    return evaluation;
  }
  getPrompt() { return this.prompt?.value ?? ""; }
  waitForSubmission() { return this.submissionPromise; }
  waitForAbandonment() { return this.abandonmentPromise; }
  waitForBudgetExceeded() { return this.budgetExceededPromise; }
  waitForStop() { return this.stopPromise; }
  signalStop() {
    if (this.stopSignaled) return;
    this.stopSignaled = true;
    this.resolveStop();
  }
  signalBudgetExceeded(reason: string) {
    if (this.budgetExceeded) return;
    this.budgetExceeded = true;
    this.resolveBudgetExceeded(reason);
  }

  async setPrompt(value: string) {
    if (!value.trim()) throw new Error("prompt_required");
    if (normalizeText(value) === normalizeText(this.task.user_brief)) throw new Error("user_brief_cannot_be_generation_prompt");
    const revision = (this.run.prompt_revisions.at(-1)?.revision ?? 0) + 1;
    const prompt = promptRevisionSchema.parse({ revision, value, origin: "agent", created_at: now() });
    this.run = await this.runner.store.commitRun(this.run.id, "prompt.updated", { prompt }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        prompt: prompt.value,
        current_prompt: prompt.value,
        generation_prompt: prompt,
        prompt_revisions: [...current.prompt_revisions, prompt],
        updated_at: now(),
      };
    });
    this.prompt = prompt;
  }

  async appendPrompt(fragment: string) { await this.setPrompt(`${this.getPrompt()}${fragment}`); }
  async replacePrompt(oldText: string, newText: string) {
    if (!this.getPrompt().includes(oldText)) throw new Error("prompt_fragment_not_found");
    await this.setPrompt(this.getPrompt().replace(oldText, newText));
  }
  async deletePromptFragment(fragment: string) { await this.replacePrompt(fragment, ""); }

  async selectParent(parentNodeId: string, rationale: string, overrideRationale?: string) {
    if (!rationale.trim()) throw new Error("parent_selection_rationale_required");
    const current = await this.runner.store.getRun(this.run.id);
    const source = current.lineage_nodes.find((node) => node.kind === "seed"
      && (node.id === parentNodeId || node.artifact_id === parentNodeId));
    const commit = current.lineage_nodes.find((node) => node.kind === "commit"
      && (node.id === parentNodeId || node.artifact_id === parentNodeId));
    const draft = current.drafts.find((item) => (item.id === parentNodeId || item.artifact_id === parentNodeId)
      && item.status !== "rejected_preverify" && item.status !== "ambiguous");
    const selected = source ?? commit;
    if (!selected && !draft) throw new Error("parent_not_available");
    const resolvedParentId = draft?.id ?? selected!.id;
    const pending = current.pending_supervisor_decision;
    const currentReview = (selected ?? current.lineage_nodes.find((node) => node.artifact_id === draft?.artifact_id))?.current_review;
    if (!source && currentReview && currentReview.correctness !== "pass" && !overrideRationale?.trim()) throw new Error("parent_review_requires_override_rationale");
    if (pending?.recommended_parent_id && pending.recommended_parent_id !== resolvedParentId && !overrideRationale?.trim()) throw new Error("supervisor_parent_override_rationale_required");
    const evaluation = draft
      ? evaluationForArtifact(current, draft.artifact_id)
      : selected?.evaluation_id
        ? current.evaluations.find((item) => item.id === selected.evaluation_id)
        : undefined;
    const selection = parentSelectionSchema.parse({
      parent_node_id: resolvedParentId,
      artifact_id: draft?.artifact_id ?? selected!.artifact_id,
      kind: draft ? "draft" : selected!.kind === "seed" ? "source" : "commit",
      rationale,
      ...(overrideRationale ? { override_rationale: overrideRationale } : {}),
      ancestry_depth: draft ? ancestryDepthForDraft(current, draft) : selected!.ancestry_depth,
      source_debt_severe_count: evaluation ? countSeverity(evaluation.source_quality_debt, "severe") : 0,
      step_debt_severe_count: evaluation ? countSeverity(evaluation.step_quality_debt, "severe") : 0,
      selected_at: now(),
    });
    this.run = await this.runner.store.commitRun(current.id, "parent.selected", {
      selection,
      ...(pending ? { supervisor_response: {
        decision_id: pending.id,
        parent_changed: current.parent_selection?.artifact_id !== selection.artifact_id,
        recommended_parent_followed: pending.recommended_parent_id === resolvedParentId,
        override_rationale: overrideRationale ?? null,
        requested_strategy_change: pending.search_assessment?.strategy_change ?? null,
      } } : {}),
    }, (run) => {
      if (!run) throw new Error("run_not_found");
      return {
        ...run,
        parent_selection: selection,
        selected_input: { base_artifact_id: selection.artifact_id, reference_artifact_ids: this.references, ...(this.referenceUsage ? { reference_usage: this.referenceUsage } : {}) },
        selected_generation_input: { base_artifact_id: selection.artifact_id, reference_artifact_ids: this.references, ...(this.referenceUsage ? { reference_usage: this.referenceUsage } : {}) },
        pending_supervisor_decision: undefined,
        pending_supervisor_redirect: undefined,
        supervisor_decisions: pending ? run.supervisor_decisions.map((decision) => decision.id === pending.id ? { ...decision, consumed_at: now() } : decision) : run.supervisor_decisions,
        updated_at: now(),
      };
    });
    this.parent = selection;
    return selection;
  }

  async selectReferences(artifactIds: string[], usage?: GenerationInput["reference_usage"]) {
    const input = { base_artifact_id: this.parent?.artifact_id ?? this.task.source_artifact_id, reference_artifact_ids: artifactIds,
      ...(usage ? { reference_usage: usage } : {}) };
    assertReferenceUsage(input);
    this.runner.assertAllowedInput(this.task, this.run, input);
    this.references = [...new Set(artifactIds)];
    this.referenceUsage = usage;
    this.run = await this.runner.store.commitRun(this.run.id, "references.selected", { artifact_ids: this.references }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        selected_reference_artifact_ids: this.references,
        ...(this.parent ? {
          selected_input: { base_artifact_id: this.parent.artifact_id, reference_artifact_ids: this.references, ...(usage ? { reference_usage: usage } : {}) },
          selected_generation_input: { base_artifact_id: this.parent.artifact_id, reference_artifact_ids: this.references, ...(usage ? { reference_usage: usage } : {}) },
        } : {}),
        updated_at: now(),
      };
    });
  }

  async selectGenerationInputs(input: GenerationInput) {
    const current = await this.runner.store.getRun(this.run.id);
    const parentId = resolveSelectableParentId(current, this.task, input.base_artifact_id);
    await this.selectReferences(input.reference_artifact_ids, input.reference_usage);
    await this.selectParent(parentId, this.baselineMode ? "Frozen baseline source selection." : "Explicitly selected generation parent.");
  }

  async listImagePool() {
    this.run = await this.runner.store.getRun(this.run.id);
    return this.runner.getImagePool(this.task, this.run);
  }

  async viewImage(artifactId: string) {
    const pool = await this.listImagePool();
    if (!pool.some((item) => item.artifactId === artifactId)) throw new Error("image_not_in_allowed_pool");
    const draft = this.run.drafts.findLast((item) => item.artifact_id === artifactId || item.raw_artifact_id === artifactId);
    if (draft && !draft.viewed_at) {
      const viewedAt = now();
      this.run = await this.runner.store.commitRun(this.run.id, "draft.viewed", { draft_id: draft.id, artifact_id: artifactId }, (current) => {
        if (!current) throw new Error("run_not_found");
        return {
          ...current,
          drafts: current.drafts.map((item) => item.id === draft.id ? { ...item, viewed_at: viewedAt } : item),
          updated_at: viewedAt,
        };
      });
    }
    const artifact = await this.runner.artifacts.get(artifactId);
    return { path: artifact.path, mimeType: artifact.artifact.mime_type };
  }

  async generateImage() {
    if (!this.prompt || this.prompt.origin !== "agent") throw new Error("agent_generation_prompt_required");
    if (!this.parent) throw new Error("explicit_parent_selection_required");
    if (this.run.pending_supervisor_decision?.intervene) throw new Error("supervisor_decision_requires_parent_selection");
    const latest = this.baselineMode ? undefined : this.run.drafts.findLast((draft) => draft.round === this.run.active_variation_attempt);
    if (latest) {
      const evaluated = this.run.evaluations.some((evaluation) => evaluation.artifact_id === latest.artifact_id);
      if (!latest.viewed_at || !evaluated) throw new Error("draft_requires_view_and_evaluation_before_next_generation");
      const sameReferences = latest.generation_input.reference_artifact_ids.length === this.references.length
        && latest.generation_input.reference_artifact_ids.every((id, index) => id === this.references[index]);
      if (normalizeText(latest.prompt) === normalizeText(this.prompt.value)
        && latest.parent_artifact_id === this.parent.artifact_id
        && sameReferences) {
        throw new Error("generation_requires_revision_or_parent_change");
      }
    }
    const generated = await this.runner.generateDraft(this.task, this.run, this.prompt, this.parent, this.references, this.referenceUsage);
    this.run = generated.run;
    return generated.artifactId;
  }

  async recordEditedDraft(input: Parameters<AgentToolbox["recordEditedDraft"]>[0]) {
    this.run = await this.runner.store.getRun(this.run.id);
    const photo = input.photoEdit;
    const method = photo ? "photo_adjustment" : "svg_edit";
    if (!this.run.config.experimental_features?.[photo ? "photo_adjustments" : "svg_editing"]) throw new Error(`${method}_disabled`);
    if (this.run.pending_decision) throw new Error("pending_decision_requires_disposition");
    if (!this.parent || this.parent.artifact_id !== input.parentArtifactId) throw new Error("svg_parent_selection_mismatch");
    if (this.run.pending_supervisor_decision?.intervene) throw new Error("supervisor_decision_requires_parent_selection");
    if (this.run.generation_count >= this.run.config.max_generations) throw new Error("generation_budget_exhausted");
    if (this.run.drafts.filter((draft) => draft.round === this.variationStep).length >= this.run.config.max_generations_per_round) {
      throw new Error("variation_attempt_generation_budget_exhausted");
    }
    const latest = this.run.drafts.findLast((draft) => draft.round === this.variationStep);
    if (latest && (!latest.viewed_at || !this.run.evaluations.some((evaluation) => evaluation.draft_id === latest.id))) {
      throw new Error("draft_requires_view_and_evaluation_before_next_generation");
    }
    const references = photo ? [] : [...new Set(input.edit!.source_artifact_ids.filter((id) => id !== input.parentArtifactId))];
    if (photo && photo.base_artifact_id !== input.parentArtifactId) throw new Error("photo_recipe_base_mismatch");
    const generationInput = { base_artifact_id: input.parentArtifactId, reference_artifact_ids: references };
    this.runner.assertAllowedInput(this.task, this.run, generationInput);
    const source = await this.runner.artifacts.get(this.task.source_artifact_id);
    const [sourceDimensions, finalDimensions] = await Promise.all([
      readImageDimensions(source.bytes), readImageDimensions(input.bytes),
    ]);
    const expectedDimensions = photo ? await readImageDimensions((await this.runner.artifacts.get(input.parentArtifactId)).bytes) : sourceDimensions;
    if (expectedDimensions.width !== finalDimensions.width || expectedDimensions.height !== finalDimensions.height) {
      throw new Error("svg_candidate_dimensions_must_match_source");
    }
    await this.setPrompt(input.description);
    const artifact = await this.runner.artifacts.put({ bytes: input.bytes, mimeType: "image/png", originalName: `${method}.png` });
    const draft: CandidateDraft = {
      id: createId("draft"), round: this.variationStep, origin_step: this.variationStep,
      creation_method: method, ...(photo ? { photo_edit: photo } : { svg_edit: input.edit }), status: "generated",
      raw_artifact_id: artifact.id, artifact_id: artifact.id, parent_artifact_id: input.parentArtifactId,
      prompt: input.description, generation_input: generationInput,
      dimensions: { source: sourceDimensions, provider: finalDimensions, final: finalDimensions, normalized: false },
      latency_ms: input.latencyMs, created_at: now(),
    };
    this.run = await this.runner.store.commitRun(this.run.id, "draft.generated", {
      draft, creation_method: method, prompt_revision: this.prompt!.revision, parent_selection: this.parent,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        selected_reference_artifact_ids: references,
        selected_input: generationInput, selected_generation_input: generationInput,
        drafts: [...current.drafts, draft],
        variation_attempts: current.variation_attempts.map((attempt) => attempt.attempt === this.variationStep
          ? variationAttemptRecordSchema.parse({ ...attempt, draft_ids: [...new Set([...attempt.draft_ids, draft.id])] })
          : attempt),
        generation_count: current.generation_count + 1, updated_at: now(),
      };
    });
    this.references = references;
    this.referenceUsage = undefined;
    return artifact.id;
  }

  async recordExperimentState(kind: "iterative" | "copilot", state: unknown, detail: Record<string, unknown> = {}) {
    const feature = kind === "iterative" ? "iterative_search" : "copilot_routing";
    if (!this.run.config.experimental_features?.[feature]) throw new Error(`${feature}_disabled`);
    if (JSON.stringify(state).length > 100_000) throw new Error("experimental_state_too_large");
    this.run = await this.runner.store.commitRun(this.run.id, `experiment.${kind}.updated`, {
      variation_attempt: this.variationStep, ...detail,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return { ...current, experimental_state: { ...current.experimental_state, [kind]: state }, updated_at: now() };
    });
  }

  async evaluateDraft(draftId: string) {
    const evaluation = await this.runner.evaluateDraft(this.task, this.run, draftId);
    this.run = await this.runner.store.getRun(this.run.id);
    const triggers = detectInStepTrajectoryTriggers(this.run, this.variationStep);
    if (triggers.length > 0) {
      this.run = await this.runner.maybeRunSupervisor(this.task, this.run, triggers, "in_step");
    }
    return evaluation;
  }

  async declinePendingDecision(rationale: string) {
    if (!rationale.trim()) throw new Error("pending_decision_rationale_required");
    if (!this.run.pending_decision) return;
    this.run = await this.runner.store.commitRun(this.run.id, "pending_decision.declined", {
      source_step: this.run.pending_decision.source_step,
      rationale: rationale.trim(),
      decision_step: this.variationStep,
    }, (current) => {
      if (!current) throw new Error("run_not_found");
      return { ...current, pending_decision: undefined, updated_at: now() };
    });
  }

  async restoreAttempt(attemptId: string) {
    const attempt = this.run.attempts.find((item) => item.id === attemptId);
    if (!attempt) throw new Error("attempt_not_found");
    const parentId = resolveSelectableParentId(this.run, this.task, attempt.generated_artifact_id);
    await this.selectParent(parentId, `Restore historical attempt ${attemptId}.`);
    await this.selectReferences(attempt.generation_input.reference_artifact_ids);
    await this.setPrompt(attempt.prompt);
  }

  async updateWorkingMemory(memory: WorkingMemory) {
    const parsed = workingMemorySchema.parse(memory);
    const before = this.run.working_memory;
    const revision = {
      id: createId("memory"),
      revision: (this.run.memory_revisions.at(-1)?.revision ?? 0) + 1,
      before,
      after: parsed,
      diff: diffMemory(before, parsed),
      created_at: now(),
    };
    this.run = await this.runner.store.commitRun(this.run.id, "working_memory.updated", { revision }, (current) => {
      if (!current) throw new Error("run_not_found");
      return { ...current, working_memory: parsed, memory_revisions: [...current.memory_revisions, revision], memory_pending: false, updated_at: now() };
    });
  }

  async upsertHypothesis(input: Omit<Hypothesis, "created_at" | "updated_at">) {
    this.run = await this.runner.store.getRun(this.run.id);
    if (["supported", "refuted"].includes(input.status) && !input.trial_claim) throw new Error("hypothesis_requires_structured_trial_claim");
    if (input.trial_claim) assertTrialClaim(this.run, input.trial_claim);
    const timestamp = now();
    const existing = this.run.hypotheses.find((item) => item.id === input.id);
    const hypothesis = hypothesisSchema.parse({ ...input, created_at: existing?.created_at ?? timestamp, updated_at: timestamp });
    this.run = await this.runner.store.commitRun(this.run.id, "hypothesis.updated", { hypothesis }, (current) => {
      if (!current) throw new Error("run_not_found");
      return {
        ...current,
        hypotheses: existing
          ? current.hypotheses.map((item) => item.id === hypothesis.id ? hypothesis : item)
          : [...current.hypotheses, hypothesis],
        updated_at: timestamp,
      };
    });
    return hypothesis;
  }

  async submitCandidate(draftId: string, decisionId: string, summary: AgentSummary, memoryUpdate?: WorkingMemory) {
    if (this.submission) throw new Error("candidate_already_submitted");
    if (this.abandonment) throw new Error("variation_step_already_abandoned");
    this.run = await this.runner.store.getRun(this.run.id);
    const draft = this.run.drafts.find((item) => item.id === draftId);
    const decision = this.run.comparative_decisions.find((item) => item.id === decisionId);
    const evaluation = decision
      ? this.run.evaluations.find((item) => item.comparative_decision_id === decision.id && item.draft_id === draftId)
      : undefined;
    if (!draft || !decision || !evaluation || evaluation.artifact_id !== draft.artifact_id) throw new Error("comparative_decision_required");
    if (evaluation.evaluator_revision !== this.run.config.evaluator_revision) throw new Error("current_evaluator_revision_required");
    const frame = this.run.evaluation_frame_revisions.find((item) => item.attempt === this.run.active_variation_attempt);
    if (!frame || decision.evaluation_frame_revision_id !== frame.id) throw new Error("current_evaluation_frame_required");
    if (decision.incumbent_node_id !== this.run.incumbent_node_id) throw new Error("current_incumbent_comparison_required");
    if (decision.recommendation !== "commit" || decision.preference !== "better" || decision.correctness !== "pass"
      || !decision.technical_gate.passed) throw new Error("verifier_commit_recommendation_required");
    if (!draft.viewed_at && this.run.config.mode === "avo") throw new Error("candidate_must_be_viewed_before_submission");
    this.run = await this.runner.persistSubmission(this.run, draft.id, evaluation.id, decision.id, summary, this.variationStep);
    this.submission = {
      draftId: draft.id,
      artifactId: draft.artifact_id,
      evaluationId: evaluation.id,
      decisionId: decision.id,
      summary,
      decisionStep: this.variationStep,
      ...(memoryUpdate ? { memoryUpdate: workingMemorySchema.parse(memoryUpdate) } : {}),
    };
    this.resolveSubmission(this.submission);
    return { draftId: draft.id, artifactId: draft.artifact_id, evaluationId: evaluation.id, decisionId: decision.id };
  }

  async abandonStep(
    reason: string,
    summaryInput: AgentSummary,
    memoryUpdate?: WorkingMemory,
    status: "abandoned" | "runtime_cutoff" | "failed" = "abandoned",
  ) {
    if (this.submission) throw new Error("candidate_already_submitted");
    if (this.abandonment) throw new Error("variation_step_already_abandoned");
    if (!reason.trim()) throw new Error("abandonment_reason_required");
    const summary = agentSummarySchema.parse(summaryInput);
    const variationStep = this.run.active_variation_attempt;
    const parsedMemory = memoryUpdate ? workingMemorySchema.parse(memoryUpdate) : undefined;
    const abandonment = { reason: reason.trim(), summary, status, ...(parsedMemory ? { memoryUpdate: parsedMemory } : {}) };
    this.run = await this.runner.completeVariationStep(this.run, {
      step: variationStep,
      status,
      summary,
      ...(parsedMemory ? { memoryUpdate: parsedMemory } : {}),
      terminalReason: abandonment.reason,
    });
    this.prompt = undefined;
    this.parent = undefined;
    this.references = [];
    this.referenceUsage = undefined;
    this.abandonment = abandonment;
    this.resolveAbandonment(abandonment);
  }

  async recordAgentRuntime(usage: { totalTokens?: number; toolCalls?: number }) {
    this.run = await this.runner.store.commitRun(this.run.id, "agent.runtime_updated", usage, (current) => {
      if (!current) throw new Error("run_not_found");
      const totalTokens = Math.max(current.agent_total_tokens, usage.totalTokens ?? current.agent_total_tokens);
      const targetStep = current.variation_steps.find((step) => step.step === this.variationStep);
      const targetAttempt = current.variation_attempts.find((attempt) => attempt.attempt === this.variationStep);
      const nextStep = targetStep ? variationStepRecordSchema.parse({
        ...targetStep,
        usage_delta: {
          total_tokens: Math.max(targetStep.usage_delta.total_tokens, totalTokens - this.tokenBase),
          tool_calls: targetStep.usage_delta.tool_calls + (usage.toolCalls ?? 0),
        },
      }) : undefined;
      return {
        ...current,
        agent_total_tokens: totalTokens,
        tool_call_count: current.tool_call_count + (usage.toolCalls ?? 0),
        variation_steps: nextStep
          ? current.variation_steps.map((step) => step.step === nextStep.step ? nextStep : step)
          : current.variation_steps,
        variation_attempts: targetAttempt
          ? current.variation_attempts.map((attempt) => attempt.attempt === targetAttempt.attempt
            ? variationAttemptRecordSchema.parse({
                ...attempt,
                usage_delta: {
                  total_tokens: Math.max(attempt.usage_delta.total_tokens, totalTokens - this.tokenBase),
                  tool_calls: attempt.usage_delta.tool_calls + (usage.toolCalls ?? 0),
                },
              })
            : attempt)
          : current.variation_attempts,
        updated_at: now(),
      };
    });
  }

  async recordContextCompaction() {
    this.run = await this.runner.store.commitRun(this.run.id, "contextCompaction", {}, (current) => {
      if (!current) throw new Error("run_not_found");
      return { ...current, context_compactions: current.context_compactions + 1, updated_at: now() };
    });
  }

  async setStepDeadline(deadline: StepDeadline) {
    this.run = await this.runner.store.commitRun(this.run.id, "agent.step_deadline_set", { deadline }, (current) => {
      if (!current) throw new Error("run_not_found");
      return { ...current, step_deadline: deadline, updated_at: now() };
    });
  }
}

const readImageDimensions = async (bytes: Buffer) => {
  const metadata = await sharp(bytes).metadata();
  if (!metadata.width || !metadata.height) throw new Error("image_dimensions_unavailable");
  return { width: metadata.width, height: metadata.height };
};

const withoutTerminalFields = (run: RunSnapshot) => {
  const { finished_at: _finishedAt, terminal_reason: _terminalReason, ...rest } = run;
  return rest;
};

const bestFailure = (attempts: CandidateAttempt[]) => attempts
  .filter((attempt) => attempt.status === "failed" && attempt.verification)
  .sort((left, right) => (right.verification?.overall_score ?? -1) - (left.verification?.overall_score ?? -1))[0];

const parentAttemptForDraft = (run: RunSnapshot, draft: CandidateDraft) => {
  const attempt = run.attempts.find((item) => item.generated_artifact_id === draft.parent_artifact_id);
  return attempt ? { parent_attempt_id: attempt.id } : {};
};

const evaluationForArtifact = (run: RunSnapshot, artifactId: string, evaluatorRevision?: string) => {
  const draft = run.drafts.findLast((item) => item.artifact_id === artifactId);
  return draft ? run.evaluations.findLast((item) => item.draft_id === draft.id
    && (!evaluatorRevision || item.evaluator_revision === evaluatorRevision)) : undefined;
};

const objectiveTechnicalBlockerIds = new Set([
  "decode_integrity",
  "transparent_or_empty_ratio",
  "shadow_clipping",
  "highlight_clipping",
  "smooth_region_banding",
  "blockiness_8px",
  "blockiness_16px",
]);
const objectiveTechnicalBlockers = (debt: QualityDebtVector) => [...new Set(
  Object.values(debt).flatMap((metrics) => metrics)
    .filter((metric) => metric.severity === "severe" && objectiveTechnicalBlockerIds.has(metric.id))
    .map((metric) => metric.id),
)];

const debtProjection = (debt: QualityDebtVector, groups?: Array<keyof QualityDebtVector>) => Object.fromEntries(
  (groups ?? Object.keys(debt) as Array<keyof QualityDebtVector>).map((group) => [group, debt[group].map((metric) => ({
    id: metric.id,
    value: metric.value,
    unit: metric.unit,
    severity: metric.severity,
    confidence: metric.confidence,
    detail: metric.detail,
  }))]),
);

const verifierEvidenceFor = (
  tool: VerifierToolName,
  run: RunSnapshot,
  draft: CandidateDraft,
  quality: QualityEvaluation,
  targetQuality?: QualityEvaluation,
): VerifierEvidence => {
  const id = `evidence-${draft.id}-${tool}`;
  if (tool === "measure_integrity") return {
    id,
    tool,
    summary: "Objective decode, alpha, empty-image and channel integrity checks against Source.",
    data: { metrics: debtProjection(quality.source_quality_debt, ["integrity"]) },
  };
  if (tool === "measure_source_fidelity") return {
    id,
    tool,
    summary: "Difference from Source. This is descriptive evidence and is not automatically a quality penalty.",
    data: { metrics: debtProjection(quality.source_quality_debt) },
  };
  if (tool === "measure_parent_delta") return {
    id,
    tool,
    summary: "Local deterministic difference from the selected generation parent.",
    data: { parent_artifact_id: draft.parent_artifact_id, metrics: debtProjection(quality.step_quality_debt) },
  };
  if (tool === "measure_target_alignment") return {
    id,
    tool,
    summary: targetQuality
      ? "Partial deterministic color, structure and edge distance to the hidden target; semantic similarity still requires visual judgment."
      : "No hidden target is configured, so deterministic target alignment is unavailable.",
    data: targetQuality ? { metrics: debtProjection(targetQuality.source_quality_debt) } : { available: false },
  };
  if (tool === "measure_artifacts") return {
    id,
    tool,
    summary: "Partial clipping, detail-energy change, banding and blockiness measurements. No alarm is NOT evidence of natural texture; generated repetition can increase detail metrics.",
    data: { metrics: debtProjection(quality.source_quality_debt, ["clipping", "detail", "banding", "blockiness"]),
      parent_metrics: debtProjection(quality.step_quality_debt, ["detail"]),
      limitations: ["Not a semantic realism detector", "No spatial alignment or texture provenance inference", "Source-root regeneration can still introduce first-generation defects"] },
  };
  return {
    id,
    tool,
    summary: "Bounded pairwise evaluation history. Absolute scores are omitted because they do not control commits.",
    data: {
      decisions: run.comparative_decisions.slice(-12).map((decision) => ({
        decision_id: decision.id,
        frame_id: decision.evaluation_frame_revision_id,
        preference: decision.preference,
        target_progress: decision.target_progress,
        confidence: decision.confidence,
        recommendation: decision.recommendation,
      })),
    },
  };
};

const legacyVerificationFromDecision = (
  frame: EvaluationFrameRevision,
  decision: ComparativeVerifierDecision,
): VerificationResult => {
  const judgments = decision.axis_judgments.map((judgment) => ({
    requirement_id: judgment.axis_id,
    verdict: judgment.verdict.toUpperCase() as "PASS" | "FAIL" | "UNCLEAR",
    score: judgment.candidate_score ?? (judgment.verdict === "pass" ? 90 : judgment.verdict === "fail" ? 30 : 50),
    evidence: judgment.evidence,
  }));
  const blockerFailed = judgments.some((judgment) => judgment.verdict !== "PASS"
    && frame.axes.some((axis) => axis.id === judgment.requirement_id && axis.importance === "blocker"));
  const overall = mean(judgments.map((judgment) => judgment.score));
  const preservationPass = !frame.axes.some((axis) => axis.mode === "preserve_source"
    && axis.importance === "blocker"
    && decision.axis_judgments.some((judgment) => judgment.axis_id === axis.id && judgment.verdict !== "pass"));
  return verificationResultSchema.parse({
    status: decision.correctness === "pass" && !blockerFailed ? "PASS" : "FAIL",
    overall_score: Math.max(0, Math.min(100, overall)),
    confidence: decision.confidence,
    requirements: judgments,
    preservation: {
      identity: preservationPass ? 95 : 35,
      composition: preservationPass ? 95 : 35,
      unaffected_regions: preservationPass ? 95 : 35,
    },
    artifacts: decision.technical_gate.blockers,
    feedback: decision.feedback_for_main_agent,
    model: decision.model,
    usage: decision.usage,
    latency_ms: decision.latency_ms,
  });
};

const assertComparativeDecision = (
  frame: EvaluationFrameRevision,
  draft: CandidateDraft,
  incumbent: LineageNode,
  decision: ComparativeVerifierDecision,
) => {
  if (decision.draft_id !== draft.id || decision.candidate_artifact_id !== draft.artifact_id) throw new Error("verifier_candidate_mismatch");
  if (decision.incumbent_node_id !== incumbent.id || decision.incumbent_artifact_id !== incumbent.artifact_id) throw new Error("verifier_incumbent_mismatch");
  if (decision.evaluation_frame_revision_id !== frame.id) throw new Error("verifier_frame_mismatch");
  const expected = new Set(frame.axes.map((axis) => axis.id));
  const actual = new Set(decision.axis_judgments.map((judgment) => judgment.axis_id));
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) throw new Error("verifier_axis_mismatch");
  const blockerFailed = decision.axis_judgments.some((judgment) => judgment.verdict !== "pass"
    && frame.axes.some((axis) => axis.id === judgment.axis_id && axis.importance === "blocker"));
  if (blockerFailed && decision.correctness === "pass") throw new Error("verifier_inconsistent_correctness");
  const canCommit = decision.technical_gate.passed && decision.correctness === "pass"
    && decision.preference === "better";
  if ((decision.recommendation === "commit") !== canCommit) throw new Error("verifier_inconsistent_commit_recommendation");
};

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
const countSeverity = (debt: QualityDebtVector, severity: "warn" | "severe") => Object.values(debt)
  .flatMap((items) => items)
  .filter((metric) => metric.severity === severity).length;

const boundedErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error ?? "unknown_error"))
  .replace(/[\r\n]+/g, " ")
  .slice(0, 2_000);

const finalizationFailureCode = (message: string): PendingFinalization["failure_code"] => {
  if (/structured_output|invalid_json|invalid_output|JSON/i.test(message)) return "invalid_structured_output";
  if (/timeout|timed out|event_timeout/i.test(message)) return "timeout";
  if (/http_[45]\d\d|429|provider/i.test(message)) return "provider_http_error";
  if (/app_server|codex_turn|codex_event|exited/i.test(message)) return "app_server_error";
  return "unknown_error";
};

const pendingFinalizationFor = (
  run: RunSnapshot,
  status: RunSnapshot["status"],
  terminalReason: string,
  supervisorDecisionId: string | undefined,
  message: string,
  timestamp: string,
): PendingFinalization => ({
  requested_status: status === "budget_exhausted" ? "budget_exhausted" : "completed",
  terminal_reason: terminalReason,
  ...(supervisorDecisionId ? { supervisor_decision_id: supervisorDecisionId } : {}),
  failure_code: finalizationFailureCode(message),
  last_error: message,
  attempts: (run.pending_finalization?.attempts ?? 0) + 1,
  created_at: run.pending_finalization?.created_at ?? timestamp,
  updated_at: timestamp,
});

const recoverPendingFinalization = (run: RunSnapshot): PendingFinalization | undefined => {
  if (run.final_verifier_decision_id || !/verifier_invalid_json_after_repair|final_verifier/i.test(run.terminal_reason ?? "")) return undefined;
  const decision = run.supervisor_decisions.findLast((item) => item.branch_strategy === "stop_search" && item.intervene && !item.consumed_at);
  if (!decision || decision.scope !== "step_boundary" || !decision.triggers.includes("three_attempts_without_new_version")
    || !detectStepBoundaryTriggers(run).includes("three_attempts_without_new_version")) return undefined;
  const timestamp = now();
  const message = boundedErrorMessage(run.terminal_reason);
  return pendingFinalizationFor(run, "completed", "supervisor_stopped_search", decision.id, message, timestamp);
};

const fallbackEvaluationFrame = (input: {
  run: RunSnapshot;
  task: TaskManifest;
  attempt: number;
  previousFrame?: EvaluationFrameRevision;
  publicReferenceCount: number;
  sealedReferenceCount: number;
  hasHiddenTarget: boolean;
  hasPrivateInstructions: boolean;
  reason: string;
}) => {
  const createdAt = now();
  const revision = (input.previousFrame?.revision ?? 0) + 1;
  const id = `frame-${input.run.id}-${input.attempt}-${revision}`;
  if (input.previousFrame) {
    const knownDraftIds = new Set(input.run.drafts.map((draft) => draft.id));
    return evaluationFrameRevisionSchema.parse({
      ...input.previousFrame,
      id,
      run_id: input.run.id,
      attempt: input.attempt,
      revision,
      supersedes_id: input.previousFrame.id,
      provenance: "reused_previous",
      fallback_reason: input.reason,
      change_summary: "Reused the previous frozen evaluation frame because the Verifier could not produce a valid replacement.",
      axis_diff: { added: [], removed: [], changed: [] },
      reconsider_candidate_ids: input.previousFrame.reconsider_candidate_ids.filter((draftId) => knownDraftIds.has(draftId)),
      created_at: createdAt,
    });
  }

  const axes: EvaluationFrameRevision["axes"] = [];
  const coverage = new Map<string, string[]>();
  const addAxis = (axis: EvaluationFrameRevision["axes"][number]) => {
    axes.push(axis);
    for (const anchor of axis.anchor_refs) coverage.set(anchor, [...(coverage.get(anchor) ?? []), axis.id]);
  };
  const requirements = input.task.checklist?.requirements ?? [];
  if (requirements.length > 0) {
    requirements.forEach((requirement, index) => addAxis({
      id: `axis-requirement-${index + 1}`,
      label: `Requirement ${index + 1}`,
      criterion: requirement.statement.slice(0, 10_000),
      mode: "optimize",
      importance: requirement.severity,
      visibility: "public",
      anchor_refs: ["brief:user_brief", `brief:requirement:${requirement.id}`],
      required_tools: [],
      regions: [],
    }));
  } else {
    addAxis({
      id: "axis-user-brief",
      label: "User intent",
      criterion: input.task.user_brief.slice(0, 10_000),
      mode: "optimize",
      importance: "blocker",
      visibility: "public",
      anchor_refs: ["brief:user_brief"],
      required_tools: [],
      regions: [],
    });
  }

  const preservationLabels = {
    color: "color",
    detail: "detail",
    text: "text",
    composition: "composition",
    identity: "identity",
  } as const;
  for (const [field, label] of Object.entries(preservationLabels) as Array<[keyof typeof preservationLabels, string]>) {
    if (input.task.preservation_contract[field] !== "preserve") continue;
    addAxis({
      id: `axis-preserve-${field}`,
      label: `Preserve ${label}`,
      criterion: `Preserve source ${label} according to the frozen preservation contract.`,
      mode: "preserve_source",
      importance: "blocker",
      visibility: "public",
      anchor_refs: [`contract:preservation:${field}`],
      required_tools: ["measure_source_fidelity"],
      regions: [],
    });
  }
  input.task.preservation_contract.additional_invariants.forEach((invariant, index) => addAxis({
    id: `axis-preserve-invariant-${index + 1}`,
    label: `Preservation invariant ${index + 1}`,
    criterion: invariant.slice(0, 10_000),
    mode: "preserve_source",
    importance: "blocker",
    visibility: "public",
    anchor_refs: [`contract:invariant:${index + 1}`],
    required_tools: ["measure_source_fidelity"],
    regions: [],
  }));
  for (let index = 0; index < input.publicReferenceCount; index += 1) addAxis({
    id: `axis-public-reference-${index + 1}`,
    label: `Public reference ${index + 1}`,
    criterion: "Use the public reference as directional visual evidence while preserving explicit human constraints.",
    mode: "optimize",
    importance: "major",
    visibility: "public",
    anchor_refs: [`media:public_reference:${index + 1}`],
    required_tools: [],
    regions: [],
  });
  for (let index = 0; index < input.sealedReferenceCount; index += 1) addAxis({
    id: `axis-sealed-reference-${index + 1}`,
    label: `Evaluator reference ${index + 1}`,
    criterion: "Use the evaluator-only reference as directional visual evidence without exposing its contents to the Main Agent.",
    mode: "match_target",
    importance: "major",
    visibility: "sealed",
    anchor_refs: [`media:sealed_reference:${index + 1}`],
    required_tools: ["measure_target_alignment"],
    regions: [],
  });
  if (input.hasHiddenTarget) addAxis({
    id: "axis-hidden-target",
    label: "Hidden target alignment",
    criterion: "Move toward the evaluator-only hidden target while respecting explicit human preservation constraints.",
    mode: "match_target",
    importance: "blocker",
    visibility: "sealed",
    anchor_refs: ["media:hidden_target"],
    required_tools: ["measure_target_alignment"],
    regions: [],
  });
  if (input.hasPrivateInstructions) addAxis({
    id: "axis-private-instructions",
    label: "Evaluator-only instructions",
    criterion: "Satisfy the evaluator-only instructions without exposing their contents to the Main Agent.",
    mode: "optimize",
    importance: "blocker",
    visibility: "sealed",
    anchor_refs: ["private:instructions"],
    required_tools: [],
    regions: [],
  });

  const targetRole = input.hasHiddenTarget
    ? "strong_target"
    : input.publicReferenceCount + input.sealedReferenceCount > 0 ? "directional_reference" : "none";
  return evaluationFrameRevisionSchema.parse({
    id,
    run_id: input.run.id,
    attempt: input.attempt,
    revision,
    provenance: "deterministic_baseline",
    fallback_reason: input.reason,
    axes,
    target_interpretation: {
      role: targetRole,
      rationale: input.hasHiddenTarget
        ? "A hidden target is configured, so deterministic fallback treats it as a strong evaluator-only target."
        : targetRole === "directional_reference"
          ? "Reference media is configured and is treated as directional evidence."
          : "No target media is configured; the frozen brief and preservation contract define the frame.",
    },
    change_summary: "Built a deterministic baseline from the frozen brief, checklist, preservation contract, and configured reference roles.",
    axis_diff: { added: axes.map((axis) => axis.id), removed: [], changed: [] },
    coverage: [...coverage.entries()].map(([anchor_ref, axis_ids]) => ({ anchor_ref, axis_ids })),
    reconsider_candidate_ids: [],
    model: "controller-deterministic-frame-v1",
    created_at: createdAt,
  });
};

const summarizeEvaluationTrend = (evaluation: DraftEvaluation) => ({
  evaluation_id: evaluation.id,
  draft_id: evaluation.draft_id,
  semantic_gain: evaluation.semantic_gain,
  source_severe: countSeverity(evaluation.source_quality_debt, "severe"),
  source_warn: countSeverity(evaluation.source_quality_debt, "warn"),
  step_severe: countSeverity(evaluation.step_quality_debt, "severe"),
  step_warn: countSeverity(evaluation.step_quality_debt, "warn"),
  at: evaluation.created_at,
});

const resolveParentNode = (run: RunSnapshot, artifactId: string) => run.lineage_nodes.findLast((node) => node.artifact_id === artifactId);
const resolveSelectableParentId = (run: RunSnapshot, task: TaskManifest, artifactId: string) => {
  if (artifactId === task.source_artifact_id) return run.lineage_nodes.find((node) => node.kind === "seed")!.id;
  const node = run.lineage_nodes.findLast((item) => item.artifact_id === artifactId);
  if (node) return node.id;
  const draft = run.drafts.findLast((item) => item.artifact_id === artifactId);
  if (draft) return draft.id;
  throw new Error("parent_not_available");
};

const ancestryDepthForDraft = (run: RunSnapshot, draft: CandidateDraft) => (resolveParentNode(run, draft.parent_artifact_id)?.ancestry_depth ?? 0) + 1;

const diffMemory = (before: WorkingMemory, after: WorkingMemory) => Object.fromEntries(
  (Object.keys(after) as Array<keyof WorkingMemory>).map((key) => {
    const previous = new Set(before[key]);
    const next = new Set(after[key]);
    return [key, { added: [...next].filter((item) => !previous.has(item)), removed: [...previous].filter((item) => !next.has(item)) }];
  }),
);

const memoryUpdateForStep = (run: RunSnapshot, input: WorkingMemory | undefined, startedAt: string) => {
  const updatedDuringStep = run.memory_revisions.some((revision) => revision.created_at >= startedAt);
  if (!input) return { value: run.working_memory, revision: undefined, updatedDuringStep };
  const parsed = workingMemorySchema.parse(input);
  if (JSON.stringify(parsed) === JSON.stringify(run.working_memory)) {
    return { value: run.working_memory, revision: undefined, updatedDuringStep: true };
  }
  const revision = {
    id: createId("memory"),
    revision: (run.memory_revisions.at(-1)?.revision ?? 0) + 1,
    before: run.working_memory,
    after: parsed,
    diff: diffMemory(run.working_memory, parsed),
    created_at: now(),
  };
  return { value: parsed, revision, updatedDuringStep: true };
};

const systemStepSummary = (reason: string): AgentSummary => ({
  observation: `Variation Attempt runtime state: ${reason}.`,
  hypothesis: "The next autonomous Attempt can continue from persisted drafts, evaluations, official lineage, and memory.",
  intervention: "Recorded the Attempt outcome without inventing an Agent conclusion.",
});

const trigramSimilarity = (left: string, right: string) => {
  const grams = (value: string) => new Set(Array.from({ length: Math.max(0, value.length - 2) }, (_, index) => value.slice(index, index + 3)));
  const a = grams(left);
  const b = grams(right);
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter((item) => b.has(item)).length;
  return intersection / Math.max(1, a.size + b.size - intersection);
};

export const detectInStepTrajectoryTriggers = (run: RunSnapshot, step = run.active_variation_attempt) => {
  const triggers: string[] = [];
  const stepDrafts = run.drafts.filter((draft) => draft.round === step);
  const stepDraftIds = new Set(stepDrafts.map((draft) => draft.id));
  const stepEvaluations = run.evaluations.filter((evaluation) => stepDraftIds.has(evaluation.draft_id)
    && evaluation.evaluator_revision === run.config.evaluator_revision);
  const stepDecisions = run.comparative_decisions.filter((decision) => stepDraftIds.has(decision.draft_id));
  const trends = run.validator_trends.filter((trend) => stepDraftIds.has(trend.draft_id)).slice(-3);
  if (trends.length === 3 && trends[0]!.source_warn < trends[1]!.source_warn && trends[1]!.source_warn < trends[2]!.source_warn) triggers.push("source_debt_three_generation_regression");
  const previous = run.validator_trends.at(-2);
  const current = run.validator_trends.at(-1);
  if (previous && current && current.semantic_gain > previous.semantic_gain
    && (current.source_warn > previous.source_warn || current.source_severe > previous.source_severe)) triggers.push("semantic_gain_quality_debt_conflict");
  const recentDrafts = stepDrafts.slice(-3);
  if (recentDrafts.length === 3 && new Set(recentDrafts.map((draft) => draft.parent_artifact_id)).size === 1) triggers.push("same_branch_three_times");
  if (recentDrafts.length === 3
    && trigramSimilarity(recentDrafts[0]!.prompt, recentDrafts[1]!.prompt) >= 0.9
    && trigramSimilarity(recentDrafts[1]!.prompt, recentDrafts[2]!.prompt) >= 0.9) triggers.push("prompt_trigram_stagnation");
  const recentFailures = stepDecisions.slice(-3).map((decision) => decision.axis_judgments
    .filter((item) => item.verdict === "fail").map((item) => item.axis_id).sort().join(","));
  if (recentFailures.length === 3 && recentFailures[0] && new Set(recentFailures).size === 1) triggers.push("repeated_failure_labels");
  if (stepDecisions.slice(-2).length === 2 && stepDecisions.slice(-2).every((decision) => decision.preference !== "better")) {
    triggers.push("two_candidates_without_verifier_improvement");
  }
  const latestEvaluation = stepEvaluations.at(-1);
  if (latestEvaluation) {
    const latestDraft = run.drafts.find((draft) => draft.id === latestEvaluation.draft_id);
    const parent = latestDraft ? evaluationForArtifact(run, latestDraft.parent_artifact_id, latestEvaluation.evaluator_revision) : undefined;
    if (parent && countSeverity(latestEvaluation.source_quality_debt, "severe") > countSeverity(parent.source_quality_debt, "severe")) {
      triggers.push("new_severe_quality_debt");
    }
  }
  const recentParents = new Set(stepDrafts.slice(-4).map((draft) => draft.parent_artifact_id));
  const incumbentArtifact = run.lineage_nodes.find((node) => node.id === run.incumbent_node_id)?.artifact_id;
  if (stepDrafts.length >= 4 && incumbentArtifact && !recentParents.has(incumbentArtifact)) triggers.push("incumbent_parent_unused_four_attempts");
  if (stepDecisions.at(-1)?.target_progress === "regressed") triggers.push("target_progress_regressed");
  if (["fail", "unclear"].includes(stepDecisions.at(-1)?.incumbent_correctness ?? "")
    && run.lineage_nodes.some((node) => node.id === stepDecisions.at(-1)?.incumbent_node_id && node.kind === "commit")) triggers.push("incumbent_correctness_conflict");
  return [...new Set(triggers)];
};

export const detectStepBoundaryTriggers = (run: RunSnapshot) => {
  const completed = run.variation_attempts.filter((attempt) => attempt.status !== "running").sort((left, right) => left.attempt - right.attempt);
  const lastCommitIndex = completed.findLastIndex((attempt) => Boolean(attempt.committed_lineage_node_id));
  const stepsWithoutBest = lastCommitIndex < 0 ? completed.length : completed.length - lastCommitIndex - 1;
  const recentCutoffs = completed.slice(-2);
  return [...new Set([
    ...run.deferred_supervisor_triggers,
    ...(stepsWithoutBest >= 3 ? ["three_attempts_without_new_version"] : []),
    ...(recentCutoffs.length === 2 && recentCutoffs.every((step) => step.status === "runtime_cutoff")
      ? ["two_consecutive_runtime_cutoffs"] : []),
    ...(run.validator_trends.slice(-3).length === 3
      && run.validator_trends.slice(-3).every((trend, index, items) => index === 0 || trend.source_warn > items[index - 1]!.source_warn)
      ? ["long_term_source_debt_increase"] : []),
  ])];
};

export const detectTrajectoryTriggers = (run: RunSnapshot) => [...new Set([
  ...detectInStepTrajectoryTriggers(run),
  ...detectStepBoundaryTriggers(run),
])];

const supervisorDecision = (
  advice: SupervisorAdvice,
  triggers: string[],
  variationStep: number,
  scope: "in_step" | "step_boundary",
  triggerFingerprint: string,
): SupervisorDecision => ({
  id: createId("supervisor"),
  variation_step: variationStep,
  intervene: advice.intervene,
  triggers,
  diagnosis: advice.diagnosis,
  branch_strategy: advice.branch_strategy,
  ...(advice.recommended_parent_id ? { recommended_parent_id: advice.recommended_parent_id } : {}),
  quality_risks: advice.quality_risks,
  avoid: advice.avoid,
  try: advice.try,
  ...(advice.search_assessment ? { search_assessment: advice.search_assessment } : {}),
  ...(advice.review_node_ids ? { review_node_ids: advice.review_node_ids } : {}),
  scope,
  trigger_fingerprint: triggerFingerprint,
  created_at: now(),
});

const artifactIdsInEvent = (data: Record<string, unknown>) => {
  const { _snapshot: _snapshot, _snapshot_patch: _snapshotPatch, ...publicData } = data;
  return JSON.stringify(publicData).match(/sha256:[a-f0-9]{64}/g) ?? [];
};

const normalizeText = (value: string) => value.trim().replace(/\s+/g, " ");

const acceptedSupervisorConvergence = (run: RunSnapshot) => {
  const decision = run.pending_supervisor_decision;
  if (!decision || decision.branch_strategy !== "stop_search") return undefined;
  if (!decision.intervene || decision.scope !== "step_boundary"
    || !decision.triggers.includes("three_attempts_without_new_version")
    || !detectStepBoundaryTriggers(run).includes("three_attempts_without_new_version")) return undefined;
  return { decision };
};

const assertValidSupervisorAdvice = (
  run: RunSnapshot,
  advice: SupervisorAdvice,
  triggers: string[],
  scope: "in_step" | "step_boundary",
) => {
  const assessment = advice.search_assessment;
  if (advice.review_node_ids?.some((id) => !run.lineage_nodes.some((node) => node.id === id))) throw new Error("codex_supervisor_invalid_output:unknown_review_node");
  if (assessment) {
    for (const claim of assessment.trial_claims ?? []) assertTrialClaim(run, claim);
    const actualParents = new Set(run.drafts.map((draft) => draft.parent_artifact_id));
    if (assessment.tested_parent_ids.some((id) => {
      const artifact = actualParents.has(id) ? id : run.lineage_nodes.find((node) => node.id === id)?.artifact_id ?? run.drafts.find((draft) => draft.id === id)?.artifact_id;
      return !artifact || !actualParents.has(artifact);
    })) throw new Error("codex_supervisor_invalid_output:unsupported_parent_trial");
    if (assessment.conclusion_scope === "tested_alternatives" && new Set(assessment.tested_parent_ids).size < 2) throw new Error("codex_supervisor_invalid_output:branch_is_not_model_ceiling");
    if (advice.branch_strategy === "diversify" && !assessment.strategy_change.trim()) throw new Error("codex_supervisor_invalid_output:diversify_requires_testable_change");
    if (advice.branch_strategy === "stop_search" && assessment.conclusion_scope === "branch") throw new Error("codex_supervisor_invalid_output:branch_failure_requires_alternative_or_budget_rationale");
  }
  const stagnated = scope === "step_boundary" && triggers.includes("three_attempts_without_new_version")
    && detectStepBoundaryTriggers(run).includes("three_attempts_without_new_version");
  if (stagnated && (!advice.intervene || advice.branch_strategy === "continue")) {
    throw new Error("codex_supervisor_invalid_output:stagnation_requires_strategy_change");
  }
  if (stagnated && advice.branch_strategy === "restore_history" && !advice.recommended_parent_id) {
    throw new Error("codex_supervisor_invalid_output:restore_history_requires_parent");
  }
  if (advice.branch_strategy !== "stop_search") return;
  if (!advice.intervene || scope !== "step_boundary" || !triggers.includes("three_attempts_without_new_version")
    || !detectStepBoundaryTriggers(run).includes("three_attempts_without_new_version")) {
    throw new Error("codex_supervisor_invalid_output:unsafe_terminal_decision");
  }
};

const supervisorFailureCode = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/structured_output|invalid_json|invalid_output|JSON/i.test(message)) return "invalid_structured_output" as const;
  if (/timeout|timed out|event_timeout/i.test(message)) return "timeout" as const;
  if (/http_[45]\d\d|429|provider/i.test(message)) return "provider_http_error" as const;
  if (/app_server|codex_turn|codex_event|exited/i.test(message)) return "app_server_error" as const;
  return "unknown_error" as const;
};

const isRetryableSupervisorError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return ["timeout", "provider_http_error", "app_server_error"].includes(supervisorFailureCode(error))
    || message.includes("stagnation_requires_strategy_change")
    || message.includes("restore_history_requires_parent");
};

const supervisorFailure = (
  error: unknown,
  run: RunSnapshot,
  triggers: string[],
  attempts: number,
  durationMs: number,
  scope: "in_step" | "step_boundary",
  triggerFingerprint: string,
) => {
  const message = error instanceof Error ? error.message : String(error ?? "unknown_error");
  const outputPreview = typeof (error as { structuredOutputPreview?: unknown } | null)?.structuredOutputPreview === "string"
    ? (error as { structuredOutputPreview: string }).structuredOutputPreview
    : undefined;
  const reportedAttempts = typeof (error as { supervisorAttempts?: unknown } | null)?.supervisorAttempts === "number"
    ? (error as { supervisorAttempts: number }).supervisorAttempts
    : 0;
  return {
    id: createId("supervisor-failure"),
    variation_step: run.active_variation_attempt,
    code: supervisorFailureCode(error),
    triggers,
    duration_ms: durationMs,
    attempts: Math.max(attempts, reportedAttempts),
    model: run.config.main_model,
    detail: [message, outputPreview ? `output=${outputPreview}` : ""]
      .filter(Boolean)
      .join("\n")
      .replace(/sk-[a-zA-Z0-9_.-]+/g, "[REDACTED]")
      .slice(0, 2_000),
    scope,
    trigger_fingerprint: triggerFingerprint,
    created_at: now(),
  };
};
